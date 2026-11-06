import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
vi.mock('../src/modules/squid/squid.controller', () => Object.fromEntries(['listProxies', 'getBundleKey', 'listChangeRequests', 'createChangeRequest', 'streamChangeRequests', 'rotateKey', 'verifyToken', 'linkExternalApiKey', 'unlinkExternalApiKey'].map(name => [name, (_req: unknown, res: any) => res.json({ ok: true })])));
vi.mock('../src/config/database', () => ({ prisma: {}, customerContext: { exit: (fn: () => unknown) => fn() } }));
vi.mock('../src/lib/audit', () => ({ audit: vi.fn() }));
vi.mock('../src/modules/squid/squid.service', () => ({ rotateAgentKey: vi.fn(), provisionSquidProxy: vi.fn(), disableSquidProxy: vi.fn() }));
vi.mock('../src/modules/notifications/notifications.service', () => ({ notify: vi.fn() }));
vi.mock('../src/modules/squid/squidControl.routes', () => ({ squidControlRoutes: () => express.Router() }));
import orgRoutes from '../src/modules/squid/squid.routes';
import staffRoutes from '../src/modules/squid/squid-admin.routes';

function app() {
  const instance = express();
  instance.use((req, _res, next) => { (req as any).user = { role: 'ADMINISTRATOR', permissions: new Set(['squid.view', 'squid.manage', 'tickets.write']) }; next(); });
  instance.use('/org', orgRoutes); instance.use('/staff', staffRoutes);
  return instance;
}
describe('ticket-only Squid human API', () => {
  it('removes configuration reads and operational dashboards even for privileged staff', async () => {
    for (const prefix of ['/org', '/staff']) {
      for (const suffix of ['', '/host-config', '/branches', '/telemetry', '/activity', '/report.csv', '/bandwidth', '/certificates', '/backups', '/package-status', '/status']) {
        expect((await request(app()).get(`${prefix}/p1${suffix}`)).status, `${prefix}${suffix}`).toBe(404);
      }
    }
  });
  it('removes direct policy and host-maintenance writes', async () => {
    for (const prefix of ['/org', '/staff']) {
      for (const suffix of ['branches', 'reload', 'restart', 'rescan', 'backups', 'factory-reset', 'certificates/ca', 'certificates/import', 'certificates/csr', 'dependency-scan', 'lock']) {
        expect((await request(app()).post(`${prefix}/p1/${suffix}`)).status).toBe(404);
      }
      for (const suffix of ['ports', 'full-access', 'branches/b1/lists']) {
        expect((await request(app()).put(`${prefix}/p1/${suffix}`)).status).toBe(404);
      }
      expect((await request(app()).patch(`${prefix}/p1`)).status).toBe(404);
      expect((await request(app()).delete(`${prefix}/p1/branches/b1`)).status).toBe(404);
    }
  });
  it('retains organisation ticket submission and history', async () => {
    expect((await request(app()).post('/org/p1/change-requests')).status).toBe(200);
    expect((await request(app()).get('/org/p1/change-requests')).status).toBe(200);
  });
});
