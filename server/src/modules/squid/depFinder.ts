import dns from 'node:dns';
import net from 'node:net';
import { promisify } from 'node:util';

// ─── Dependency finder (ported semantics from squid-slack-Bot bot.py) ───────
// Discovers a site's external dependencies so an org can whitelist the right
// CDNs once. Where the Slack bot runs headless Playwright (executes JS, watches
// requests), the platform version fetches STATIC HTML only — no browser, no
// remote code execution on the server. Any JS-triggered/lazy resource is thus
// invisible here; the bot's Playwright pass remains the deep scan for the Slack
// surface. Static is the lazy-and-safe trade for a control-plane tool.

const lookupAll = promisify(dns.lookup) as (host: string, opts: { all: true; verbatim: boolean }) => Promise<dns.LookupAddress[]>;

const SCHEMES = new Set(['http:', 'https:']);
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_HOPS_TIMEOUT_MS = 15_000;
const MAX_DEPS = 2000;

// CDN list — the bot loads this from /etc/squid/cdn_domains.txt; the platform
// keeps the same fallback defaults the bot ships with.
const CDN_LIST = [
  'cloudflare.com', 'fastly.net', 'akamai.net', 'cloudfront.net',
  'gstatic.com', 'googleapis.com',
];

// Noise blocklist — ported verbatim from squid-slack-Bot/filter_config.json so
// both surfaces agree on what never becomes an auto-dependency. Root domains
// (and ALL subdomains) here are excluded from discovery results.
export const NOISE_BLOCKLIST: Record<string, string[]> = {
  social_media: [
    'facebook.com', 'fbcdn.net', 'fbsbx.com', 'facebook.net', 'instagram.com',
    'cdninstagram.com', 'twitter.com', 'x.com', 't.co', 'twimg.com', 'abs.twimg.com',
    'linkedin.com', 'licdn.com', 'youtube.com', 'youtu.be', 'googlevideo.com',
    'ytimg.com', 'yt3.ggpht.com', 'tiktok.com', 'tiktokcdn.com', 'musical.ly',
    'pinterest.com', 'pinimg.com', 'reddit.com', 'redd.it', 'redditmedia.com',
    'reddituploads.com', 'snapchat.com', 'snap.com', 'whatsapp.com', 'whatsapp.net',
    'telegram.org', 'telegra.ph', 'tumblr.com',
  ],
  analytics_and_tracking: [
    'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
    'analytics.google.com', 'hotjar.com', 'mixpanel.com', 'segment.com',
    'segment.io', 'amplitude.com', 'fullstory.com', 'logrocket.com', 'clarity.ms',
    'mouseflow.com', 'smartlook.com', 'crazyegg.com', 'newrelic.com',
    'nr-data.net', 'sentry.io',
  ],
  live_chat_and_crm: [
    'intercom.io', 'intercom.com', 'intercomcdn.com', 'intercomassets.com',
    'zendesk.com', 'zdassets.com', 'zopim.com', 'hubspot.com', 'hs-scripts.com',
    'hs-analytics.net', 'hubapi.com', 'crisp.chat', 'drift.com', 'driftt.com',
    'freshworks.com', 'freshdesk.com', 'tawk.to',
  ],
  ad_networks: [
    'adnxs.com', 'advertising.com', 'ads.yahoo.com', 'criteo.com', 'criteo.net',
    'outbrain.com', 'taboola.com', 'moatads.com', 'scorecardresearch.com',
    'quantserve.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net',
  ],
};

const NOISE_ROOTS = new Map<string, string>();
for (const [category, domains] of Object.entries(NOISE_BLOCKLIST)) {
  for (const d of domains) NOISE_ROOTS.set(d.toLowerCase().replace(/^\./, ''), category);
}

// Minimal eTLD+1 approximation — a full PSL is overkill for surfacing
// whitelist candidates. Multi-part suffixes that matter get listed; everything
// else falls back to the last two labels.
// ponytail: not the real Public Suffix List; expand if a real scan shows misses.
const MULTI_SUFFIX = new Set([
  'co.uk', 'org.uk', 'net.uk', 'ac.uk', 'gov.uk', 'co.in', 'co.jp', 'com.au',
  'net.au', 'org.au', 'co.nz', 'co.za', 'com.br', 'com.mx', 'com.tr', 'co.id',
  'com.sg', 'co.kr', 'com.hk', 'co.th', 'com.eg', 'co.il', 'com.pk', 'com.ua',
]);

export interface DepResult {
  value: string;      // whitelistable pattern, e.g. ".example.com"
  host: string;       // the exact host that was seen
  excluded: boolean;
  category: string;   // noise category, or 'cdn' / 'dependency'
  /** Same registrable root as the scanned site itself — rendered separately,
   *  default-unchecked (whitelisting the site you're scanning is rarely the goal;
   *  the site's own CDN is what this is for). Mirrors webgui `third_party`. */
  self: boolean;
}

/** Normalize a hostname to a whitelistable dot-pattern (bot classify() port). */
export function classifyDomain(host: string): string | null {
  const h = host.toLowerCase().trim().replace(/^\.+/, '');
  if (!h || h.length > 253) return null;
  if (net.isIP(h)) return h; // raw IP entries are whitelisted as themselves

  for (const cdn of CDN_LIST) {
    if (h === cdn || h.endsWith('.' + cdn)) return '.' + cdn;
  }

  const labels = h.split('.');
  if (labels.length < 2) return null;
  const two = labels.slice(-2).join('.');
  if (MULTI_SUFFIX.has(two)) {
    if (labels.length < 3) return null;
    return '.' + labels.slice(-3).join('.');
  }
  return '.' + two;
}

/** True if `host` root (or any suffix) is on the noise blocklist. */
export function isNoise(host: string): { noise: boolean; category: string } {
  let h = host.toLowerCase().replace(/^\./, '');
  while (h.length) {
    const cat = NOISE_ROOTS.get(h);
    if (cat) return { noise: true, category: cat };
    const i = h.indexOf('.');
    if (i < 0) break;
    h = h.slice(i + 1);
  }
  return { noise: false, category: '' };
}

// ─── SSRF guard ──────────────────────────────────────────────────────────────
// Resolve the hostname ourselves and reject any A/AAAA in a private/loopback/
// link-local/reserved range BEFORE fetching, and re-guard every redirect hop.
// Residual TOCTOU (DNS rebinding between the lookup and undici's connect) is
// noted; a pinned-IP connect is the hardening path if this endpoint ever faces
// untrusted networks at scale.
function isBlockedAddr(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;      // link-local incl. 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;                     // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low.startsWith('::ffff:')) return low === '::1' || isBlockedAddr(ip.slice(7));
    if (low.startsWith('fc') || low.startsWith('fd')) return true;    // ULA
    if (low.startsWith('fe8')) return true;                            // link-local
    if (low.startsWith('ff')) return true;                             // multicast
    return false;
  }
  return true; // not an IP we can classify → block
}

async function assertSafeHost(host: string): Promise<void> {
  const clean = host.replace(/^\[|\]$/g, '');
  if (net.isIP(clean)) {
    if (isBlockedAddr(clean)) throw new Error(`Blocked address: ${clean}`);
    return;
  }
  try {
    const addrs = await lookupAll(clean, { all: true, verbatim: true });
    if (!addrs.length) throw new Error(`Could not resolve: ${clean}`);
    for (const { address } of addrs) {
      if (isBlockedAddr(address)) throw new Error(`Blocked address ${address} for ${clean}`);
    }
  } catch (e) {
    if (e instanceof Error && /ENOTFOUND/.test(e.message)) throw new Error(`Could not resolve: ${clean}`);
    throw e;
  }
}

async function readBodyWithCap(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    if (out.length > MAX_BODY_BYTES) {
      await reader.cancel();
      return out.slice(0, MAX_BODY_BYTES);
    }
  }
  return out;
}

// Extract hostnames from static HTML: url(...)? we look at href/src/action srcsets
// and bare scheme-prefixed hosts. No JS execution — lazy/CDN resources loaded by
// scripts are invisible here (documented assumption; bot's Playwright pass covers
// those for the Slack surface).
const HOST_RE = /(?:https?:)?\/\/([A-Za-z0-9.-]+)(?::\d+)?(?=[\/"')\s<]|$)/g;

/** Guarded GET for one URL, following redirects with re-validation each hop. */
export async function safeFetch(url: string): Promise<{ finalUrl: string; html: string }> {
  const u = new URL(url);
  if (!SCHEMES.has(u.protocol)) throw new Error('Only http/https targets are allowed');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed');

  let current = u;
  let html = '';
  let finalUrl = '';
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeHost(current.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MAX_HOPS_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'BT-Proxy-Health-Check/1.0' } });
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) { finalUrl = current.href; break; }
      current = new URL(loc, current);
      if (!SCHEMES.has(current.protocol)) throw new Error('Redirect to a non-http(s) URL is not allowed');
      continue;
    }
    html = await readBodyWithCap(res);
    finalUrl = res.url || current.href;
    break;
  }
  return { finalUrl, html };
}

/** Extract whitelistable dependencies from static HTML (pure — unit-testable).
 *  `self` is true when a host shares the same registrable root as the base URL
 *  itself (mirrors webgui third_party=false — e.g. the scanned domain's own CDN).
 *  self-hosts are rendered separately and default-unchecked in the UI. */
export function collectDeps(html: string, baseUrl: string): { dependencies: DepResult[]; excluded: DepResult[] } {
  const baseHost = new URL(baseUrl).hostname;
  const baseRoot = classifyDomain(baseHost) ?? '.' + baseHost;
  const seen = new Map<string, DepResult>();
  const excluded = new Map<string, DepResult>();

  const collect = (host: string) => {
    const classified = classifyDomain(host);
    if (!classified) return;
    const self = classified === baseRoot || classified === baseHost;
    const noise = isNoise(host);
    if (noise.noise) {
      if (!excluded.has(classified)) excluded.set(classified, { value: classified, host, excluded: true, category: noise.category, self });
      return;
    }
    if (!seen.has(classified)) {
      seen.set(classified, {
        value: classified, host, excluded: false,
        self,
        category: CDN_LIST.some((c) => classified === '.' + c || classified.endsWith('.' + c)) ? 'cdn' : 'dependency',
      });
    }
  };

  for (const m of html.matchAll(HOST_RE)) collect(m[1]);
  collect(new URL(baseUrl).hostname);

  const dependencies = [...seen.values()].sort((a, b) => a.value.localeCompare(b.value)).slice(0, MAX_DEPS);
  const excludedList = [...excluded.values()].sort((a, b) => a.value.localeCompare(b.value));
  return { dependencies, excluded: excludedList };
}

/**
 * Scan a site's static HTML for external dependencies. Returns whitelistable
 * dot-patterns grouped by noise vs keep. The caller (service layer) writes the
 * audit row. Never executes remote JS — static fetch only.
 */
export async function scanDependencies(
  url: string,
): Promise<{ finalUrl: string; dependencies: DepResult[]; excluded: DepResult[] }> {
  const { finalUrl, html } = await safeFetch(url);
  return { finalUrl, ...collectDeps(html, finalUrl) };
}