import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { app, request, createTestOrg, createTestUser, loginAs, cleanDb } from './helpers';
import { prisma } from '../src/config/database';

// End-to-end over the REAL middleware stack, which is the only way to catch the
// interaction that unit tests miss: /api/users runs inside withTenant, so the
// Prisma extension injects `customerId` into every scoped op on User. The new
// audit reads/writes on those paths have to survive that.
//
// /api/saas-admin carries NO tenant context, so its cross-org writes must NOT be
// silently narrowed to the caller's own organization.

const rows = (action: string, orgId?: string) =>
  prisma.auditLog.findMany({ where: { action, ...(orgId ? { customerId: orgId } : {}) } });

let orgId: string;
let orgAdminCookies: string[];

beforeEach(async () => {
  await cleanDb();
  const org = await createTestOrg('E2E Client Org');
  orgId = org.id;
  await createTestUser(orgId, 'boss@e2e.test', 'ORG_ADMIN');
  orgAdminCookies = await loginAs('boss@e2e.test');
});
afterAll(async () => { await cleanDb(); await prisma.$disconnect(); });

describe('tenant-scoped routes still audit correctly', () => {
  it('PATCH /users/:id/role logs the previous role', async () => {
    const member = await createTestUser(orgId, 'member@e2e.test', 'USER');

    const res = await request(app).patch(`/api/users/${member.id}/role`)
      .set('Cookie', orgAdminCookies).send({ role: 'ORG_ADMIN' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [log] = await rows('USER_ROLE_CHANGED');
    expect(log, 'role change must be audited').toBeDefined();
    expect(log!.metadata).toMatchObject({ previousRole: 'USER', newRole: 'ORG_ADMIN' });
    expect(log!.customerId, 'must carry the target org, not a null').toBe(orgId);
  });

  it('PATCH /users/me logs a profile change', async () => {
    const res = await request(app).patch('/api/users/me')
      .set('Cookie', orgAdminCookies).send({ name: 'Renamed Boss' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await rows('USER_PROFILE_UPDATED')).length).toBe(1);
  });

  it('PATCH /users/me/password logs it WITHOUT the password', async () => {
    const res = await request(app).patch('/api/users/me/password')
      .set('Cookie', orgAdminCookies)
      .send({ currentPassword: 'TestPassword1!', newPassword: 'BrandNewPass9!xY' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [log] = await rows('PASSWORD_CHANGED');
    expect(log).toBeDefined();
    // The whole row, serialized, must not contain either password.
    const dump = JSON.stringify(log);
    expect(dump).not.toContain('TestPassword1!');
    expect(dump).not.toContain('BrandNewPass9!xY');
  });

  it('POST /users/invite logs the account WITHOUT the temp password', async () => {
    const res = await request(app).post('/api/users/invite')
      .set('Cookie', orgAdminCookies).send({ name: 'New Hire', email: 'hire@e2e.test', role: 'USER' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [log] = await rows('USER_INVITED');
    expect(log).toBeDefined();
    const temp = (res.body as { tempPassword?: string }).tempPassword;
    if (temp) expect(JSON.stringify(log)).not.toContain(temp);
  });
});

describe('cross-tenant admin routes are not narrowed by tenant scope', () => {
  it('a platform admin deletes an org OTHER than their own', async () => {
    const platform = await createTestOrg('Provider Co');
    await createTestUser(platform.id, 'admin@example.com', 'ADMINISTRATOR', 'administration');
    const adminCookies = await loginAs('admin@example.com');
    await prisma.customer.update({ where: { id: orgId }, data: { suspended: true } });

    const res = await request(app).delete(`/api/saas-admin/orgs/${orgId}`).set('Cookie', adminCookies);

    // The acting admin belongs to a DIFFERENT org. If tenant scoping leaked into
    // this path the deletes would silently match nothing and the org would remain.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await prisma.customer.count({ where: { id: orgId } })).toBe(0);
    expect((await rows('ORG_DELETED', orgId)).length).toBe(1);
  });

  it('the audited IAM matrix write reaches the log', async () => {
    const platform = await createTestOrg('Provider Co');
    await createTestUser(platform.id, 'admin@example.com', 'ADMINISTRATOR', 'administration');
    const adminCookies = await loginAs('admin@example.com');

    const res = await request(app).post('/api/saas-admin/roles').set('Cookie', adminCookies)
      .send({ key: 'auditor', name: 'Auditor', permissions: ['tickets.view'] });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [log] = await rows('ROLE_CREATED');
    expect(log, 'creating a role IS a permission grant and must be logged').toBeDefined();
    expect(log!.metadata).toMatchObject({ key: 'auditor', permissions: ['tickets.view'] });
    await prisma.platformRole.deleteMany({ where: { key: 'auditor' } });
  });
});
