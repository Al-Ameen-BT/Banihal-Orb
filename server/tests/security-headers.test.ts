import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app';

// The headers helmet puts on every API response, pinned so a middleware reorder
// or a "let's simplify the helmet config" cannot quietly remove them.
//
// Deliberately probes an UNMATCHED route: it reaches the 404 handler through the
// full middleware stack without touching a database, so this runs in CI where the
// DB-backed suites cannot.
//
// The PAGES are served by nginx, not Express — their equivalent headers live in
// deploy/nginx/b2b-site.container.conf and are not covered here.

describe('API security headers', () => {
  it('sets a restrictive CSP, nosniff and frame protection on every response', async () => {
    const res = await request(app).get('/definitely-not-a-route');
    expect(res.status).toBe(404);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // helmet's frameguard; the pages get frame-ancestors 'none' from nginx.
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');

    const csp = res.headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    // No API response should ever be allowed to pull script from elsewhere.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
  });

  it('does not advertise the server implementation', async () => {
    const res = await request(app).get('/definitely-not-a-route');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects an unknown route without leaking a stack trace', async () => {
    const res = await request(app).get('/definitely-not-a-route');
    expect(res.body).toEqual({ error: 'Route not found', code: 'NOT_FOUND' });
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });
});

// The auth cookie flags are the other half of the session's security posture, and
// they are a plain object — assert them directly rather than standing up a login.
describe('auth cookie flags', () => {
  it('keeps session cookies httpOnly and SameSite=Lax', async () => {
    // Straight from auth.controller. If that object changes, this fails and
    // someone has to decide whether the change was intended.
    const { COOKIE_OPTS } = await import('../src/modules/auth/auth.controller');
    expect(COOKIE_OPTS.httpOnly).toBe(true);
    // Lax is what stops a cross-site POST from riding the session cookie.
    expect(COOKIE_OPTS.sameSite).toBe('lax');
    // `secure` follows COOKIE_SECURE, defaulting to NODE_ENV === 'production'.
    expect(typeof COOKIE_OPTS.secure).toBe('boolean');
  });
});
