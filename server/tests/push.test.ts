import { describe, it, expect, beforeEach, vi } from 'vitest';

// Both boundaries are mocked, deliberately: what is under test is the cleanup
// decision around a send — which failures retire a subscription and which must
// not — and neither RFC 8291 encryption nor a live database has an opinion on
// that. It also keeps this file runnable without the seeded test database.
const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: (...a: unknown[]) => sendNotification(...a) },
}));

const findMany = vi.fn();
const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
const updateMany = vi.fn().mockResolvedValue({ count: 1 });
vi.mock('../src/config/database', () => ({
  prisma: { pushSubscription: { findMany: (...a: unknown[]) => findMany(...a), deleteMany: (...a: unknown[]) => deleteMany(...a), updateMany: (...a: unknown[]) => updateMany(...a) } },
}));

// ensureVapid() throws unless both halves are set, so these must land before
// lib/webpush reads them through config/env.
process.env['VAPID_PUBLIC_KEY'] ||= 'test-public-key';
process.env['VAPID_PRIVATE_KEY'] ||= 'test-private-key';

const { sendToUser, isPushConfigured } = await import('../src/lib/webpush');

const sub = (endpoint: string) => ({ endpoint, p256dh: 'p', auth: 'a' });
const send = () => sendToUser({ userId: 'u1', tenantId: 't1', payload: { title: 'x' } });

// A push service reports a dead subscription with 404/410; web-push surfaces
// that as an error carrying `statusCode`.
const httpError = (statusCode: number) => Object.assign(new Error(`push failed ${statusCode}`), { statusCode });

beforeEach(() => {
  sendNotification.mockReset();
  deleteMany.mockClear();
  findMany.mockReset();
});

describe('web push delivery', () => {
  it('reports configured when both VAPID halves are present', () => {
    expect(isPushConfigured()).toBe(true);
  });

  it('retires the subscription when the push service says the endpoint is gone (410)', async () => {
    findMany.mockResolvedValue([sub('https://push.example/gone')]);
    sendNotification.mockRejectedValueOnce(httpError(410));

    expect(await send()).toMatchObject({ total: 1, sent: 0, removed: 1, failed: 0 });
    expect(deleteMany).toHaveBeenCalledWith({ where: { endpoint: 'https://push.example/gone' } });
  });

  it('KEEPS the subscription on any other failure — a 403 is a key mismatch, not a dead device', async () => {
    findMany.mockResolvedValue([sub('https://push.example/keep')]);
    sendNotification.mockRejectedValueOnce(httpError(403));

    const result = await send();

    expect(result).toMatchObject({ total: 1, sent: 0, removed: 0, failed: 1 });
    expect(result.outcomes[0]).toMatchObject({ status: 'error', statusCode: 403 });
    // Retiring here would silently unsubscribe every browser on a mis-keyed deploy.
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('one dead device does not stop delivery to the others', async () => {
    findMany.mockResolvedValue([sub('https://push.example/dead'), sub('https://push.example/live')]);
    sendNotification.mockImplementation((s: { endpoint: string }) =>
      (s.endpoint.endsWith('/dead') ? Promise.reject(httpError(410)) : Promise.resolve()));

    expect(await send()).toMatchObject({ total: 2, sent: 1, removed: 1, failed: 0 });
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it('a failed freshness bump never fails an otherwise-delivered send', async () => {
    findMany.mockResolvedValue([sub('https://push.example/ok')]);
    sendNotification.mockResolvedValueOnce(undefined);
    updateMany.mockRejectedValueOnce(new Error('db blip'));

    expect(await send()).toMatchObject({ total: 1, sent: 1, removed: 0, failed: 0 });
  });
});
