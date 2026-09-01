import { redis } from './redis';
import { getTicketDbScope } from '../config/ticketDatabase';

// ─── Read-through cache for expensive aggregate reads ────────────────────────
// Wraps the handful of unbounded full-table scans behind the dashboards
// (dashboardFeed, allTicketsForStats, the analytics rollups). Those endpoints are
// polled on 15-60s timers by every connected admin, so without this each open
// dashboard tab triggers its own scan on every tick.
//
// Invalidation is TTL-only, on purpose. Every cached read already sits behind a
// react-query poll of the same order, so a TTL shorter than the poll interval adds
// no staleness a user can perceive — while event-based invalidation across five
// databases and two ticket stores is where cache bugs come from.

/** TTLs in seconds. Kept here so every call site's staleness is visible in one place. */
export const TTL = {
  /** Dashboard feeds and stats rollups — polled at 30-60s. */
  dashboard: 30,
  /** Project and assignee pickers — small, hot, and rarely changed. */
  reference: 60,
} as const;

/**
 * Build a namespaced cache key.
 *
 * The ticket-DB scope is BAKED IN and not optional. dashboardFeed and friends read
 * whichever store the current `runWithTicketDb` scope selects, and the shared
 * (`default`) and platform-admin (`admin`) stores hold different organizations'
 * tickets. A key that omitted the scope would serve one store's tickets to the
 * other's users the moment both are warm — a cross-tenant leak, not a stale read.
 * That is why every key goes through here rather than being written by hand.
 */
export function cacheKey(name: string, ...parts: (string | number | boolean)[]): string {
  return ['b2b', getTicketDbScope(), name, ...parts].join(':');
}

/**
 * Read through the cache: return the cached value, or run `fn`, store it, return it.
 *
 * Every Redis interaction is best-effort. A cache miss, a serialization failure and
 * an unreachable Redis all take the same path — call `fn` — so the worst a broken
 * cache can do is cost the query it was meant to save.
 */
export async function cached<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  if (!redis) return fn();

  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch {
    // Unreachable Redis, or a value written by an older, incompatible shape.
    // Either way the database is the source of truth — fall through to it.
    return fn();
  }

  const value = await fn();

  // Cache `undefined` as nothing: JSON.stringify(undefined) is undefined, not a
  // string, and storing that would throw on write and crash on read.
  if (value !== undefined) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(value));
    } catch {
      // A failed write is not a failed request — the caller already has its value.
    }
  }

  return value;
}

/**
 * Drop cached entries by prefix, scoped to the CURRENT ticket store.
 *
 * Uses SCAN rather than KEYS: KEYS blocks the Redis event loop for the whole
 * keyspace, which on a shared instance stalls every other client including the
 * rate limiters.
 */
export async function invalidate(name: string): Promise<void> {
  if (!redis) return;
  const match = `${cacheKey(name)}*`;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 100);
      if (keys.length > 0) await redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  } catch {
    // Best-effort: the entries expire on their own within TTL seconds anyway.
  }
}
