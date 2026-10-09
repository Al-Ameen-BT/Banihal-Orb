import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/database';
import { createTestOrg, createTestUser, cleanDb, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { createKey } from '../src/modules/external-api/external-keys';

// Security of the external API perimeter (Phase 2/3):
//   - missing/malformed/foreign-token requests are 401;
//   - a disabled or expired key stops working IMMEDIATELY, even with a valid JWT;
//   - scope is re-verified against the CURRENT key at every request;
//   - a key can read/write only its own org's tickets (no cross-org IDOR);
//   - an admin-store token carries no org axis but cannot touch default-store rows.

const ready = ticketTestDbReady();

async function tokenFor(key: { clientId: string; secret: string }, scope = 'tickets.write') {
  const res = await request(app).post('/api/external/token').send({
    grant_type: 'client_credentials', client_id: key.clientId, client_secret: key.secret, scope,
  });
  return res;
}

describe.skipIf(!ready)(`external API security${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, () => {
  beforeEach(async () => {
    await cleanDb();
    await prisma.externalWebhook.deleteMany();
    await prisma.externalApiKey.deleteMany();
  });
  afterAll(async () => { await cleanDb(); await prisma.$disconnect(); });

  it('rejects missing or invalid bearer tokens', async () => {
    await request(app).post('/api/external/tickets').send({}).expect(401);
    await request(app).post('/api/external/tickets').set('Authorization', 'Basic abc').send({}).expect(401);
    await request(app).post('/api/external/tickets').set('Authorization', 'Bearer not-a-jwt').send({}).expect(401);
  });

  it('a disabled or expired key is cut off immediately — the JWT alone is not enough', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const org = await createTestOrg(`Ext Sec Org ${now}`);
    const user = await createTestUser(org.id, `extsec-${now}@example.com`, 'ORG_ADMIN');
    const key = await createKey({ name: 'sec-key', scopes: ['tickets.write'], ticketStore: 'default', customerIds: [org.id] }, { userId: user.id, customerId: org.id });
    const tok = await tokenFor(key);
    expect(tok.status).toBe(200);

    // Valid token, key disabled → 403 KEY_DISABLED.
    await prisma.externalApiKey.update({ where: { id: key.id }, data: { enabled: false } });
    const disabled = await request(app).post('/api/external/tickets').set('Authorization', `Bearer ${tok.body.access_token}`).send({});
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe('KEY_DISABLED');

    // Enable again, expire it → same wall.
    const past = new Date(Date.now() - 60_000);
    await prisma.externalApiKey.update({ where: { id: key.id }, data: { enabled: true, expiresAt: past } });
    const expired = await request(app).post('/api/external/tickets').set('Authorization', `Bearer ${tok.body.access_token}`).send({});
    expect(expired.status).toBe(403);
    expect(expired.body.code).toBe('KEY_DISABLED');
  });

  it('scope is re-checked against the current key on every request', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const org = await createTestOrg(`Ext Scope Org ${now}`);
    const user = await createTestUser(org.id, `extscope-${now}@example.com`, 'ORG_ADMIN');
    const key = await createKey({ name: 'scope-key', scopes: ['tickets.write'], ticketStore: 'default', customerIds: [org.id] }, { userId: user.id, customerId: org.id });
    // The token is issued with tickets.write, then the KEY sheds the scope.
    const tok = await tokenFor(key);
    expect(tok.status).toBe(200);
    await prisma.externalApiKey.update({ where: { id: key.id }, data: { scopes: ['tickets.view'] } });

    // The token still CLAIMS tickets.write, but the key now only holds view.
    const write = await request(app).post('/api/external/tickets').set('Authorization', `Bearer ${tok.body.access_token}`)
      .send({ title: 'x', description: 'y', type: 'task', priority: 'low', projectId: 'p', assigneeId: crypto.randomUUID(), orgCustomerId: org.id });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('INSUFFICIENT_SCOPE');
  }, 20_000);

  it('a cross-org ticket is invisible to another org key (no IDOR)', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const orgA = await createTestOrg(`Ext IDOR A ${now}`);
    const orgB = await createTestOrg(`Ext IDOR B ${now}`);
    const adminA = await createTestUser(orgA.id, `idor-a-${now}@example.com`, 'ORG_ADMIN');
    const ac = (await request(app).post('/api/auth/login').send({ email: adminA.email, password: 'TestPassword1!' })).headers['set-cookie']?.[0]?.split(';')[0];

    const proj = await request(app).post('/api/ticketing/projects').set('Cookie', ac as string).send({ name: `IDOR Proj ${now}` });
    expect(proj.status).toBe(201);
    const pool = (await request(app).get('/api/ticketing/assignees').set('Cookie', ac as string).expect(200)).body.assignees as Array<{ id: string; email: string }>;
    const persona = pool.find((a) => a.email === adminA.email);

    const userA = await createTestUser(orgA.id, `idor-ka-${now}@example.com`, 'USER');
    const keyA = await createKey({ name: 'idor-a', scopes: ['tickets.write'], ticketStore: 'default', customerIds: [orgA.id] }, { userId: userA.id, customerId: orgA.id });
    const keyB = await createKey({ name: 'idor-b', scopes: ['tickets.write'], ticketStore: 'default', customerIds: [orgB.id] }, { userId: (await createTestUser(orgB.id, `idor-kb-${now}@example.com`, 'USER')).id, customerId: orgB.id });

    const create = await request(app).post('/api/external/tickets').set('Authorization', `Bearer ${(await tokenFor(keyA)).body.access_token}`).send({
      title: 'belongs to A', description: 'test', type: 'task', priority: 'high',
      projectId: proj.body.id, assigneeId: persona!.id, orgCustomerId: orgA.id,
    });
    expect(create.status).toBe(200);
    const ticketId = create.body.id as string;

    // Org B's key must not read it (404, not 403 — don't leak existence).
    const snoop = await request(app).get(`/api/external/tickets/${ticketId}`).set('Authorization', `Bearer ${(await tokenFor(keyB)).body.access_token}`);
    expect(snoop.status).toBe(404);
  }, 30_000);
});