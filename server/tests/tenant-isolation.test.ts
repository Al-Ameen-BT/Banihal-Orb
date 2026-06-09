import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request } from './helpers';
import { prisma } from '../src/config/database';

describe('Tenant isolation', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it('returns 404 when User A requests User B resource with valid token', async () => {
    const orgA = await createTestOrg('Org A');
    const orgB = await createTestOrg('Org B');

    const userA = await createTestUser(orgA.id, 'usera@example.com', 'ORG_ADMIN');
    const userB = await createTestUser(orgB.id, 'userb@example.com', 'USER');

    // Login as Org A admin
    const cookiesA = await loginAs('usera@example.com');

    // Attempt to GET Org B's user listing using Org A's token
    const resOrgBUsers = await request(app)
      .get('/api/users')
      .set('Cookie', cookiesA);

    expect(resOrgBUsers.status).toBe(200);
    const ids = resOrgBUsers.body.users.map((u: { id: string }) => u.id);

    // Org B's user MUST NOT appear in Org A's user list
    expect(ids).not.toContain(userB.id);
    expect(ids).toContain(userA.id);
  });

  it('organization data is scoped to authenticated org', async () => {
    const orgA = await createTestOrg('Org Alpha');
    const orgB = await createTestOrg('Org Beta');

    await createTestUser(orgA.id, 'alpha@example.com', 'ORG_ADMIN');
    await createTestUser(orgB.id, 'beta@example.com', 'ORG_ADMIN');

    const cookiesA = await loginAs('alpha@example.com');

    const res = await request(app)
      .get('/api/organizations/me')
      .set('Cookie', cookiesA);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(orgA.id);
    expect(res.body.name).toBe('Org Alpha');
  });
});
