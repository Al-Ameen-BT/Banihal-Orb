import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  proxy: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  cr: { findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  transaction: vi.fn(),
  state: vi.fn(), admit: vi.fn(), enqueue: vi.fn(), audit: vi.fn(),
}));
vi.mock('../src/config/database', () => ({ prisma: { squidProxy: mocks.proxy, squidChangeRequest: mocks.cr, $transaction: mocks.transaction } }));
vi.mock('../src/lib/audit', () => ({ audit: mocks.audit }));
vi.mock('../src/config/slackCrypto', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn(), hashApiKey: vi.fn(), maskToken: vi.fn() }));
vi.mock('../src/modules/squid/bundleSigning', () => ({ signBundle: vi.fn(), signingPublicKeyPem: vi.fn() }));
vi.mock('../src/modules/squid/depFinder', () => ({ scanDependencies: vi.fn() }));
vi.mock('../src/modules/notifications/notifications.service', () => ({ notify: vi.fn() }));
vi.mock('../src/modules/ticketing/ticketing.service', () => ({ createTicket: vi.fn(), registerOnTicketApproved: vi.fn() }));
vi.mock('../src/config/ticketDatabase', () => ({ getTicketDb: vi.fn(), runWithTicketDb: vi.fn() }));
vi.mock('../src/modules/squid/squidBotStore', () => ({ botActionOf: (action: string) => action.startsWith('BOT_'), enqueueBotCommand: mocks.enqueue }));
vi.mock('../src/modules/squid/squidAutomation', () => ({ automationState: mocks.state, assertAutomationRunning: vi.fn(), admitProxyChange: mocks.admit, withProxyLease: (_id: string, work: () => Promise<unknown>) => work() }));
import { agentPoll, agentResult, createChangeRequest, applyChangeRequest } from '../src/modules/squid/squid.service';

describe('Squid dispatch and ticket safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxy.findUnique.mockResolvedValue({ id: 'p1', customerId: 'c1', revision: 4, appliedSeq: 2, status: 'CONNECTED', locked: false, safePorts: [], sslPorts: [], fullAccess: [], branches: [] });
    mocks.cr.findMany.mockResolvedValue([]);
    mocks.state.mockResolvedValue({ paused: true });
  });
  it('paused polling returns no configuration and preserves network status', async () => {
    expect(await agentPoll('p1')).toMatchObject({ pending: null, automation: { paused: true } });
    expect(mocks.proxy.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ locked: true }) }));
  });
  it('rejects future acknowledgements before updating progress', async () => {
    await expect(agentResult('p1', null, 'c1', { seq: 5, ok: true })).rejects.toMatchObject({ code: 'SQUID_ACK_MISMATCH' });
    expect(mocks.proxy.update).not.toHaveBeenCalled();
  });
  it('only completes requests dispatched for the acknowledged revision', async () => {
    await agentResult('p1', null, 'c1', { seq: 3, ok: true });
    expect(mocks.cr.findMany).toHaveBeenCalledWith({ where: { proxyId: 'p1', status: 'DISPATCHED', targetRevision: 3, appliedSeq: null } });
    expect(mocks.proxy.updateMany).toHaveBeenCalledWith({ where: { id: 'p1', appliedSeq: { lt: 3 } }, data: { appliedSeq: 3 } });
  });
  it('maps included changes to a newer full-state revision before delivery', async () => {
    mocks.state.mockResolvedValue({ paused: false });
    await agentPoll('p1');
    expect(mocks.cr.updateMany).toHaveBeenCalledWith({ where: { proxyId: 'p1', status: 'DISPATCHED', targetRevision: { not: null, lte: 4 } }, data: { targetRevision: 4 } });
  });
  it('stores desired-state mutation, revision and dispatch in one transaction', async () => {
    mocks.cr.findUnique.mockResolvedValue({ id: 'cr1', proxyId: 'p1', customerId: 'c1', action: 'SET_PORTS', status: 'APPROVED', details: { safePorts: ['80'], sslPorts: ['443'] } });
    mocks.cr.count.mockResolvedValue(0);
    const tx = { squidProxy: { update: vi.fn(), findUniqueOrThrow: vi.fn().mockResolvedValue({ revision: 5 }) }, squidChangeRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn() } };
    mocks.transaction.mockImplementation(async work => work(tx));
    await applyChangeRequest('cr1', 'u1');
    expect(tx.squidProxy.update).toHaveBeenCalledTimes(2);
    expect(tx.squidChangeRequest.update).toHaveBeenCalledWith({ where: { id: 'cr1' }, data: { status: 'DISPATCHED', targetRevision: 5 } });
    expect(mocks.proxy.update).not.toHaveBeenCalled();
  });
  it('reuses a ticket receipt when JSONB object ordering differs on retry', async () => {
    const existing = { id: 'cr1', proxyId: 'p1', customerId: 'c1', action: 'BOT_ALLOW', ticketId: 't1', details: { ip: '192.168.1.2', domain: 'example.org' } };
    mocks.cr.findUnique.mockResolvedValue(existing); mocks.cr.findUniqueOrThrow.mockResolvedValue(existing);
    expect(await createChangeRequest({ proxyId: 'p1', customerId: 'c1', actorId: 'u1', action: 'BOT_ALLOW', summary: 'Allow', details: { domain: 'example.org', ip: '192.168.1.2' }, idempotencyKey: 'u1:key' })).toEqual(existing);
    expect(mocks.admit).not.toHaveBeenCalled();
  });
  it('rejects reusing an idempotency key for a different proxy', async () => {
    mocks.cr.findUnique.mockResolvedValue({ proxyId: 'p2', customerId: 'c1', ticketId: 't1' });
    await expect(createChangeRequest({ proxyId: 'p1', customerId: 'c1', actorId: 'u1', action: 'BOT_ALLOW', summary: 'Allow', idempotencyKey: 'u1:key' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('approved bot changes enqueue a command instead of reporting success before execution', async () => {
    mocks.cr.findUnique.mockResolvedValue({ id: 'cr1', proxyId: 'p1', customerId: 'c1', action: 'BOT_ALLOW', status: 'APPROVED' });
    mocks.enqueue.mockResolvedValue({ id: 'cmd1' });
    expect(await applyChangeRequest('cr1', 'u1')).toMatchObject({ status: 'DISPATCHED', commandId: 'cmd1' });
    expect(mocks.cr.update).not.toHaveBeenCalled();
  });
});
