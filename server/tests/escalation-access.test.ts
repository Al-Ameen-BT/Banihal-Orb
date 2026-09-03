import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { can, requirePermission, requirePermissionIfPlatform } from '../src/middleware/rbac.middleware';
import { ALL_PERMISSION_KEYS, type PermissionKey } from '../src/config/permissions';
import { SEEDED } from './seeded-roles';

// Escalated tickets must reach platform staff. "Reach" is a CHAIN, not one guard:
// the request has to pick the admin ticket store, clear the router-level ticketing
// gate, and clear the route's own guard. This walks that chain per seeded role
// using the real middleware, so a future permission edit that quietly cuts
// Employee out of escalations fails here rather than in production.

// Administration's set is computed, never stored — resolve it the way the service does.
const ROLES: Record<string, string[]> = { administration: [...ALL_PERMISSION_KEYS], ...SEEDED };

function reqAs(keys: string[]): Request {
  return {
    user: { userId: 'u1', customerId: 'c1', role: 'ADMINISTRATOR', platformRoleId: 'plr_x', permissions: new Set(keys as PermissionKey[]) },
  } as unknown as Request;
}

/** Run a guard chain the way Express would; returns 200 when it reaches the controller. */
function chain(guards: ((req: Request, res: Response, next: () => void) => void)[], req: Request): number {
  const res = { status(c: number) { (res as { code?: number }).code = c; return this; }, json() { return this; } } as unknown as Response & { code?: number };
  for (const g of guards) {
    let passed = false;
    g(req, res, () => { passed = true; });
    if (!passed) return (res as { code?: number }).code ?? 500;
  }
  return 200;
}

// The real guards, in the order ticketing.routes.ts mounts them.
const ticketingGate = requirePermissionIfPlatform('tickets.view');
const adminStore = requirePermission('ticket.store.admin');
const writeGate = requirePermission('tickets.write');

describe('escalated tickets reach platform staff', () => {
  it.each(['administration', 'employee'])('%s can see escalation alerts and claim them', (role) => {
    const req = reqAs(ROLES[role]!);

    // 1. store selection — the escalated copy lives in the admin store only
    expect(can(req, 'ticket.store.admin'), 'admin store').toBe(true);
    // 2. the escalation alert feed (notification bell)
    expect(chain([ticketingGate, adminStore], req), 'GET /admin/escalation-alerts').toBe(200);
    // 3. the escalated ticket list behind the dashboard section
    expect(chain([ticketingGate], req), 'GET /tickets?escalatedOnly').toBe(200);
    // 4. first-wins claim
    expect(chain([ticketingGate, adminStore, writeGate], req), 'POST /admin/tickets/:id/claim').toBe(200);
  });

  it('hr_admin reaches escalations too (it holds the ticketing keys)', () => {
    const req = reqAs(ROLES['hr_admin']!);
    expect(chain([ticketingGate, adminStore], req)).toBe(200);
    expect(chain([ticketingGate, adminStore, writeGate], req)).toBe(200);
  });

  it('intern sees escalations but cannot claim one', () => {
    const req = reqAs(ROLES['intern']!);
    expect(chain([ticketingGate, adminStore], req), 'alerts are readable').toBe(200);
    expect(chain([ticketingGate, adminStore, writeGate], req), 'claim is denied').toBe(403);
  });

  it('customer roles never reach the admin store, whatever their row says', () => {
    const customer = {
      user: { userId: 'u2', customerId: 'c1', role: 'ORG_ADMIN', platformRoleId: 'plr_administration', permissions: new Set(ALL_PERMISSION_KEYS) },
    } as unknown as Request;
    expect(can(customer, 'ticket.store.admin')).toBe(false);
    expect(chain([adminStore], customer)).toBe(403);
  });
});

// The regression the permission-based store selection introduced: ticketAccessScope
// used to return "no filter" for any ADMINISTRATOR, which was only safe while the
// role guaranteed the isolated admin store. Staff without ticket.store.admin now
// land in the SHARED client store, where an unfiltered scope is a cross-org leak.
vi.mock('../src/modules/ticketing/identity', () => ({
  resolveTicketActor: vi.fn(async () => ({ id: 'ticket-user-1', role: 'admin' })),
  resolveB2bIdentity: vi.fn(async () => null),
}));

describe('ticket access scope follows the store, not the role', () => {
  const staff = { userId: 'u1', role: 'ADMINISTRATOR' as const, customerId: 'c1' };

  it('is unfiltered in the isolated admin store', async () => {
    const { ticketAccessScope } = await import('../src/modules/ticketing/access');
    const { runWithTicketDb } = await import('../src/config/ticketDatabase');
    expect(await runWithTicketDb('admin', () => ticketAccessScope(staff))).toBeNull();
  });

  it('falls back to own-tickets-only in the shared client store', async () => {
    const { ticketAccessScope } = await import('../src/modules/ticketing/access');
    const { runWithTicketDb } = await import('../src/config/ticketDatabase');
    // Not null — otherwise a platform role lacking ticket.store.admin would read
    // every organization's tickets.
    expect(await runWithTicketDb('default', () => ticketAccessScope(staff))).toEqual(['ticket-user-1']);
  });
});
