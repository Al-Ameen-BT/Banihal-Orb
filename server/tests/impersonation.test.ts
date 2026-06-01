import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request } from './helpers';
import { prisma } from '../src/config/database';

describe('Impersonation audit trail', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it('writes AuditLog entry when SAAS_ADMIN impersonates a user', async () => {
    const adminOrg = await createTestOrg('SaaS Admin Org');
    const targetOrg = await createTestOrg('Target Org');

    const saasAdmin = await createTestUser(adminOrg.id, 'saasadmin@example.com', 'SAAS_ADMIN');
    const targetUser = await createTestUser(targetOrg.id, 'target@example.com', 'MEMBER');

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

    await createTestUser(adminOrg.id, 'saasadmin2@example.com', 'SAAS_ADMIN');
    const targetUser = await createTestUser(targetOrg.id, 'target2@example.com', 'MEMBER');

    const cookies = await loginAs('saasadmin2@example.com');

    const res = await request(app)
      .post(`/api/saas-admin/impersonate/${targetUser.id}`)
      .set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.expiresIn).toBe('5m');
  });
});
