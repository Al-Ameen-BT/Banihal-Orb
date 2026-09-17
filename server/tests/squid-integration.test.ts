import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request } from './helpers';
import { prisma } from '../src/config/database';

// ─── Squid control plane: tenant isolation + provisioning + agent protocol ───
function hmacSig(rawKey: string, method: string, url: string, ts: string, rawBody: Buffer): string {
  const sha = crypto.createHash('sha256').update(rawBody).digest('hex');
  const canonical = `${ts}\n${method}\n${url}\n${sha}`;
  return crypto.createHmac('sha256', rawKey).update(canonical).digest('hex');
}

describe('Squid org API + agent protocol', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  async function orgFixture(name: string, email: string) {
    const org = await createTestOrg(name);
    const user = await createTestUser(org.id, email, 'ORG_ADMIN');
    const cookies = await loginAs(email);
    return { org, user, cookies };
  }

  it('org admin can create a proxy; plain USER is denied the write', async () => {
    const { org, cookies } = await orgFixture('Squid Org', 'squid-admin@test.dev');

    await createTestUser(org.id, 'member@test.dev', 'USER');
    const deniedC = await request(app)
      .post('/api/squid').set('Cookie', await loginAs('member@test.dev'))
      .send({ name: 'denied' });
    expect(deniedC.status).toBe(403);

    const res = await request(app)
      .post('/api/squid').set('Cookie', cookies)
      .send({ name: 'main-office', description: 'HQ' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('main-office');

    const listed = await request(app).get('/api/squid').set('Cookie', cookies);
    expect(listed.status).toBe(200);
    expect(listed.body.proxies).toHaveLength(1);
    expect(listed.body.proxies[0]).toMatchObject({ name: 'main-office', status: 'UNPROVISIONED' });
  });

  it('isolates proxies across tenants (org B never sees org A)', async () => {
    const a = await orgFixture('Org A Squid', 'a@squid.test');
    const b = await orgFixture('Org B Squid', 'b@squid.test');

    const created = await request(app).post('/api/squid').set('Cookie', a.cookies).send({ name: 'branch-a' });
    expect(created.status).toBe(201);
    await request(app).post('/api/squid').set('Cookie', b.cookies).send({ name: 'branch-b' });

    const bList = await request(app).get('/api/squid').set('Cookie', b.cookies);
    const ids = bList.body.proxies.map((p: { name: string }) => p.name);
    expect(ids).toEqual(['branch-b']);
    expect(ids).not.toContain('branch-a');

    // Direct cross-tenant fetch → 404 (tenant scope), never the row.
    const cross = await request(app).get(`/api/squid/${created.body.id}`).set('Cookie', b.cookies);
    expect(cross.status).toBe(404);

    // Cross-tenant mutation attempt → 404 too, not a 200 on someone else's proxy.
    const attack = await request(app).post(`/api/squid/${created.body.id}/branches`).set('Cookie', b.cookies).send({ name: 'xs' });
    expect(attack.status).toBe(404);
  });

  it('branches + lists + ports render under a bumped revision and audit', async () => {
    const { cookies } = await orgFixture('Branch Org', 'br-owner@test.dev');
    const proxy = (await request(app).post('/api/squid').set('Cookie', cookies).send({ name: 'education' })).body;

    const br = await request(app).post(`/api/squid/${proxy.id}/branches`).set('Cookie', cookies)
      .send({ name: 'calicut', mode: 'EXCLUSIVE' });
    expect(br.status).toBe(201);

    const lists = await request(app).put(`/api/squid/${proxy.id}/branches/${br.body.id}/lists`).set('Cookie', cookies)
      .send({
        sources: ['10.0.0.0/24', '10.0.0.42/32'],
        whitelist: [{ value: 'classroom.example.com', subdomain: true }, { value: 'github.com', subdomain: false }],
        blacklist: [{ value: 'ads.example.com', subdomain: true }],
      });
    expect(lists.status).toBe(200);

    await request(app).put(`/api/squid/${proxy.id}/ports`).set('Cookie', cookies)
      .send({ safePorts: ['8080'], sslPorts: ['8443'] });

    const detail = await request(app).get(`/api/squid/${proxy.id}`).set('Cookie', cookies);
    expect(detail.body.revision).toBe(3); // branch, lists, ports each bumped once
    expect(detail.body.branches[0].whitelist).toContainEqual({ value: 'classroom.example.com', subdomain: true });

    const auditRows = await prisma.auditLog.findMany({ where: { action: { in: ['SQUID_BRANCH_CREATED', 'SQUID_LIST_UPDATED', 'SQUID_NETWORK_UPDATED'] } }, select: { action: true } });
    expect(auditRows.length).toBe(3);
  });

  it('expired governing service locks the proxy; new proxies self-serve', async () => {
    const { org, cookies } = await orgFixture('Locked Org', 'lock@test.dev');
    const svc = await prisma.customerService.create({
      data: { customerId: org.id, name: 'Squid License', monthlyPrice: 0, endDate: new Date(Date.now() - 1000) },
    });
    const proxy = await prisma.squidProxy.create({
      data: { customerId: org.id, name: 'managed', status: 'PENDING', customerServiceId: svc.id },
    });

    const res = await request(app).post(`/api/squid/${proxy.id}/branches`).set('Cookie', cookies).send({ name: 'nope' });
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('SQUID_LOCKED');
  });

  it('agent protocol: HMAC poll returns a signed bundle; result acks monotonic seq', async () => {
    const { org, cookies } = await orgFixture('Agent Org', 'agent@test.dev');
    const proxy = (await request(app).post('/api/squid').set('Cookie', cookies).send({ name: 'remote-site' })).body;

    const key = (await request(app).post(`/api/squid/${proxy.id}/rotate-key`).set('Cookie', cookies)).body.raw;
    expect(key.startsWith('pk_')).toBe(true);

    const ts = String(Date.now());
    const pollUrl = '/api/proxy-agent/poll';
    const sig = hmacSig(key, 'GET', pollUrl, ts, Buffer.alloc(0));
    const poll = await request(app).get(pollUrl)
      .set('X-Proxy-Id', proxy.id).set('X-Proxy-Timestamp', ts).set('Authorization', `Bearer ${sig}`);
    expect(poll.status).toBe(200);
    // revision is 0 (rotate-key does not touch config) → nothing pending yet.
    expect(poll.body.pending).toBeNull();

    // Bad signature is rejected and never touches the resource.
    const bad = await request(app).get(pollUrl)
      .set('X-Proxy-Id', proxy.id).set('X-Proxy-Timestamp', ts).set('Authorization', 'Bearer deadbeef');
    expect(bad.status).toBe(401);

    // Bump a revision, then the next poll carries a signed full-snapshot bundle.
    await request(app).post(`/api/squid/${proxy.id}/branches`).set('Cookie', cookies).send({ name: 'floors' });
    const ts2 = String(Date.now());
    const poll2 = await request(app).get(pollUrl)
      .set('X-Proxy-Id', proxy.id).set('X-Proxy-Timestamp', ts2).set('Authorization', `Bearer ${hmacSig(key, 'GET', pollUrl, ts2, Buffer.alloc(0))}`);
    expect(poll2.body.pending).not.toBeNull();
    expect(poll2.body.pending.seq).toBe(1);
    expect(poll2.body.pending.signature.length).toBeGreaterThan(40);
    expect(poll2.body.pending.files.some((f: { path: string }) => f.path.includes('webgui_generated.conf'))).toBe(true);

    // Report success → appliedSeq advances to the polling seq.
    const resultBody = { seq: 1, ok: true };
    const resultUrl = '/api/proxy-agent/result';
    const ts3 = String(Date.now());
    const resultSig = hmacSig(key, 'POST', resultUrl, ts3, Buffer.from(JSON.stringify(resultBody)));
    const result = await request(app).post(resultUrl)
      .set('X-Proxy-Id', proxy.id).set('X-Proxy-Timestamp', ts3).set('Authorization', `Bearer ${resultSig}`)
      .send(resultBody);
    expect(result.status).toBe(200);

    const after = await request(app).get(`/api/squid/${proxy.id}`).set('Cookie', cookies);
    expect(after.body.appliedSeq).toBe(1);

    // Fully-acked: no further bundle until the next edit.
    const ts4 = String(Date.now());
    const poll3 = await request(app).get(pollUrl)
      .set('X-Proxy-Id', proxy.id).set('X-Proxy-Timestamp', ts4).set('Authorization', `Bearer ${hmacSig(key, 'GET', pollUrl, ts4, Buffer.alloc(0))}`);
    expect(poll3.body.pending).toBeNull();
  });
});

describe('Squid catalog provisioning (ADMINISTRATOR)', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it('assigning a kind=SQUID_PROXY catalog service provisions a proxy + one-time key', async () => {
    const platform = await createTestOrg('Platform');
    const client = await createTestOrg('Client Co');
    await createTestUser(platform.id, 'provider@example.com', 'ADMINISTRATOR', 'administration');
    const sadmin = await loginAs('provider@example.com');

    const catalog = await request(app).post('/api/saas-admin/catalog').set('Cookie', sadmin)
      .send({ name: 'Squid Proxy', category: 'Infrastructure', basePrice: 0, kind: 'SQUID_PROXY' });
    expect(catalog.status).toBe(201);

    const assign = await request(app).post(`/api/saas-admin/customers/${client.id}/services`).set('Cookie', sadmin)
      .send({ name: 'Squid Proxy', endDate: new Date(Date.now() + 30 * 86400_000).toISOString(), catalogServiceId: catalog.body.id });
    expect(assign.status).toBe(201);
    expect(assign.body.provisioned).not.toBeNull();
    expect(assign.body.provisioned.rawKey.startsWith('pk_')).toBe(true);
    expect(assign.body.provisioned.hint.length).toBeGreaterThan(4);

    const listed = await request(app).get(`/api/saas-admin/squid`).set('Cookie', sadmin);
    expect(listed.status).toBe(200);
    expect(listed.body.proxies[0]).toMatchObject({ customerId: client.id, status: 'PENDING', name: 'proxy-squid-proxy' });
  });
});