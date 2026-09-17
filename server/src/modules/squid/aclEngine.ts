import type { SquidBranchMode } from '@prisma/client';

// ─── Squid ACL engine — control-plane single generation, agent dumb apply ────
// Port of the BT Proxy `generate_conf()` guarantees into TypeScript, so the
// security-critical ORDERING lives in one place that is unit-tested here:
//
//   1. Most-specific source first. Branches sort by their source prefix span, so
//      a /32 host rule is emitted before the /24 that contains it. Squid stops at
//      the first http_access match — per-PC rules really win.
//   2. Blacklist before whitelist: deny is evaluated first.
//   3. Exclusive mode adds a scoped `http_access deny <n>_net` (guarded by its own
//      src ACL) emitted before broader rules, so it can never widen a department.
//   4. IP/CIDR entries never live in dstdomain .txt files (Squid would
//      reverse-resolve them) — they are emitted as `dst` ACLs, grouped by 8.
//   5. Every generated file is rendered from validated values only — no user text
//      ever reaches the file unvalidated (newline/shell injection is impossible).

export interface SiteEntry {
  value: string;
  subdomain: boolean;
}

export const BRANCH_NAME_RE = /^[A-Za-z0-9_-]{2,32}$/;
const IP_OR_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
// Simple hostname: labels of [a-zA-Z0-9-], optional leading wildcard handled via
// subdomain flag (leading dot) rather than a literal `*`.
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

function validIp(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function validCidr(v: string): boolean {
  const [ip, bits] = v.split('/');
  const b = Number(bits);
  return validIp(ip) && Number.isInteger(b) && b >= 0 && b <= 32;
}

/** Validate a branch-name for use inside ACL identifiers (injection-free). */
export function validBranchName(name: string): boolean {
  return BRANCH_NAME_RE.test(name);
}

/** A single site entry → either a canonical domain or an IP/CIDR. Throws on garbage. */
export function classifyEntry(value: string, subdomain: boolean): { domain: string; ip?: never } | { domain?: never; ip: string } {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) throw Object.assign(new Error('Empty site entry'), { status: 400, code: 'VALIDATION_ERROR' });
  if (v.includes('/')) {
    if (!IP_OR_CIDR.test(v)) throw Object.assign(new Error(`Invalid IP/CIDR entry: ${v}`), { status: 400, code: 'VALIDATION_ERROR' });
    const ipPart = v.split('/')[0];
    if (!validIp(ipPart)) throw Object.assign(new Error(`Invalid IP address: ${v}`), { status: 400, code: 'VALIDATION_ERROR' });
    return { ip: v };
  }
  if (IP_OR_CIDR.test(v)) {
    if (!validIp(v)) throw Object.assign(new Error(`Invalid IP address: ${v}`), { status: 400, code: 'VALIDATION_ERROR' });
    return { ip: v };
  }
  // Domain: canonical leading-dot form. `subdomain` on → ".example.com" matches
  // subdomains (Squid dstdomain convention); off → exact host only.
  if (!DOMAIN_RE.test(v) || v.length > 255) {
    throw Object.assign(new Error(`Invalid domain entry: ${v}`), { status: 400, code: 'VALIDATION_ERROR' });
  }
  return { domain: subdomain ? `.${v}` : v };
}

export function validateSource(src: string): string {
  const s = String(src ?? '').trim();
  if (!IP_OR_CIDR.test(s)) throw Object.assign(new Error(`Invalid source (IP or CIDR): ${s}`), { status: 400, code: 'VALIDATION_ERROR' });
  if (s.includes('/')) { if (!validCidr(s)) throw Object.assign(new Error(`Invalid CIDR: ${s}`), { status: 400, code: 'VALIDATION_ERROR' }); }
  else if (!validIp(s)) throw Object.assign(new Error(`Invalid IP: ${s}`), { status: 400, code: 'VALIDATION_ERROR' });
  return s;
}

export function validatePortSpec(p: string): string {
  const s = String(p ?? '').trim();
  if (!/^(\d{1,5})(-(\d{1,5}))?$/.test(s)) throw Object.assign(new Error(`Invalid port: ${s}`), { status: 400, code: 'VALIDATION_ERROR' });
  const lo = Number(s.split('-')[0]);
  const hi = Number(s.split('-')[1] ?? lo);
  if (lo < 1 || hi > 65535 || lo > hi) throw Object.assign(new Error(`Port out of range 1-65535: ${s}`), { status: 400, code: 'VALIDATION_ERROR' });
  return s;
}

/** Dedupe + collapse redundant entries (a.b.example.com ⊂ .example.com wildcard);
 *  an exact host (no leading dot) never swallows its subdomains. */
export function dedupeDomains(domains: string[]): string[] {
  const keep: Array<{ base: string; wild: boolean }> = [];
  for (const d of domains) {
    const wild = d.startsWith('.');
    const base = wild ? d.slice(1) : d;
    const covered = keep.some((ex) => {
      if (ex.base === base) return !(wild && !ex.wild); // exact can't cover an existing wildcard
      if (ex.wild && base.endsWith(`.${ex.base}`)) return true; // existing wildcard parent covers us
      return false;
    });
    if (covered) continue;
    for (let i = keep.length - 1; i >= 0; i--) {
      const ex = keep[i];
      if (ex.base === base || (wild && ex.base.endsWith(`.${base}`))) keep.splice(i, 1);
    }
    keep.push({ base, wild });
  }
  return keep.map((e) => (e.wild ? `.${e.base}` : e.base)).sort((a, b) => a.localeCompare(b));
}

/** Split entries into canonical domains + IP/CIDRs. */
export function splitEntries(entries: SiteEntry[]): { domains: string[]; ips: string[] } {
  const domains: string[] = [];
  const ips: string[] = [];
  for (const e of entries ?? []) {
    const c = classifyEntry(e.value, e.subdomain);
    if (c.ip) ips.push(c.ip);
    else domains.push(c.domain as string);
  }
  return { domains: dedupeDomains(domains), ips: dedupeDomains(ips) };
}

const DAYS: Record<string, string> = { Mon: 'M', Tue: 'T', Wed: 'W', Thu: 'H', Fri: 'F', Sat: 'A', Sun: 'S' };

export interface fullAccessRule {
  src: string;
  description?: string;
  until?: string;                                  // ISO — temporary access, purged on render if past
  window?: { days: string[]; from: string; to: string };
}

/** prefix-span of a source list → sort key (higher = more specific). */
export function specificity(sources: string[]): number {
  let max = 0;
  for (const s of sources) {
    const bits = s.includes('/') ? Number(s.split('/')[1]) : 32;
    if (bits > max) max = bits;
  }
  return max * 100 + (sources.length);
}

interface BranchRow {
  name: string;
  mode: SquidBranchMode;
  sources: string[];
  whitelist: SiteEntry[];
  blacklist: SiteEntry[];
}

interface ProxyRow {
  safePorts: string[];
  sslPorts: string[];
  fullAccess: fullAccessRule[];
}

export const GEN_CONF_PATH = '/etc/squid/acls/webgui_generated.conf';

export interface RenderedBundle {
  seq: number;
  files: Array<{ path: string; content: string }>;
  action: 'reload';
}

/** Render every managed rule for one proxy into files the agent writes verbatim. */
export function renderProxyConfig(proxy: ProxyRow, branches: BranchRow[], seq: number): RenderedBundle {
  const confLines: string[] = [];
  confLines.push('# Managed by the B2B platform — do not hand-edit. Regenerated on every change.');
  confLines.push(`# seq ${seq} · ${new Date().toISOString()}`);
  confLines.push('');

  // ── Extra ports ───────────────────────────────────────────────────────────
  const safe = dedupeDomains(proxy.safePorts ?? []);
  const ssl = dedupeDomains(proxy.sslPorts ?? []);
  if (safe.length) confLines.push(`acl Safe_ports port ${safe.join(' ')}`);
  if (ssl.length) confLines.push(`acl SSL_ports port ${ssl.join(' ')}`);
  if (safe.length || ssl.length) confLines.push('');

  // ── Full-access hosts (bypass branch rules) ───────────────────────────────
  const now = Date.now();
  let faCount = 0;
  for (const fa of (proxy.fullAccess ?? [])) {
    try { validateSource(fa.src); } catch { continue; }
    if (fa.until && new Date(fa.until).getTime() <= now) continue; // expired → skip
    confLines.push(`acl fullaccess_${faCount} src ${fa.src}`);
    if (fa.window?.days?.length && fa.window.from && fa.window.to) {
      const days = fa.window.days.map((d) => DAYS[d.slice(0, 3)] ?? 'M').join('');
      confLines.push(`acl fullaccess_${faCount}_time time ${days} ${fa.window.from.replace(':', '')}-${fa.window.to.replace(':', '')}`);
      confLines.push(`http_access allow fullaccess_${faCount} fullaccess_${faCount}_time`);
    } else {
      confLines.push(`http_access allow fullaccess_${faCount}`);
    }
    faCount++;
  }
  if (faCount) confLines.push('');

  // ── Per-branch rules, most-specific-source first ──────────────────────────
  const ordered = [...(branches ?? [])].sort((a, b) => specificity(b.sources) - specificity(a.sources));
  const files: Array<{ path: string; content: string }> = [];
  ordered.forEach((br, i) => {
    const n = i + 1;
    const ips = br.sources.map((s) => { try { return validateSource(s); } catch { return ''; } }).filter(Boolean);
    if (!ips.length) return;
    const wl = splitEntries(br.whitelist);
    const bl = splitEntries(br.blacklist);

    confLines.push(`acl br${n}_net src ${ips.join(' ')}`);
    // Blacklist first (deny wins), then whitelist.
    if (bl.domains.length) {
      files.push({ path: `/etc/squid/acls/${br.name}_blacklist.txt`, content: `${bl.domains.join('\n')}\n` });
      confLines.push(`acl br${n}_blacklist dstdomain "/etc/squid/acls/${br.name}_blacklist.txt"`);
      confLines.push(`http_access deny br${n}_net br${n}_blacklist`);
    }
    if (bl.ips.length) {
      for (let g = 0; g < bl.ips.length; g += 8) {
        confLines.push(`acl br${n}_bip${g / 8} dst ${bl.ips.slice(g, g + 8).join(' ')}`);
        confLines.push(`http_access deny br${n}_net br${n}_bip${g / 8}`);
      }
    }
    if (wl.domains.length) {
      files.push({ path: `/etc/squid/acls/${br.name}_whitelist.txt`, content: `${wl.domains.join('\n')}\n` });
      confLines.push(`acl br${n}_whitelist dstdomain "/etc/squid/acls/${br.name}_whitelist.txt"`);
      confLines.push(`http_access allow br${n}_net br${n}_whitelist`);
    }
    if (wl.ips.length) {
      for (let g = 0; g < wl.ips.length; g += 8) {
        confLines.push(`acl br${n}_wip${g / 8} dst ${wl.ips.slice(g, g + 8).join(' ')}`);
        confLines.push(`http_access allow br${n}_net br${n}_wip${g / 8}`);
      }
    }
    // Exclusive mode: scoped deny, emitted before any broader overlapping rule.
    if (br.mode === 'EXCLUSIVE') confLines.push(`http_access deny br${n}_net`);
    confLines.push('');
  });

  if (!confLines.length) confLines.push('# No managed rules configured.');

  return {
    seq,
    files: [...files, { path: GEN_CONF_PATH, content: `${confLines.join('\n')}` }],
    action: 'reload',
  };
}

// Re-exported so service code doesn't import prisma for the type alone.
export type { BranchRow };