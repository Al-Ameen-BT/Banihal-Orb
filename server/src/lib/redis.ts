import Redis from 'ioredis';
import { env } from '../config/env';

// ─── Redis connection ────────────────────────────────────────────────────────
// One client for the whole process, shared by the cache (lib/cache.ts), the rate
// limiters (middleware/rateLimiter.ts) and the agent lock (services/agentApi.ts).
//
// Redis is OPTIONAL here, and that is a deliberate design constraint rather than
// laziness: nothing it holds is a source of truth. Cache entries are recomputable
// from PostgreSQL, rate-limit counters are safe to lose, and the agent lock has an
// in-process fallback. So an unreachable Redis must DEGRADE the app, never stop
// it — `REDIS_URL` unset returns null everywhere and each caller takes its
// in-process path.

let client: Redis | null = null;

if (env.REDIS_URL) {
  client = new Redis(env.REDIS_URL, {
    // The offline queue MUST stay enabled. rate-limit-redis issues a command from
    // its constructor (loadIncrementScript) at module-load time, before ioredis
    // has finished connecting — with the queue off that command rejects
    // immediately and the unhandled rejection kills the process on startup. The
    // queue is what lets a command issued during connect survive until it.
    enableOfflineQueue: true,
    // What keeps that queue from becoming the stall it would otherwise be: a
    // command gets one retry and a hard 1s ceiling, so a cache read against a
    // dead Redis fails fast and `cached()` falls through to PostgreSQL, rather
    // than holding the request open while ioredis retries.
    maxRetriesPerRequest: 1,
    commandTimeout: 1_000,
    // Cap the backoff so a long outage doesn't leave us waiting minutes to
    // reconnect once Redis returns.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    lazyConnect: false,
  });

  // ioredis emits 'error' on every failed reconnect attempt. Without a listener
  // Node treats it as an unhandled 'error' event and CRASHES the process — so
  // this handler is load-bearing, not logging garnish. Rate-limited to one line
  // per 30s so a sustained outage doesn't flood the journal.
  let lastLog = 0;
  client.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastLog > 30_000) {
      lastLog = now;
      console.error('⚠️  Redis unavailable (degrading to in-process behaviour):', err.message);
    }
  });

  client.on('ready', () => console.log('✅ Redis connected'));
}

/** The shared client, or null when REDIS_URL is unset. Callers MUST handle null. */
export const redis = client;

/** True when Redis is configured AND currently usable. */
export const redisReady = (): boolean => client?.status === 'ready';
