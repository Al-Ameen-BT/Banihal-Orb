import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { cleanDb, app, request } from './helpers';
import { prisma } from '../src/config/database';

const TEST_USER = {
  name: 'Session Test',
  email: 'session@example.com',
  password: 'TestPassword1!',
  organizationName: 'Session Test Org',
  contactNumber: '+1-555-0000',
};
const CREDS = { email: TEST_USER.email, password: TEST_USER.password };

// Registration creates session A (cookies in the response) — "browser A".
async function registerBrowserA(): Promise<string[]> {
  const res = await request(app).post('/api/auth/register').send(TEST_USER);
  expect(res.status).toBe(201);
  return res.headers['set-cookie'] as string[];
}

describe('Single active session', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it('blocks a second login from another browser with 409 SESSION_ACTIVE', async () => {
    await registerBrowserA();

    // Cookie-less request = a different browser
    const res = await request(app).post('/api/auth/login').send(CREDS);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SESSION_ACTIVE');

    // The block is audit-logged
    const blocked = await prisma.auditLog.findFirst({ where: { action: 'LOGIN_BLOCKED_ACTIVE_SESSION' } });
    expect(blocked).not.toBeNull();
  });

  it('allows login from another browser after the active session logs out', async () => {
    const cookiesA = await registerBrowserA();

    await request(app).post('/api/auth/logout').set('Cookie', cookiesA);

    const res = await request(app).post('/api/auth/login').send(CREDS);
    expect(res.status).toBe(200);
  });

  it('allows same-browser re-login and replaces the previous session', async () => {
    const cookiesA = await registerBrowserA();

    const res = await request(app).post('/api/auth/login').set('Cookie', cookiesA).send(CREDS);
    expect(res.status).toBe(200);

    // Exactly one session row survives — the old one was replaced
    expect(await prisma.refreshToken.count()).toBe(1);
  });

  it('allows same-browser re-login after the access cookie expired (refresh cookie identifies the session)', async () => {
    const cookiesA = await registerBrowserA();

    // Simulate the 15-minute access-cookie expiry: only the refresh cookie remains.
    const refreshOnly = cookiesA.filter((c) => !c.startsWith('accessToken='));
    expect(refreshOnly.some((c) => c.startsWith('refreshToken='))).toBe(true);

    const res = await request(app).post('/api/auth/login').set('Cookie', refreshOnly).send(CREDS);
    expect(res.status).toBe(200);
    expect(await prisma.refreshToken.count()).toBe(1); // own session replaced, not duplicated
  });

  it('revokes outstanding access tokens immediately on logout (SESSION_REVOKED)', async () => {
    const cookiesA = await registerBrowserA();

    // Token works before logout
    const me1 = await request(app).get('/api/users/me').set('Cookie', cookiesA);
    expect(me1.status).toBe(200);

    await request(app).post('/api/auth/logout').set('Cookie', cookiesA);

    // The same (still-unexpired) access token is rejected immediately
    const me2 = await request(app).get('/api/users/me').set('Cookie', cookiesA);
    expect(me2.status).toBe(401);
    expect(me2.body.code).toBe('SESSION_REVOKED');
  });

  it('treats an idle session as released — login succeeds past the inactivity window', async () => {
    await registerBrowserA();

    // Backdate activity past SESSION_INACTIVITY_MINUTES (default 30)
    await prisma.refreshToken.updateMany({ data: { lastUsedAt: new Date(Date.now() - 31 * 60_000) } });

    const res = await request(app).post('/api/auth/login').send(CREDS);
    expect(res.status).toBe(200);

    // The stale session was cleaned up; only the new one remains
    expect(await prisma.refreshToken.count()).toBe(1);
  });
});
