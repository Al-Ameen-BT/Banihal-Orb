import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, request, createTestOrg, createTestUser, loginAs, cleanDb } from './helpers';
import { prisma } from '../src/config/database';

// PATCH /api/saas-admin/sadmins/:id — a platform role change ends the target's
// session so the new permissions apply immediately rather than after their JWT
// expires (the role id is baked into the token as `prid`).
//
// The rule that matters to users: only somebody who is actually signed in gets
// interrupted. That is not a separate check — a signed-out user simply has no
// session row to delete, and these tests pin that it stays that way.

let orgId: string;
let adminCookies: string[];
let roles: Record<string, string> = {};

const sessionsFor = (userId: string) => prisma.refreshToken.count({ where: { userId } });
const patch = (id: string, body: unknown) =>
  request(app).patch(`/api/saas-admin/sadmins/${id}`).set('Cookie', adminCookies).send(body);

beforeAll(async () => {
  await cleanDb();
  const org = await createTestOrg('Role Change Org');
  orgId = org.id;
  await createTestUser(orgId, 'roleadmin@example.com', 'ADMINISTRATOR', 'administration');
  adminCookies = await loginAs('roleadmin@example.com');

  const rows = await prisma.platformRole.findMany({ select: { id: true, key: true } });
  roles = Object.fromEntries(rows.map((r) => [r.key, r.id]));
});

afterAll(async () => { await cleanDb(); await prisma.$disconnect(); });

describe('a role change ends an ACTIVE session', () => {
  it('deletes the session and reports sessionEnded', async () => {
    const target = await createTestUser(orgId, 'active-staff@example.com', 'ADMINISTRATOR', 'employee');
    await loginAs('active-staff@example.com');
    expect(await sessionsFor(target.id), 'fixture must be signed in').toBe(1);

    const res = await patch(target.id, { platformRoleId: roles['intern'] });

    expect(res.status).toBe(200);
    expect(res.body.sessionEnded).toBe(true);
    // Gone, so authMiddleware's per-request session lookup now 401s them.
    expect(await sessionsFor(target.id)).toBe(0);
  });
});

describe('a role change does NOT interrupt someone who is signed out', () => {
  it('applies the role, touches nothing, and reports sessionEnded false', async () => {
    const target = await createTestUser(orgId, 'offline-staff@example.com', 'ADMINISTRATOR', 'employee');
    expect(await sessionsFor(target.id), 'fixture must be signed out').toBe(0);

    const res = await patch(target.id, { platformRoleId: roles['intern'] });

    expect(res.status).toBe(200);
    expect(res.body.sessionEnded).toBe(false);
    // The change still landed — it simply applies at their next sign-in.
    const row = await prisma.user.findUnique({ where: { id: target.id }, select: { platformRoleId: true } });
    expect(row!.platformRoleId).toBe(roles['intern']);
  });
});

describe('edits that are not a role change leave the session alone', () => {
  it('renaming does not sign anyone out', async () => {
    const target = await createTestUser(orgId, 'renamed-staff@example.com', 'ADMINISTRATOR', 'employee');
    await loginAs('renamed-staff@example.com');

    const res = await patch(target.id, { name: 'Renamed Person' });

    expect(res.status).toBe(200);
    expect(res.body.sessionEnded).toBe(false);
    // Nobody should be signed out for a typo fix.
    expect(await sessionsFor(target.id)).toBe(1);
  });

  it('re-assigning the SAME role is a no-op, not a sign-out', async () => {
    const target = await createTestUser(orgId, 'same-role@example.com', 'ADMINISTRATOR', 'employee');
    await loginAs('same-role@example.com');

    const res = await patch(target.id, { platformRoleId: roles['employee'] });

    expect(res.status).toBe(200);
    expect(res.body.sessionEnded).toBe(false);
    expect(await sessionsFor(target.id)).toBe(1);
  });
});

describe('self-role-change is refused', () => {
  it('rejects changing your own platform role, and keeps your session', async () => {
    const me = await prisma.user.findUnique({ where: { email: 'roleadmin@example.com' }, select: { id: true } });

    const res = await patch(me!.id, { platformRoleId: roles['intern'] });

    // Revocation would sign the caller out instantly; demoting past roles.manage
    // would then leave nobody able to undo it.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SELF_ROLE_CHANGE');
    expect(await sessionsFor(me!.id)).toBe(1);
  });
});
