import { describe, it, expect } from 'vitest';
import saasAdminRoutes from '../src/modules/saas-admin/saas-admin.routes';
import ticketingRoutes from '../src/modules/ticketing/ticketing.routes';
import slackBotsRoutes from '../src/modules/slack-bots/slackBots.routes';
import { isPermissionKey } from '../src/config/permissions';

// Route-level ENFORCEMENT, as opposed to permissions.test.ts which pins the
// permission truth table. The distinction matters: the truth table can be
// perfect while a route carries no guard at all, which is exactly how
// /api/saas-admin ended up reachable by every platform role including Intern.
//
// requirePermission / requirePermissionIfPlatform tag themselves with the key
// they enforce (rbac.middleware), so the mounted stack can be walked directly —
// no server, no database, no HTTP.

interface Layer {
  route?: { path: string; stack: { handle: { permissionKey?: string } }[]; methods: Record<string, boolean> };
}

function routes(router: unknown): { method: string; path: string; keys: string[] }[] {
  const stack = (router as { stack: Layer[] }).stack;
  return stack.flatMap((layer) => {
    if (!layer.route) return [];
    const keys = layer.route.stack.map((h) => h.handle.permissionKey).filter((k): k is string => !!k);
    return Object.keys(layer.route.methods).map((method) => ({ method: method.toUpperCase(), path: layer.route!.path, keys }));
  });
}

// The one deliberate exception, and why. Anything else appearing here should be
// challenged rather than appended to.
const UNGATED_BY_DESIGN = new Set(['GET /metrics']);

describe('saas-admin route enforcement', () => {
  const all = routes(saasAdminRoutes);

  it('mounts a non-trivial number of routes (guards against an empty walk)', () => {
    expect(all.length).toBeGreaterThan(40);
  });

  it('gates every route with a permission key', () => {
    const ungated = all
      .filter((r) => r.keys.length === 0)
      .map((r) => `${r.method} ${r.path}`)
      .filter((r) => !UNGATED_BY_DESIGN.has(r));
    expect(ungated).toEqual([]);
  });

  it('only ever names keys that exist in the registry', () => {
    for (const r of all) for (const k of r.keys) expect(isPermissionKey(k)).toBe(true);
  });

  it('keeps revenue off the ungated metrics route', () => {
    // /metrics is open on purpose; its sensitive field is withheld field-level.
    // If someone ever gates the route with revenue.view, Employee and Intern
    // silently lose their dashboard — so pin the intent.
    expect(all.find((r) => r.path === '/metrics')?.keys).toEqual([]);
  });

  it('requires staff.invite to mint staff and roles.manage to edit the matrix', () => {
    expect(all.find((r) => r.method === 'POST' && r.path === '/staff')?.keys).toContain('staff.invite');
    for (const m of ['POST', 'PATCH', 'DELETE']) {
      const r = all.find((x) => x.method === m && x.path.startsWith('/roles'));
      expect(r?.keys, `${m} /roles`).toContain('roles.manage');
    }
  });
});

describe('ticketing route enforcement', () => {
  const all = routes(ticketingRoutes);

  it('puts tickets.write on every management mutation', () => {
    const mutations = all.filter((r) => ['POST', 'PATCH', 'DELETE'].includes(r.method) && /^\/(projects|slas)/.test(r.path));
    expect(mutations.length).toBeGreaterThan(0);
    for (const r of mutations) expect(r.keys, `${r.method} ${r.path}`).toContain('tickets.write');
  });

  it('keeps read-only ops surfaces on tickets.view, so an Intern can still see them', () => {
    for (const path of ['/dashboard', '/stats', '/analytics', '/reports', '/alerts']) {
      const r = all.find((x) => x.method === 'GET' && x.path === path);
      expect(r?.keys, `GET ${path}`).toContain('tickets.view');
      expect(r?.keys, `GET ${path}`).not.toContain('tickets.write');
    }
  });

  it('gates the admin ticket store on ticket.store.admin', () => {
    expect(all.find((r) => r.path === '/customers')?.keys).toContain('ticket.store.admin');
  });
});

describe('slack-bot route enforcement', () => {
  const all = routes(slackBotsRoutes);

  it('splits view from manage', () => {
    for (const r of all) {
      expect(r.keys, `${r.method} ${r.path}`).toContain(r.method === 'GET' ? 'bots.view' : 'bots.manage');
    }
  });
});
