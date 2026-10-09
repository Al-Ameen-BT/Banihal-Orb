import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/config/database';
import { createTestOrg, createTestUser, cleanDb } from './helpers';

// The external ticketing API admin panel (Phase 7): a platform-staff HTTP
// surface for the machine credentials that used to be CLI-only.
//   - non-staff sessions are rejected at the mount (requireRole ADMINISTRATOR);
//   - creating a key returns the plaintext EXACTLY ONCE — the DB stores only a
//     hash and a hint, never the secret;
//   - revoking a key disables it immediately and its token stops validating;
//   - key + webhook lifecycle is audited.

describe('external admin panel', () => {
  beforeEach(async () => { await cleanDb(); await prisma.externalWebhook.deleteMany(); await prisma.externalApiKey.deleteMany(); });
  afterAll(async () => { await cleanDb(); await prisma.$disconnect(); });

  async function staff() {
    const org = await createTestOrg('Platform Staff Org');
    const user = await createTestUser(org.id, `admin-${Date.now()}@example.com`, 'ADMINISTRATOR', 'administration');
    const cookie = (await request(app).post('/api/auth/login').send({ email: user.email, password: 'TestPassword1!' })).headers['set-cookie']?.[0]?.split(';')[0];
    return cookie;
  }

  it('rejects a non-staff session and serves the registry to staff', async () => {
    const org = await createTestOrg('Customer Co');
    const admin = await createTestUser(org.id, `customer-admin-${Date.now()}@example.com`, 'ORG_ADMIN');
    const login = await request(app).post('/api/auth/login').send({ email: admin.email, password: 'TestPassword1!' });
    const cookie = login.headers['set-cookie']?.[0]?.split(';')[0];

    const denied = await request(app).get('/api/external-admin').set('Cookie', cookie as string);
    expect(denied.status).toBe(403);

    const ok = await request(app).get('/api/external-admin').set('Cookie', await staff());
    expect(ok.status).toBe(200);
    expect(ok.body.keys).toEqual([]);
    expect(Array.isArray(ok.body.customers)).toBe(true);
  });

  it('issues a key: plaintext secret exactly once, DB keeps only the hash, audit written', async () => {
    const org = await createTestOrg('Issue Co');
    const cookie = await staff();

    const created = await request(app).post('/api/external-admin').set('Cookie', cookie).send({
      name: 'weather bot', scopes: ['tickets.view', 'tickets.write'], ticketStore: 'default', customerIds: [org.id],
    });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^ext_sk_/);
    expect(created.body.secretHint).toMatch(/^ext_s…/);

    const row = await prisma.externalApiKey.findUnique({ where: { id: created.body.id } });
    expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.secretHash).not.toContain(created.body.secret);
    expect((row?.secretHash ?? '').includes(created.body.secret)).toBe(false);

    // The registry must never round-trip the plaintext back to the browser.
    const list = await request(app).get('/api/external-admin').set('Cookie', cookie);
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'EXTERNAL_KEY_CREATED', targetId: created.body.id } });
    expect(audit).toBeTruthy();
  });

  it('revoking a key kills it immediately — its client_secret stops validating', async () => {
    const org = await createTestOrg('Revoke Co');
    const cookie = await staff();
    const created = await request(app).post('/api/external-admin').set('Cookie', cookie).send({
      name: 'soon-dead', scopes: ['tickets.view'], ticketStore: 'default', customerIds: [org.id],
    });
    expect(created.status).toBe(201);

    const grant = await request(app).post('/api/external/token').send({
      grant_type: 'client_credentials', client_id: created.body.clientId, client_secret: created.body.secret, scope: 'tickets.view',
    });
    expect(grant.status).toBe(200);

    const revoked = await request(app).post(`/api/external-admin/${created.body.clientId}/revoke`).set('Cookie', cookie);
    expect(revoked.status).toBe(204);

    const row = await prisma.externalApiKey.findUnique({ where: { id: created.body.id } });
    expect(row?.enabled).toBe(false);

    const denied = await request(app).post('/api/external/token').send({
      grant_type: 'client_credentials', client_id: created.body.clientId, client_secret: created.body.secret, scope: 'tickets.view',
    });
    expect(denied.status).toBe(401);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'EXTERNAL_KEY_REVOKED', targetId: created.body.id } });
    expect(audit).toBeTruthy();
  }, 20_000);

  it('registers and removes a webhook with a once-only secret', async () => {
    const org = await createTestOrg('Hook Co');
    const cookie = await staff();
    const key = await request(app).post('/api/external-admin').set('Cookie', cookie).send({
      name: 'hook-key', scopes: ['tickets.view'], ticketStore: 'default', customerIds: [org.id],
    });
    expect(key.status).toBe(201);

    const created = await request(app).post(`/api/external-admin/${key.body.clientId}/webhooks`).set('Cookie', cookie).send({
      url: 'https://hooks.example.com/tickets', events: ['ticket.created'],
    });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^ext_whk_/);

    const listed = await request(app).get(`/api/external-admin/${key.body.clientId}/webhooks`).set('Cookie', cookie);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.secret);
    expect(listed.body.webhooks[0]).toMatchObject({ url: 'https://hooks.example.com/tickets', events: ['ticket.created'] });

    const removed = await request(app).delete(`/api/external-admin/webhooks/${created.body.id}`).set('Cookie', cookie);
    expect(removed.status).toBe(204);
    const listedAfter = await request(app).get(`/api/external-admin/${key.body.clientId}/webhooks`).set('Cookie', cookie);
    expect(listedAfter.body.webhooks).toEqual([]);
  });

  it('validates malformed webhook input (bad scope, non-http URL)', async () => {
    const cookie = await staff();
    const badScope = await request(app).post('/api/external-admin').set('Cookie', cookie).send({
      name: 'bad', scopes: ['tickets.staff_only'], ticketStore: 'default', customerIds: ['x'],
    });
    expect(badScope.status).toBe(400);

    const org = await createTestOrg('Val Co');
    const key = await request(app).post('/api/external-admin').set('Cookie', cookie).send({
      name: 'ok-key', scopes: ['tickets.view'], ticketStore: 'default', customerIds: [org.id],
    });
    const badUrl = await request(app).post(`/api/external-admin/${key.body.clientId}/webhooks`).set('Cookie', cookie).send({
      url: 'ftp://nope.example.com', events: ['ticket.created'],
    });
    expect(badUrl.status).toBe(400);
  });
});