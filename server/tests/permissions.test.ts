import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { can, requirePermission, requirePermissionIfPlatform } from '../src/middleware/rbac.middleware';
import { PERMISSIONS, ALL_PERMISSION_KEYS, isPermissionKey, type PermissionKey } from '../src/config/permissions';
import { SEEDED } from './seeded-roles';

// The permission truth table, pinned. DB-free on purpose: it exercises can() and
// the two middlewares against hand-built requests, so it runs in CI where the
// DB-backed suites cannot.
//
// The seeded key sets live in ./seeded-roles.ts, transcribed from db/b2b.sql and
// shared with escalation-access.test.ts. If someone edits the SQL seed without
// editing that file (or vice versa) these tests fail — which is the point: a typo
// in that jsonb array is otherwise a silent, permanent denial that nothing would
// catch until a user reported missing access.


/** A request as auth.middleware would have built it. */
function reqAs(role: 'USER' | 'ORG_ADMIN' | 'ADMINISTRATOR', keys: string[] = []): Request {
  return {
    user: {
      userId: 'u1',
      customerId: 'c1',
      role,
      platformRoleId: role === 'ADMINISTRATOR' ? 'plr_x' : null,
      permissions: new Set(keys as PermissionKey[]),
    },
  } as unknown as Request;
}

function runGuard(mw: ReturnType<typeof requirePermission>, req: Request): number {
  let status = 0;
  let nexted = false;
  const res = {
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  mw(req, res, () => { nexted = true; });
  return nexted ? 200 : status;
}

describe('permission registry', () => {
  it('has unique keys and no empty labels', () => {
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(ALL_PERMISSION_KEYS.length);
    for (const p of PERMISSIONS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.group.length).toBeGreaterThan(0);
    }
  });

  it('every key seeded in db/b2b.sql exists in the registry', () => {
    for (const [role, keys] of Object.entries(SEEDED)) {
      for (const key of keys) {
        expect(isPermissionKey(key), `${role} seeds unknown key "${key}"`).toBe(true);
      }
    }
  });
});

describe('can() — customer roles can never hold a platform permission', () => {
  // The load-bearing invariant of the whole design. A customer role is refused
  // before the permission set is consulted, so "the engine covers platform staff
  // only" is structural rather than a convention. Handing them a full permission
  // set AND a platformRoleId must still deny.
  it.each(['USER', 'ORG_ADMIN'] as const)('%s is denied every key even when handed all of them', (role) => {
    const req = reqAs(role, [...ALL_PERMISSION_KEYS]);
    (req.user as { platformRoleId: string | null }).platformRoleId = 'plr_administration';
    for (const key of ALL_PERMISSION_KEYS) {
      expect(can(req, key), `${role} must not hold ${key}`).toBe(false);
    }
  });
});

describe('can() — seeded platform roles', () => {
  it('Administration holds every key', () => {
    const req = reqAs('ADMINISTRATOR', [...ALL_PERMISSION_KEYS]);
    for (const key of ALL_PERMISSION_KEYS) expect(can(req, key)).toBe(true);
  });

  it('Intern is read-only: view yes, write no', () => {
    const req = reqAs('ADMINISTRATOR', SEEDED['intern']!);
    expect(can(req, 'tickets.view')).toBe(true);
    expect(can(req, 'tickets.write')).toBe(false);
    expect(can(req, 'credentials.view')).toBe(true);
    expect(can(req, 'credentials.reveal')).toBe(false);
    expect(can(req, 'bots.view')).toBe(true);
    expect(can(req, 'bots.manage')).toBe(false);
    expect(can(req, 'nav.control_plane')).toBe(false);
  });

  it('Employee has credentials and bots but not the control plane', () => {
    const req = reqAs('ADMINISTRATOR', SEEDED['employee']!);
    expect(can(req, 'credentials.reveal')).toBe(true);
    expect(can(req, 'bots.manage')).toBe(true);
    expect(can(req, 'tickets.write')).toBe(true);
    expect(can(req, 'nav.control_plane')).toBe(false);
    expect(can(req, 'catalog.manage')).toBe(false);
    expect(can(req, 'users.manage')).toBe(false);
  });

  it('HR Admin runs the business but not the Slack bots or credentials', () => {
    const req = reqAs('ADMINISTRATOR', SEEDED['hr_admin']!);
    expect(can(req, 'nav.control_plane')).toBe(true);
    expect(can(req, 'catalog.manage')).toBe(true);
    expect(can(req, 'users.manage')).toBe(true);
    expect(can(req, 'customer_services.manage')).toBe(true);
    expect(can(req, 'services.view')).toBe(true);
    expect(can(req, 'bots.view')).toBe(false);
    expect(can(req, 'credentials.view')).toBe(false);
  });

  it('shows revenue to Administration and HR Admin only', () => {
    // The platform dashboard's Monthly Revenue KPI. Withheld server-side in
    // saas-admin.controller.getMetrics, not merely hidden in the UI.
    expect(can(reqAs('ADMINISTRATOR', [...ALL_PERMISSION_KEYS]), 'revenue.view')).toBe(true);
    expect(can(reqAs('ADMINISTRATOR', SEEDED['hr_admin']!), 'revenue.view')).toBe(true);
    expect(can(reqAs('ADMINISTRATOR', SEEDED['employee']!), 'revenue.view')).toBe(false);
    expect(can(reqAs('ADMINISTRATOR', SEEDED['intern']!), 'revenue.view')).toBe(false);
  });

  it('gives the System Activity workspace to Administration alone', () => {
    // The cross-tenant audit trail. Split out of platform_audit.view precisely
    // so HR Admin keeps the staff directory WITHOUT the audit trail — if this
    // ever flips to true for a seeded role, that split has been undone.
    expect(can(reqAs('ADMINISTRATOR', [...ALL_PERMISSION_KEYS]), 'system_activity.view')).toBe(true);
    for (const role of ['hr_admin', 'employee', 'intern'] as const) {
      expect(can(reqAs('ADMINISTRATOR', SEEDED[role]!), 'system_activity.view'), role).toBe(false);
      // ...while the key it was split from stays exactly as it was.
      expect(can(reqAs('ADMINISTRATOR', SEEDED[role]!), 'platform_audit.view'), role)
        .toBe(SEEDED[role]!.includes('platform_audit.view'));
    }
  });

  it('keeps tickets.manage as the Administration-only edit-all / delete-project key', () => {
    // The edit-all privilege lives OUTSIDE the seeded role sets on purpose: the
    // Administrator role holds it purely via the computed administration set (all
    // keys), and Employee / HR Admin keep the owner-based edit lock. Granting it
    // to a seeded role would silently hand edit-ALL to a role the lock exists to
    // restrict — so that must only ever happen explicitly from the roles matrix.
    expect(can(reqAs('ADMINISTRATOR', [...ALL_PERMISSION_KEYS]), 'tickets.manage')).toBe(true);
    for (const role of ['hr_admin', 'employee', 'intern'] as const) {
      expect(can(reqAs('ADMINISTRATOR', SEEDED[role]!), 'tickets.manage'), role).toBe(false);
    }
  });

  it('gives organization DELETION to Administration and HR Admin only', () => {
    // Split from orgs.manage on purpose: renaming an org and destroying every
    // user, ticket and attachment it owns are different decisions. If this ever
    // flips true for Employee or Intern, that split has been undone.
    expect(can(reqAs('ADMINISTRATOR', [...ALL_PERMISSION_KEYS]), 'orgs.delete')).toBe(true);
    expect(can(reqAs('ADMINISTRATOR', SEEDED['hr_admin']!), 'orgs.delete')).toBe(true);
    expect(can(reqAs('ADMINISTRATOR', SEEDED['employee']!), 'orgs.delete')).toBe(false);
    expect(can(reqAs('ADMINISTRATOR', SEEDED['intern']!), 'orgs.delete')).toBe(false);
    // …and no customer role can ever hold it, whatever the database says.
    expect(can(reqAs('ORG_ADMIN', [...ALL_PERMISSION_KEYS]), 'orgs.delete')).toBe(false);
  });

  it('all four platform roles reach the isolated ticket store', () => {
    // Employee and Intern exist to work the internal escalation queue. Routing
    // them to the shared customer store would give them a self-only scope there
    // and hide the very tickets they are meant to work. See ticketing.routes.ts.
    for (const keys of [ALL_PERMISSION_KEYS, SEEDED['hr_admin']!, SEEDED['employee']!, SEEDED['intern']!]) {
      expect(can(reqAs('ADMINISTRATOR', keys as string[]), 'ticket.store.admin')).toBe(true);
    }
  });
});

describe('guards', () => {
  it('requirePermission allows a holder and denies everyone else', () => {
    expect(runGuard(requirePermission('catalog.manage'), reqAs('ADMINISTRATOR', ['catalog.manage']))).toBe(200);
    expect(runGuard(requirePermission('catalog.manage'), reqAs('ADMINISTRATOR', SEEDED['intern']!))).toBe(403);
    // Platform-only: a customer role never passes, even an org admin.
    expect(runGuard(requirePermission('catalog.manage'), reqAs('ORG_ADMIN'))).toBe(403);
  });

  it('requirePermissionIfPlatform leaves customer roles alone but gates staff', () => {
    // The customer half of a shared route: untouched, because its own
    // requireRole guard already decided.
    expect(runGuard(requirePermissionIfPlatform('tickets.write'), reqAs('ORG_ADMIN'))).toBe(200);
    expect(runGuard(requirePermissionIfPlatform('tickets.write'), reqAs('USER'))).toBe(200);
    // The staff half: gated.
    expect(runGuard(requirePermissionIfPlatform('tickets.write'), reqAs('ADMINISTRATOR', SEEDED['employee']!))).toBe(200);
    expect(runGuard(requirePermissionIfPlatform('tickets.write'), reqAs('ADMINISTRATOR', SEEDED['intern']!))).toBe(403);
  });
});
