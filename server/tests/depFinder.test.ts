import { describe, it, expect } from 'vitest';
import { classifyDomain, isNoise, collectDeps, safeFetch } from '../src/modules/squid/depFinder';

// ─── Dependency finder: pure classification + static-HTML extraction ────────
describe('classifyDomain (bot classify() port)', () => {
  it('normalizes to eTLD+1 dot-patterns', () => {
    expect(classifyDomain('www.example.com')).toBe('.example.com');
    expect(classifyDomain('a.b.example.co.uk')).toBe('.example.co.uk');
    expect(classifyDomain('sub.dev.gov.uk')).toBe('.dev.gov.uk');
    expect(classifyDomain('example.com')).toBe('.example.com');
    expect(classifyDomain('1.2.3.4')).toBe('1.2.3.4');          // raw IP stays itself
    expect(classifyDomain('localhost')).toBeNull();
    expect(classifyDomain('')).toBeNull();
  });

  it('lifts CDN subdomains onto the CDN root', () => {
    expect(classifyDomain('ax-001.cloudfront.net')).toBe('.cloudfront.net');
    expect(classifyDomain('cdn.jsdelivr.net')).toBe('.jsdelivr.net');
    expect(classifyDomain('www.gstatic.com')).toBe('.gstatic.com');
  });

  it('filters out all noise with their category (never auto-whitelisted)', () => {
    expect(isNoise('www.facebook.com')).toEqual({ noise: true, category: 'social_media' });
    expect(isNoise('analytics.google.com')).toEqual({ noise: true, category: 'analytics_and_tracking' });
    expect(isNoise('js.intercomcdn.com')).toEqual({ noise: true, category: 'live_chat_and_crm' });
    expect(isNoise('securepubads.g.doubleclick.net')).toEqual({ noise: true, category: 'analytics_and_tracking' });
    expect(isNoise('a.dmncdn.example.com').noise).toBe(false);
    expect(isNoise('example.com')).toEqual({ noise: false, category: '' });
  });

  it('collectDeps extracts hosts, dedupes to dot-patterns, flags CDNs and noise', () => {
    const html = `
      <html><head>
        <link rel="stylesheet" href="https://cdn.example.com/app.css">
        <script src="https://a.cloudflare.com/js/pixel.js"></script>
        <script src="https://unpkg.com/lib.js"></script>
      </head><body>
        <img src="//img.cdn.example.com/logo.png">
        <a href="https://www.facebook.com/sharer">share</a>
        <a href="https://www.google-analytics.com/ga.js">ga</a>
      </body></html>`;
    const { dependencies, excluded } = collectDeps(html, 'https://www.dogfood.com/home');
    const values = dependencies.map((d) => d.value);
    expect(values).toContain('.example.com');
    expect(values).toContain('.unpkg.com');
    expect(values).toContain('.cloudflare.com');
    // The site's own root is a self-dep (default-unchecked), not an external dep.
    expect(dependencies.find((d) => d.value === '.dogfood.com')?.self).toBe(true);
    expect(excluded.map((d) => d.value).sort()).toEqual(['.facebook.com', '.google-analytics.com']);
    const cf = dependencies.find((d) => d.value === '.cloudflare.com');
    expect(cf?.category).toBe('cdn');
    expect(cf?.self).toBe(false);
  });
});

// ─── SSRF guard ──────────────────────────────────────────────────────────────
describe('safeFetch SSRF hardening', () => {
  it('rejects every private/loopback/link-local/reserved target before any fetch', async () => {
    for (const url of [
      'http://127.0.0.1/x',
      'http://127.0.0.2/health',
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data',       // cloud metadata
      'http://0.0.0.0/',
      'http://224.0.0.1/',
      'http://[::1]/',
      'http://[fc00::1]/',
      'http://[fe80::1]/',
      'http://[ff02::1]/',
    ]) {
      await expect(safeFetch(url)).rejects.toThrow(/Blocked/i);
    }
  });

  it('rejects non-http schemes and credentialed URLs', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(/Only http\/https/);
    await expect(safeFetch('ftp://example.com/x')).rejects.toThrow(/Only http\/https/);
    await expect(safeFetch('https://user:pass@example.com/x')).rejects.toThrow(/credentials/);
  });
});