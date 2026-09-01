import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTicketDb } from '../src/config/ticketDatabase';

// The cache reads REDIS_URL through lib/redis at import time, so the client is
// mocked rather than the env. Two shapes are exercised: no Redis (the dev/test
// default, which must call straight through) and a fake Redis (which must not).
const fake = {
  store: new Map<string, string>(),
  get: vi.fn(async (k: string) => fake.store.get(k) ?? null),
  setex: vi.fn(async (k: string, _ttl: number, v: string) => { fake.store.set(k, v); return 'OK'; }),
};

vi.mock('../src/lib/redis', () => ({
  get redis() { return current; },
  redisReady: () => current !== null,
}));

let current: typeof fake | null = null;

const { cached, cacheKey } = await import('../src/lib/cache');

beforeEach(() => {
  fake.store.clear();
  fake.get.mockClear();
  fake.setex.mockClear();
  current = null;
});

describe('cacheKey', () => {
  it('folds in the ticket-DB scope', () => {
    // The whole point: the shared and admin stores hold different organizations'
    // tickets behind identical call sites, so a key that ignored the scope would
    // serve one store's rows to the other's users.
    const shared = runWithTicketDb('default', () => cacheKey('dashboard', true));
    const admin = runWithTicketDb('admin', () => cacheKey('dashboard', true));
    expect(shared).not.toBe(admin);
    expect(shared).toBe('b2b:default:dashboard:true');
    expect(admin).toBe('b2b:admin:dashboard:true');
  });

  it('distinguishes different argument values', () => {
    expect(cacheKey('dashboard', true)).not.toBe(cacheKey('dashboard', false));
  });
});

describe('cached — without Redis', () => {
  it('calls through on every invocation', async () => {
    const fn = vi.fn(async () => 'value');
    expect(await cached('k', 30, fn)).toBe('value');
    expect(await cached('k', 30, fn)).toBe('value');
    expect(fn).toHaveBeenCalledTimes(2); // no caching, no crash
  });
});

describe('cached — with Redis', () => {
  beforeEach(() => { current = fake; });

  it('misses once, then serves from cache', async () => {
    const fn = vi.fn(async () => ({ n: 1 }));
    expect(await cached('k', 30, fn)).toEqual({ n: 1 });
    expect(await cached('k', 30, fn)).toEqual({ n: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fake.setex).toHaveBeenCalledWith('k', 30, JSON.stringify({ n: 1 }));
  });

  it('keeps separate keys separate', async () => {
    await cached('a', 30, async () => 'A');
    await cached('b', 30, async () => 'B');
    expect(await cached('a', 30, async () => 'other')).toBe('A');
    expect(await cached('b', 30, async () => 'other')).toBe('B');
  });

  it('falls through to the source when Redis reads throw', async () => {
    fake.get.mockRejectedValueOnce(new Error('connection refused'));
    const fn = vi.fn(async () => 'fresh');
    // A cache outage must cost the query it would have saved, not the request.
    expect(await cached('k', 30, fn)).toBe('fresh');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still returns the value when the write fails', async () => {
    fake.setex.mockRejectedValueOnce(new Error('OOM'));
    expect(await cached('k', 30, async () => 'v')).toBe('v');
  });

  it('does not attempt to store undefined', async () => {
    // JSON.stringify(undefined) is undefined, not a string — storing it would
    // throw on write and yield a corrupt entry on read.
    expect(await cached('k', 30, async () => undefined)).toBeUndefined();
    expect(fake.setex).not.toHaveBeenCalled();
  });

  it('round-trips through JSON, so callers must not rely on Date instances', async () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(await cached('k', 30, async () => ({ at: d }))).toEqual({ at: d });
    // Second call comes from Redis: a Date is now an ISO string. This is why the
    // cache wraps controller responses (already JSON) and never Prisma rows.
    const second = await cached('k', 30, async () => ({ at: d })) as { at: unknown };
    expect(typeof second.at).toBe('string');
  });
});
