import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, cleanDb } from './helpers';
import { prisma } from '../src/config/database';
import * as saasAdmin from '../src/modules/saas-admin/saas-admin.service';
import * as usersService from '../src/modules/users/users.service';

// Deleting a user was ALWAYS recorded — the row just never reached the screen.
// getSystemActivity's default scope was a hand-written four-entry list
// (CUSTOMER_CREATED / USER_REGISTERED / LOGIN / LOGOUT), so every removal was
// filtered out unless the reader knew to select "All actions".
//
// These pin the fix at the layer that was broken: the DEFAULT query, with no
// action filter, which is what both log pages issue on load.

const defaultView = () => saasAdmin.getSystemActivity({ page: 1, limit: 50 } as never);

let orgId: string;
beforeEach(async () => {
  await cleanDb();
  const org = await createTestOrg('Audit Visibility Org');
  orgId = org.id;
});
afterAll(async () => { await cleanDb(); await prisma.$disconnect(); });

describe('user deletions are visible in the default log view', () => {
  it('surfaces an org-admin removing a member (USER_REMOVED)', async () => {
    const actor = await createTestUser(orgId, 'remover@audit.test', 'ORG_ADMIN');
    const victim = await createTestUser(orgId, 'victim@audit.test', 'USER');

    await usersService.removeUser(victim.id, actor.id);

    const { items } = await defaultView();
    const row = items.find((i) => i.action === 'USER_REMOVED');
    expect(row, 'USER_REMOVED must appear with NO action filter').toBeDefined();
    expect((row!.metadata as { targetEmail?: string }).targetEmail).toBe('victim@audit.test');
  });

  it('surfaces platform staff removing a client user (ADMIN_USER_REMOVE)', async () => {
    const admin = await createTestUser(orgId, 'admin@example.com', 'ADMINISTRATOR', 'administration');
    const victim = await createTestUser(orgId, 'client@audit.test', 'USER');

    await saasAdmin.removeUser(victim.id, admin.id);

    const { items } = await defaultView();
    expect(items.some((i) => i.action === 'ADMIN_USER_REMOVE')).toBe(true);
  });

  it('surfaces staff removing staff (ADMINISTRATOR_SADMIN_REMOVE)', async () => {
    const admin = await createTestUser(orgId, 'admin@example.com', 'ADMINISTRATOR', 'administration');
    const other = await createTestUser(orgId, 'other@example.com', 'ADMINISTRATOR', 'employee');

    await saasAdmin.removeSadmin(other.id, admin.id);

    const { items } = await defaultView();
    expect(items.some((i) => i.action === 'ADMINISTRATOR_SADMIN_REMOVE')).toBe(true);
  });

  it('still returns the session events the old default scope covered', async () => {
    // The fix widens the default view; it must not narrow it.
    const actor = await createTestUser(orgId, 'someone@audit.test', 'USER');
    await prisma.auditLog.create({
      data: { action: 'LOGIN', performedById: actor.id, customerId: orgId, metadata: {} },
    });

    const { items } = await defaultView();
    expect(items.some((i) => i.action === 'LOGIN')).toBe(true);
  });
});
