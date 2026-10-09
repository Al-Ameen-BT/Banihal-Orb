import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import ticketingRoutes from '../src/modules/ticketing/ticketing.routes';
import { getTicketDbScope, adminTicketPrisma, type TicketDbScope } from '../src/config/ticketDatabase';
import { ALL_PERMISSION_KEYS, type PermissionKey } from '../src/config/permissions';
import { SEEDED } from './seeded-roles';
import { ticketTestDbReady, ticketDbSkipReason } from './helpers';

// ─── Invariant 4: which ticket store a request is routed to ──────────────────
//
// escalation-access.test.ts already covers the row filter, but it hand-passes
// runWithTicketDb('default', …) — so if the ternary in ticketing.routes.ts were
// INVERTED, that test still passes and platform staff would silently read the
// wrong store. This file invokes the real router middleware instead, so the
// ternary itself is what is under test.

interface Layer { route?: unknown; handle: (req: Request, res: Response, next: () => void) => void }

/** The scope middleware as Express holds it — pulled from the router, not retyped. */
function scopeMiddleware(): Layer['handle'] {
  const stack = (ticketingRoutes as unknown as { stack: Layer[] }).stack;
  const first = stack[0];
  // It must be FIRST: any handler mounted ahead of it would run against whatever
  // store the previous request happened to leave in the async context.
  expect(first, 'ticketing router has no middleware').toBeDefined();
  expect(first!.route, 'the store-scoping middleware must precede every route').toBeUndefined();
  return first!.handle;
}

/** A request as auth.middleware would have built it. */
const reqAs = (role: 'USER' | 'ORG_ADMIN' | 'ADMINISTRATOR', keys: string[]): Request => ({
  user: {
    userId: 'u1', customerId: 'c1', role,
    platformRoleId: role === 'ADMINISTRATOR' ? 'plr_x' : null,
    permissions: new Set(keys as PermissionKey[]),
  },
} as unknown as Request);

/** Run the real middleware and report the store it selected for the handler. */
function routedStore(req: Request): TicketDbScope | 'never-called' {
  let scope: TicketDbScope | 'never-called' = 'never-called';
  scopeMiddleware()(req, {} as Response, () => { scope = getTicketDbScope(); });
  return scope;
}

describe('Invariant 4 — ticket.store.admin routes the request to a store', () => {
  it('platform staff WITH the key reach the admin store', () => {
    expect(routedStore(reqAs('ADMINISTRATOR', [...ALL_PERMISSION_KEYS]))).toBe('admin');
    expect(routedStore(reqAs('ADMINISTRATOR', SEEDED['hr_admin']!))).toBe('admin');
  });

  it('platform staff WITHOUT the key fall back to the shared customer store', () => {
    const withoutKey = ALL_PERMISSION_KEYS.filter((k) => k !== 'ticket.store.admin');
    expect(routedStore(reqAs('ADMINISTRATOR', withoutKey))).toBe('default');
  });

  it.each(['USER', 'ORG_ADMIN'] as const)(
    '%s is pinned to the shared store even holding every permission key',
    (role) => {
      // can() refuses customer roles before it reads the set, so a corrupted
      // platform_role_id on a customer row cannot reach the platform store.
      expect(routedStore(reqAs(role, [...ALL_PERMISSION_KEYS]))).toBe('default');
    },
  );
});

// ─── Invariant 5: first-wins claim ───────────────────────────────────────────
//
// Atomicity lives in Postgres re-evaluating `WHERE assigneeId IS NULL` after the
// row lock releases, so a mock cannot prove it — this needs a real database.
// Skipped LOUDLY rather than silently passing when no *_test ticket store is
// configured (helpers.ticketTestDbReady), because a green tick here would
// otherwise claim an atomicity guarantee nothing checked.
const ready = ticketTestDbReady();
describe.skipIf(!ready)('Invariant 5 — two concurrent claims: one wins, one 409s', () => {
  it(`is atomic${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, async () => {
    const { claimTicket } = await import('../src/modules/ticketing/ticketing.service');
    const { runWithTicketDb } = await import('../src/config/ticketDatabase');
    const db = adminTicketPrisma;
    const tag = `vitest-claim-${Date.now()}`;

    const mk = (n: string) => db.users.create({
      data: { email: `${tag}-${n}@test.local`, firstName: n, lastName: 'T', password: '__test__', role: 'admin' },
      select: { id: true },
    });
    const [reporter, a, b] = await Promise.all([mk('rep'), mk('a'), mk('b')]);
    const project = await db.projects.create({
      data: { name: tag, category: 'test', leadId: reporter.id }, select: { id: true },
    });
    const ticket = await db.tickets.create({
      data: {
        ticketNumber: tag, title: 'Claim race', description: 'x',
        projectId: project.id, reporterId: reporter.id, createdBy: reporter.id,
        assigneeId: null,   // the guard the claim races on
      },
      select: { id: true },
    });

    try {
      // Both claims fired together, both inside the admin store scope.
      const results = await Promise.allSettled([
        runWithTicketDb('admin', () => claimTicket(a.id, ticket.id)),
        runWithTicketDb('admin', () => claimTicket(b.id, ticket.id)),
      ]);

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won, 'exactly one claim must succeed').toHaveLength(1);
      expect(lost, 'the loser must be rejected, not silently overwritten').toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'ALREADY_CLAIMED' });

      // The winner is the one actually recorded — no double-assign.
      const row = await db.tickets.findUnique({ where: { id: ticket.id }, select: { assigneeId: true } });
      expect([a.id, b.id]).toContain(row!.assigneeId);
    } finally {
      await db.activities.deleteMany({ where: { ticketId: ticket.id } }).catch(() => {});
      await db.tickets.delete({ where: { id: ticket.id } }).catch(() => {});
      await db.projects.delete({ where: { id: project.id } }).catch(() => {});
      await db.users.deleteMany({ where: { email: { startsWith: tag } } }).catch(() => {});
    }
  });
});
