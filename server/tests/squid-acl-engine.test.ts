import { classifyEntry, splitEntries, validateSource, validatePortSpec, validBranchName, specificity, dedupeDomains, renderProxyConfig } from '../src/modules/squid/aclEngine';
import type { SquidBranchMode } from '@prisma/client';

function branch(name: string, mode: SquidBranchMode, sources: string[], opts: { wl?: Array<[string, boolean]>; bl?: Array<[string, boolean]> } = {}) {
  return {
    name,
    mode,
    sources,
    whitelist: (opts.wl ?? []).map(([value, subdomain]) => ({ value, subdomain })),
    blacklist: (opts.bl ?? []).map(([value, subdomain]) => ({ value, subdomain })),
  };
}

describe('aclEngine canyon… ordering guarantees', () => {
  it('emits most-specific source first', () => {
    const branches = [
      branch('finance', 'ADDITIVE', ['10.0.0.0/24'], { wl: [['office365.com', true]] }),
      branch('exec', 'EXCLUSIVE', ['10.0.0.42/32'], { wl: [['bank.com', false]] }),
    ];
    const r = renderProxyConfig({ safePorts: [], sslPorts: [], fullAccess: [] }, branches, 1);
    const net = r.files[r.files.length - 1].content.match(/acl br(\d)_net/g)?.map((m) => m) ?? [];
    // exec /32 (specificity 32xx) must come before finance /24 (24xx).
    expect(r.files[r.files.length - 1].content.indexOf('br1_net src 10.0.0.42/32')).toBeLessThan(
      r.files[r.files.length - 1].content.indexOf('br2_net src 10.0.0.0/24'),
    );
    expect(net).toHaveLength(2);
  });

  it('EXCLUSIVE branch denies its own scope after allow lines', () => {
    const r = renderProxyConfig({ safePorts: [], sslPorts: [], fullAccess: [] }, [branch('hr', 'EXCLUSIVE', ['10.0.0.50/32'], { wl: [['a.com', false]] })], 1);
    const conf = r.files[r.files.length - 1].content;
    expect(conf).toContain('http_access allow br1_net br1_whitelist');
    expect(conf.indexOf('http_access allow br1_net')).toBeLessThan(conf.indexOf('http_access deny br1_net'));
  });

  it('writes whitelist/blacklist as separate txt files and rejects nothing cleanly', () => {
    const r = renderProxyConfig(
      { safePorts: [], sslPorts: [], fullAccess: [] },
      [branch('eng', 'ADDITIVE', ['192.168.1.0/24'], { wl: [['github.com', false]], bl: [['facebook.com', true]] })],
      7,
    );
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain('/etc/squid/acls/eng_whitelist.txt');
    expect(paths).toContain('/etc/squid/acls/eng_blacklist.txt');
    expect(paths).toContain('/etc/squid/acls/webgui_generated.conf');
    expect((r.files.find((f) => f.path.endsWith('blacklist.txt')) as { content: string }).content).toBe('.facebook.com\n');
  });

  it('separates IP entries from domain entries (dstdomain can’t hold IPs)', () => {
    const { domains, ips } = splitEntries([
      { value: 'api.example.com', subdomain: true },
      { value: '10.0.0.1', subdomain: false },
      { value: '203.0.113.0/24', subdomain: false },
      { value: 'example.com', subdomain: false },
    ]);
    expect(domains).toEqual(['.api.example.com', 'example.com']);
    expect(ips).toEqual(['10.0.0.1', '203.0.113.0/24']);
  });

  it('includes extra ports and expired full-access is dropped', () => {
    const r = renderProxyConfig(
      { safePorts: ['8080'], sslPorts: ['8443-8450'], fullAccess: [{ src: '172.16.0.7', until: '2000-01-01T00:00:00Z' }, { src: '172.16.0.9' }] },
      [],
      2,
    );
    const conf = r.files[r.files.length - 1].content;
    expect(conf).toContain('acl Safe_ports port 8080');
    expect(conf).toContain('acl SSL_ports port 8443-8450');
    expect(conf).toContain('http_access allow fullaccess_0');
    expect(conf).not.toContain('172.16.0.7');
  });
});

describe('aclEngine validation', () => {
  it('canonicalizes subdomain flag into leading-dot form', () => {
    expect(classifyEntry('Example.COM', true).domain).toBe('.example.com');
    expect(classifyEntry('example.com', false).domain).toBe('example.com');
  });

  it('validates sources / ports / branch names', () => {
    expect(validateSource('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(() => validateSource('999.1.1.1')).toThrow();
    expect(() => validateSource('nonsense')).toThrow();
    expect(validatePortSpec('8443')).toBe('8443');
    expect(validatePortSpec('1-65535')).toBe('1-65535');
    expect(() => validatePortSpec('70000')).toThrow();
    expect(() => validatePortSpec('abc')).toThrow();
    expect(validBranchName('finance-it_2')).toBe(true);
    expect(validBranchName('a b')).toBe(false);
    expect(validBranchName('a;rm -rf /')).toBe(false);
  });

  it('dedupes redundant subdomains', () => {
    expect(dedupeDomains(['.a.b.example.com', '.example.com', 'example.com'])).toEqual(['.example.com']);
    // an exact host never swallows a subdomain rule, and a wildcard supersedes its exact form
    expect(dedupeDomains(['example.com', '.api.example.com'])).toEqual(['.api.example.com', 'example.com']);
  });

  it('specificity ranks /32 above /24 above flat sources', () => {
    expect(specificity(['10.0.0.1/32'])).toBeGreaterThan(specificity(['10.0.0.0/24']));
    expect(specificity(['10.0.0.0/24', '10.0.1.0/24'])).toBeGreaterThan(specificity(['10.0.0.0/24']));
  });

  // Injection is the whole point of validation — a newline payload must never
  // survive into a generated file. The engine rejects the branch rather than
  // rendering garbage: fail loud at the API boundary, never write a bad conf.
  it('rejects newline/blob domain payloads before they reach a file', () => {
    const branches = [branch('eng', 'ADDITIVE', ['10.0.0.0/24'], { bl: [['a.com\nhttp_access allow all', false]] })];
    expect(() => renderProxyConfig({ safePorts: [], sslPorts: [], fullAccess: [] }, branches, 1)).toThrow(/Invalid domain entry/);
  });
});