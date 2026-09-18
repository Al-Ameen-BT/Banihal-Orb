import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request } from './helpers';
import { prisma } from '../src/config/database';

// ─── Squid telemetry pipeline + org ops surface (dashboard / activity / report) ──
function hmacSig(rawKey: string, method: string, url: string, ts: string, rawBody: Buffer): string {
  const sha = crypto.createHash('sha256').update(rawBody).digest('hex');
  const canonical = `${ts}\n${method}\n${url}\n${sha}`;
  return crypto.createHmac('sha256', rawKey).update(canonical).digest('hex');
}

describe('Squid telemetry + live ops', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  async function proxyFixture() {
    const org = await createTestOrg(`Telemetry ${Date.now()}`);
    const user = await createTestUser(org.id, `tele-${Date.now()}@test.dev`, 'ORG_ADMIN');
    const cookies = await loginAs(user.email);
    const proxy = (await request(app).post('/api/squid').set('Cookie', cookies).send({ name: `telemetry_site_${Date.now()}` })).body;
    const key = (await request(app).post(`/api/squid/${proxy.id}/rotate-key`).set('Cookie', cookies)).body.raw;
    return { org, cookies, proxy, key };
  }

  async function pushTelemetry(key: string, proxyId: string, body: Record<string, unknown>) {
    const url = '/api/proxy-agent/telemetry';
    const raw = Buffer.from(JSON.stringify(body));
    const ts = String(Date.now());
    const sig = hmacSig(key, 'POST', url, ts, raw);
    return request(app).post(url)
      .set('X-Proxy-Id', proxyId).set('X-Proxy-Timestamp', ts).set('Authorization', `Bearer ${sig}`)
      .send(body);
  }

  it('agent pushes telemetry; org reads the dashboard summary + activity + CSV report', async () => {
    const { cookies, proxy, key } = await proxyFixture();
    const base = { observedAt: Date.now(), squidVersion: '6.12', uptimeSeconds: 900, cpuPercent: 12.5, memPercent: 33, diskPercent: 40 };

    await pushTelemetry(key, proxy.id, {
      ...base,
      observedAt: Date.now() - 2000,
      seq: 1,
      counters: { requests: 10, denied: 1, bytes: 2048, clients: 1 },
      sessions: ['10.1.1.5'],
      logLines: [{ ts: Math.floor(Date.now() / 1000), ip: '10.1.1.5', method: 'GET', action: 'allowed', url: 'http://site.a/page' }],
    });
    await pushTelemetry(key, proxy.id, {
      ...base,
      observedAt: Date.now(),
      seq: 2,
      counters: { requests: 110, denied: 5, bytes: 40960, clients: 2 },
      sessions: ['10.1.1.5', '10.1.1.6'],
      logLines: [
        { ts: Math.floor(Date.now() / 1000), ip: '10.1.1.6', method: 'GET', action: 'allowed', url: 'http://site.b/cdn.js' },
        { ts: Math.floor(Date.now() / 1000), ip: '10.1.1.7', method: 'POST', action: 'denied', url: 'http://blocked.example.com/x' },
      ],
    });

    // Last-hour deltas: 110−10=100, 5−1=4, 40960−2048 etc.
    const sum = await request(app).get(`/api/squid/${proxy.id}/telemetry`).set('Cookie', cookies);
    expect(sum.status).toBe(200);
    expect(sum.body.latest.squidVersion).toBe('6.12');
    expect(sum.body.hour).toEqual({ requests: 100, denied: 4, bytes: 38912, clients: 1 });
    expect(sum.body.sessions.map((s: { clientIp: string }) => s.clientIp).sort()).toEqual(['10.1.1.5', '10.1.1.6', '10.1.1.7']);
    expect(sum.body.latest.sessions).toContain('10.1.1.6');

    // Activity feed with filters.
    const act = await request(app).get(`/api/squid/${proxy.id}/activity?denied=true`).set('Cookie', cookies);
    expect(act.status).toBe(200);
    expect(act.body.activity).toHaveLength(1);
    expect(act.body.activity[0]).toMatchObject({ clientIp: '10.1.1.7', action: 'denied' });

    const search = await request(app).get(`/api/squid/${proxy.id}/activity?q=site.b`).set('Cookie', cookies);
    expect(search.body.activity).toHaveLength(1);
    expect(search.body.activity[0].url).toContain('site.b');

    const clientFilter = await request(app).get(`/api/squid/${proxy.id}/activity?clientIp=10.1.1.5`).set('Cookie', cookies);
    expect(clientFilter.body.activity).toHaveLength(1);

    // CSV report rows for the day.
    const csv = await request(app).get(`/api/squid/${proxy.id}/report.csv?days=7`).set('Cookie', cookies);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toBe('day,requests,denied,bytes,active_clients');
    expect(csv.text).toMatch(/,100,4,38912,/);
  });

  it('isolates telemetry across tenants; bad HMAC is rejected on the push route', async () => {
    const a = await proxyFixture();
    const bOrg = await createTestOrg(`Other ${Date.now()}`);
    const bUser = await createTestUser(bOrg.id, `other-${Date.now()}@test.dev`, 'ORG_ADMIN');
    const bCookies = await loginAs(bUser.email);

    await pushTelemetry(a.key, a.proxy.id, {
      seq: 1, counters: { requests: 5, denied: 0, bytes: 100, clients: 1 }, logLines: [],
    });

    const crossDash = await request(app).get(`/api/squid/${a.proxy.id}/telemetry`).set('Cookie', bCookies);
    expect(crossDash.status).toBe(404);
    const crossAct = await request(app).get(`/api/squid/${a.proxy.id}/activity`).set('Cookie', bCookies);
    expect(crossAct.status).toBe(404);
    const crossCsv = await request(app).get(`/api/squid/${a.proxy.id}/report.csv`).set('Cookie', bCookies);
    expect(crossCsv.status).toBe(404);

    const bad = await pushTelemetry('pk_badkey', a.proxy.id, { seq: 1, counters: {}, logLines: [] });
    expect(bad.status).toBe(401);
  });

  it('rejects malformed telemetry payloads (400) without losing prior state', async () => {
    const { cookies, proxy, key } = await proxyFixture();
    const res = await pushTelemetry(key, proxy.id, { seq: -5 });
    expect(res.status).toBe(400);

    const sum = await request(app).get(`/api/squid/${proxy.id}/telemetry`).set('Cookie', cookies);
    expect(sum.status).toBe(200);
    expect(sum.body.latest).toBeNull();
  });
});