import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const mocks = vi.hoisted(() => ({ proxy: vi.fn(), submit: vi.fn(), state: vi.fn(), pause: vi.fn() }));
vi.mock('../src/config/database', () => ({ prisma: { squidProxy: { findUnique: mocks.proxy } }, customerContext: { exit: (fn: () => unknown) => fn() } }));
vi.mock('../src/lib/audit', () => ({ audit: vi.fn() }));
vi.mock('../src/modules/squid/squidBot.service', () => ({ requestProxyChange: mocks.submit }));
vi.mock('../src/modules/squid/squidAutomation', () => ({ automationState: mocks.state, setAutomationPause: mocks.pause }));
import { squidControlRoutes } from '../src/modules/squid/squidControl.routes';

const body = { action: 'allow', ip: '192.168.1.4', domain: 'example.org', hours: 1, reason: 'Business access' };
function app(platform: boolean, role: string, permissions: string[] = []) {
  const instance = express(); instance.use(express.json());
  instance.use((req, _res, next) => { (req as any).user = { userId: 'staff', customerId: 'c1', role, permissions: new Set(permissions) }; next(); });
  instance.use(squidControlRoutes(platform));
  instance.use((err: any, _req: any, res: any, _next: any) => res.status(err.name === 'ZodError' ? 400 : 500).json({ error: err.message }));
  return instance;
}
describe('Squid control ownership and staff permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.proxy.mockResolvedValue({ id: 'p2', customerId: 'c2' });
    mocks.state.mockResolvedValue({ paused: false }); mocks.submit.mockResolvedValue({ id: 'cr1', ticketId: 't1' });
  });
  it('denies an organisation admin accessing another client pause', async () => {
    expect((await request(app(false, 'ORG_ADMIN')).post('/p2/automation').send({ paused: true, reason: 'maintenance' })).status).toBe(404);
    expect(mocks.pause).not.toHaveBeenCalled();
  });
  it('denies a platform employee without proxy permission', async () => {
    expect((await request(app(true, 'ADMINISTRATOR')).post('/p2/change-requests').send(body)).status).toBe(403);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('requires ticket-write permission as well as proxy management', async () => {
    expect((await request(app(true, 'ADMINISTRATOR', ['squid.manage'])).post('/p2/change-requests').send(body)).status).toBe(403);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('resolves staff target client from the proxy, never from supplied identity', async () => {
    expect((await request(app(true, 'ADMINISTRATOR', ['squid.manage', 'tickets.write'])).post('/p2/change-requests').send(body)).status).toBe(201);
    expect(mocks.submit).toHaveBeenCalledWith('p2', { id: 'staff', customerId: 'c2' }, body);
  });
  it('rejects injected client identities and malformed changes', async () => {
    expect((await request(app(true, 'ADMINISTRATOR', ['squid.manage', 'tickets.write'])).post('/p2/change-requests').send({ ...body, customerId: 'c1' })).status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('a regular proxy manager cannot pause every client', async () => {
    expect((await request(app(true, 'ADMINISTRATOR', ['squid.manage'])).post('/automation/global').send({ paused: true, reason: 'maintenance' })).status).toBe(403);
  });
  it('customer users cannot gain platform access from forged permission grants', async () => {
    expect((await request(app(true, 'ORG_ADMIN', ['squid.manage', 'tickets.write'])).post('/p2/change-requests').send(body)).status).toBe(403);
  });
});
