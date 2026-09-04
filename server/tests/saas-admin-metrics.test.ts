import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, request, createTestOrg, createTestUser, loginAs, cleanDb } from './helpers';

// GET /api/saas-admin/metrics — the field-redaction invariants, over real HTTP.
//
// This route had never been exercised end to end. permissions.test.ts proves
// can(…, 'revenue.view') returns the right booleans and route-permissions.test.ts
// proves the route carries no permission guard, but nothing proved the CONTROLLER
// acts on either fact — the two assertions that matter to a user are "staff can
// still see the dashboard" and "the revenue figures are actually gone".
//
// Emails must be @example.com: vitest.config.ts sets ADMIN_DOMAINS=example.com and
// login refuses an ADMINISTRATOR outside a provider domain.
const METRICS = '/api/saas-admin/metrics';

// Present for EVERY platform role — the whole reason the route is ungated.
const BASE_METRICS = [
  'totalOrgs', 'totalUsers', 'totalAdmins', 'openRequests', 'criticalRequests',
  'planBreakdown', 'servicesActive', 'servicesExpiring', 'servicesExpired', 'churnRate',
] as const;

const get = async (email: string) =>
  request(app).get(METRICS).set('Cookie', await loginAs(email));

beforeAll(async () => {
  await cleanDb();
  const client = await createTestOrg('Metrics Client Org');
  await createTestUser(client.id, 'user@metrics.test', 'USER');
  await createTestUser(client.id, 'orgadmin@metrics.test', 'ORG_ADMIN');

  // Platform staff. The 4th argument picks the seeded platform role — the
  // mechanism that makes "an ADMINISTRATOR without revenue.view" expressible.
  const platform = await createTestOrg('Metrics Platform Org');
  await createTestUser(platform.id, 'admin@example.com', 'ADMINISTRATOR', 'administration');
  await createTestUser(platform.id, 'hr@example.com', 'ADMINISTRATOR', 'hr_admin');
  await createTestUser(platform.id, 'employee@example.com', 'ADMINISTRATOR', 'employee');
  await createTestUser(platform.id, 'intern@example.com', 'ADMINISTRATOR', 'intern');
});

afterAll(async () => { await cleanDb(); });

describe('Invariant 1 — client tenants cannot reach platform metrics', () => {
  // The 403 comes from the MOUNT gate (app.ts: requireRole('ADMINISTRATOR')),
  // not from a route guard — /metrics deliberately carries none. That makes this
  // one line the only thing standing between a client and the platform payload.
  it.each(['user@metrics.test', 'orgadmin@metrics.test'])('%s gets 403', async (email) => {
    const res = await get(email);
    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('totalOrgs');
  });
});

describe('Invariant 2 — staff WITH revenue.view get the financials', () => {
  it.each(['admin@example.com', 'hr@example.com'])('%s gets 200 with mrr and arr', async (email) => {
    const res = await get(email);
    expect(res.status).toBe(200);
    expect('mrr' in res.body).toBe(true);
    expect('arr' in res.body).toBe(true);
    expect(typeof res.body.mrr).toBe('number');
  });
});

describe('Invariant 3 (PINNED) — staff WITHOUT revenue.view get metrics minus revenue', () => {
  it.each(['employee@example.com', 'intern@example.com'])(
    '%s gets 200, every base metric, and NO revenue keys',
    async (email) => {
      const res = await get(email);

      expect(res.status).toBe(200);
      // The point of field-level redaction: they keep their dashboard.
      for (const key of BASE_METRICS) {
        expect(res.body, `${email} must still receive ${key}`).toHaveProperty(key);
      }

      // Absent — not null, not 0, not ''. `in` is the assertion that distinguishes
      // "omitted" from "sent empty"; toBeUndefined() would pass on `mrr: null`.
      expect('mrr' in res.body, 'mrr must be omitted entirely').toBe(false);
      // arr is the SAME figure annualised (service: mrr = arr / 12). Stripping only
      // mrr withheld nothing — this is the assertion that caught that.
      expect('arr' in res.body, 'arr leaks the same figure as mrr').toBe(false);

      // Nothing else revenue-shaped slipped through.
      expect(Object.keys(res.body).filter((k) => /mrr|arr|revenue|contract/i.test(k))).toEqual([]);
    },
  );
});
