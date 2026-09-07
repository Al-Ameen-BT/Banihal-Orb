import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request } from './helpers';
import { prisma } from '../src/config/database';

describe('Impersonation audit trail', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it('writes AuditLog entry when SAAS_ADMIN impersonates a user', async () => {
    const adminOrg = await createTestOrg('SaaS Admin Org');
    const targetOrg = await createTestOrg('Target Org');

    const saasAdmin = await createTestUser(adminOrg.id, 'saasadmin@example.com', 'ADMINISTRATOR');
    const targetUser = await createTestUser(targetOrg.id, 'target@example.com', 'USER');

    const cookies = await loginAs('saasadmin@example.com');

    const res = await request(app)
      .post(`/api/saas-admin/impersonate/${targetUser.id}`)
      .set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.impersonationToken).toBeDefined();

    const auditEntry = await prisma.auditLog.findFirst({
      where: { action: 'IMPERSONATE', performedById: saasAdmin.id, targetId: targetUser.id },
    });

    expect(auditEntry).not.toBeNull();
    expect(auditEntry?.action).toBe('IMPERSONATE');
    expect(auditEntry?.targetId).toBe(targetUser.id);
  });

  it('returns a short-lived token (5-min expiry) for impersonation', async () => {
    const adminOrg = await createTestOrg('SaaS Org 2');
    const targetOrg = await createTestOrg('Target Org 2');

    await createTestUser(adminOrg.id, 'saasadmin2@example.com', 'ADMINISTRATOR');
    const targetUser = await createTestUser(targetOrg.id, 'target2@example.com', 'USER');

    const cookies = await loginAs('saasadmin2@example.com');

    const res = await request(app)
      .post(`/api/saas-admin/impersonate/${targetUser.id}`)
      .set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.expiresIn).toBe('5m');
  });
});

// Step 2 — the grant is only useful to the admin it was issued to, and only for a
// target that may actually be impersonated.
describe('Impersonation redemption', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  /** Issue a grant as `adminEmail` for `targetId`; returns the grant + admin cookies. */
  async function grantFor(adminEmail: string, targetId: string) {
    const cookies = await loginAs(adminEmail);
    const res = await request(app).post(`/api/saas-admin/impersonate/${targetId}`).set('Cookie', cookies);
    expect(res.status).toBe(200);
    return { token: res.body.impersonationToken as string, cookies };
  }

  it('exchanges a grant for a working session as the target user', async () => {
    const adminOrg = await createTestOrg('Redeem Admin Org');
    const targetOrg = await createTestOrg('Redeem Target Org');
    await createTestUser(adminOrg.id, 'redeemadmin@example.com', 'ADMINISTRATOR');
    const target = await createTestUser(targetOrg.id, 'redeemtarget@example.com', 'USER');

    const { token, cookies } = await grantFor('redeemadmin@example.com', target.id);
    const res = await request(app).post('/api/saas-admin/impersonate').set('Cookie', cookies).send({ token });
    expect(res.status).toBe(200);

    // The returned cookies must be a real, usable session belonging to the TARGET.
    const session = (res.headers['set-cookie'] ?? []) as string[];
    expect(session.some((c) => c.startsWith('accessToken='))).toBe(true);
    const me = await request(app).get('/api/users/me').set('Cookie', session);
    expect(me.status).toBe(200);
    expect(me.body.email ?? me.body.user?.email).toBe('redeemtarget@example.com');
  });

  it('records who borrowed the session', async () => {
    const adminOrg = await createTestOrg('Redeem Audit Admin');
    const targetOrg = await createTestOrg('Redeem Audit Target');
    const admin = await createTestUser(adminOrg.id, 'auditadmin@example.com', 'ADMINISTRATOR');
    const target = await createTestUser(targetOrg.id, 'audittarget@example.com', 'USER');

    const { token, cookies } = await grantFor('auditadmin@example.com', target.id);
    await request(app).post('/api/saas-admin/impersonate').set('Cookie', cookies).send({ token });

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'IMPERSONATE_REDEEM', performedById: admin.id, targetId: target.id },
    });
    expect(entry).not.toBeNull();
  });

  it('refuses a grant issued to a DIFFERENT admin', async () => {
    // The whole reason the grant is not a bearer token: stealing it buys nothing
    // unless you also hold the issuing admin's session.
    const orgA = await createTestOrg('Grant Owner Org');
    const orgB = await createTestOrg('Other Admin Org');
    const targetOrg = await createTestOrg('Grant Target Org');
    await createTestUser(orgA.id, 'owner@example.com', 'ADMINISTRATOR');
    await createTestUser(orgB.id, 'other@example.com', 'ADMINISTRATOR');
    const target = await createTestUser(targetOrg.id, 'granttarget@example.com', 'USER');

    const { token } = await grantFor('owner@example.com', target.id);
    const otherCookies = await loginAs('other@example.com');

    const res = await request(app).post('/api/saas-admin/impersonate').set('Cookie', otherCookies).send({ token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IMPERSONATION_GRANT_INVALID');
  });

  it('refuses to impersonate platform staff', async () => {
    // Otherwise staff could borrow a peer's platform role and exceed their own.
    const adminOrg = await createTestOrg('Staff Impersonation Org');
    await createTestUser(adminOrg.id, 'staffadmin@example.com', 'ADMINISTRATOR');
    const peer = await createTestUser(adminOrg.id, 'peer@example.com', 'ADMINISTRATOR');

    const { token, cookies } = await grantFor('staffadmin@example.com', peer.id);
    const res = await request(app).post('/api/saas-admin/impersonate').set('Cookie', cookies).send({ token });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('IMPERSONATION_FORBIDDEN');
  });

  it('rejects a malformed or unsigned grant', async () => {
    const adminOrg = await createTestOrg('Bad Grant Org');
    await createTestUser(adminOrg.id, 'badgrant@example.com', 'ADMINISTRATOR');
    const cookies = await loginAs('badgrant@example.com');

    const res = await request(app).post('/api/saas-admin/impersonate').set('Cookie', cookies).send({ token: 'not.a.jwt' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IMPERSONATION_GRANT_INVALID');
  });

  it('requires orgs.manage — an ordinary user cannot redeem', async () => {
    const org = await createTestOrg('No Permission Org');
    await createTestUser(org.id, 'plainuser@example.com', 'USER');
    const cookies = await loginAs('plainuser@example.com');

    const res = await request(app).post('/api/saas-admin/impersonate').set('Cookie', cookies).send({ token: 'anything' });
    expect([401, 403]).toContain(res.status);
  });
});
