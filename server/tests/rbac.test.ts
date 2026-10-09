import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request } from './helpers';
import { prisma } from '../src/config/database';

describe('RBAC enforcement', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it('returns 403 when USER calls ORG_ADMIN endpoint', async () => {
    const org = await createTestOrg('Rbac Org');
    await createTestUser(org.id, 'member@example.com', 'USER');
    const cookies = await loginAs('member@example.com');

    const res = await request(app)
      .get('/api/users')
      .set('Cookie', cookies);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 403 when USER calls ADMINISTRATOR endpoint', async () => {
    const org = await createTestOrg('Exec Org');
    await createTestUser(org.id, 'exec@example.com', 'USER');
    const cookies = await loginAs('exec@example.com');

    const res = await request(app)
      .get('/api/saas-admin/orgs')
      .set('Cookie', cookies);

    expect(res.status).toBe(403);
  });

  it('returns 200 when ORG_ADMIN calls user list endpoint', async () => {
    const org = await createTestOrg('Admin Org');
    await createTestUser(org.id, 'admin@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('admin@example.com');

    const res = await request(app)
      .get('/api/users')
      .set('Cookie', cookies);

    expect(res.status).toBe(200);
  });

  it('prevents ADMINISTRATOR role assignment via client API', async () => {
    const org = await createTestOrg('Role Test Org');
    const admin = await createTestUser(org.id, 'orgadmin@example.com', 'ORG_ADMIN');
    const target = await createTestUser(org.id, 'target@example.com', 'USER');
    const cookies = await loginAs('orgadmin@example.com');

    const res = await request(app)
      .patch(`/api/users/${target.id}/role`)
      .set('Cookie', cookies)
      .send({ role: 'ADMINISTRATOR' });

    expect(res.status).toBe(400); // Zod rejects ADMINISTRATOR from the enum

    void admin;
  });
});
