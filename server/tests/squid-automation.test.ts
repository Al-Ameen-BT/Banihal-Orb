import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), count: vi.fn() }));
vi.mock('../src/config/database', () => ({ prisma: { squidAutomationControl: { findMany: mocks.findMany }, squidChangeRequest: { count: mocks.count } } }));
vi.mock('../src/lib/redis', () => ({ redis: null }));
import { automationState, assertAutomationRunning, withProxyLease, platformOverloaded } from '../src/modules/squid/squidAutomation';

describe('Squid automation controls', () => {
  beforeEach(() => vi.clearAllMocks());
  it('a client or proxy cannot clear a global pause', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'global', paused: true, reason: 'maintenance' }, { id: 'proxy:p1', paused: false }]);
    expect(await automationState('p1', 'c1')).toMatchObject({ paused: true, reasons: ['maintenance'] });
    await expect(assertAutomationRunning('p1', 'c1')).rejects.toMatchObject({ status: 503, code: 'SQUID_AUTOMATION_PAUSED' });
    expect(mocks.findMany.mock.calls[0]?.[0].where.id.in).toEqual(['global', 'global:overload', 'client:c1', 'proxy:p1']);
  });
  it('allows running proxies and never checks the network-disable flag', async () => {
    mocks.findMany.mockResolvedValue([]);
    await expect(assertAutomationRunning('p1', 'c1')).resolves.toBeUndefined();
  });
  it('fails closed when distributed dispatch storage is missing', async () => {
    await expect(withProxyLease('p1', async () => 'sent')).rejects.toMatchObject({ status: 503 });
  });
  it('detects platform CPU-load or memory pressure without disabling Squid', () => {
    expect(platformOverloaded(0.5, 0.5)).toBe(false);
    expect(platformOverloaded(0.85, 0.5)).toBe(true);
    expect(platformOverloaded(0.5, 0.9)).toBe(true);
  });
});
