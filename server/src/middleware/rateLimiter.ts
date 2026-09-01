import rateLimit, { type Store, type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { RequestHandler } from 'express';
import { rateLimitConfig } from '../config/security';
import { redis } from '../lib/redis';

// Disable rate limiting under the test runner so the suite's rapid auth calls
// aren't throttled (NODE_ENV=test in CI; VITEST is set by vitest itself).
const isTestEnv = process.env['NODE_ENV'] === 'test' || process.env['VITEST'] === 'true';

// ─── Store ───────────────────────────────────────────────────────────────────
// Redis when configured, express-rate-limit's in-memory store otherwise.
//
// The in-memory store is per-process, so counters reset on every restart and are
// counted separately by each API instance. That was survivable while systemd ran
// exactly one process; it is not once the API is containerized and restartable at
// will, because "restart the API" becomes a way to clear an attacker's counter.
//
// Each limiter needs its OWN store instance with a distinct prefix — sharing one
// would add every limiter's hits into the same counter, so the global limiter's
// traffic would exhaust the (much smaller) auth budget for every user.
type Cfg = { windowMs: number; max: number };

function redisStore(prefix: string): Store | undefined {
  // Bound to a local so the narrowing survives into the closure below — TypeScript
  // will not carry a null-check on an imported binding across a function boundary.
  const client = redis;
  if (!client) return undefined;
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    // rate-limit-redis speaks raw commands; `.call()` is ioredis's escape hatch
    // for that. The cast is required because ioredis types `.call()` loosely
    // (`unknown`) while the store's signature wants a concrete reply type.
    //
    // This MUST NOT return a rejected promise. RedisStore issues a SCRIPT LOAD
    // from its own constructor and never attaches a catch, so with Redis
    // unreachable at boot that rejection escapes as an unhandledRejection and
    // Node kills the process — measured: the API logged "Server running" and then
    // died on MaxRetriesPerRequestError. Resolving with a sentinel keeps the
    // failure inside the request path, where the EVALSHA gets nonsense back,
    // express-rate-limit calls next(err), and withMemoryFallback below takes over.
    sendCommand: (async (...args: string[]) => {
      // Short-circuit while disconnected. Without this the call waits out
      // commandTimeout before failing, and since the global limiter runs on every
      // request that added a measured ~1s to EVERY request for the whole duration
      // of a Redis outage. ioredis reconnects in the background, so `status` flips
      // back to 'ready' on its own and Redis resumes being authoritative.
      if (client.status !== 'ready') return '';
      try {
        return await client.call(...(args as [string, ...string[]]));
      } catch {
        return '';
      }
    }) as never,
  });
}

// ─── Degradation and recovery ────────────────────────────────────────────────
// express-rate-limit surfaces a store failure through `next(err)`, which the error
// handler turns into a 500. Because the global limiter runs on EVERY request, an
// unreachable Redis therefore took the whole API down — measured, not theorised.
//
// Failing open instead would be worse: it removes brute-force protection from
// /auth exactly when something is already wrong. So a failed Redis call falls
// through to an in-memory limiter — the limit is still enforced, just per-process
// and not surviving a restart, which is precisely the behaviour this deployment
// had before Redis existed. An outage costs the coordination, never the request
// and never the protection.
//
// The Redis limiter is built LAZILY, and only while the client is ready. Building
// it eagerly meant RedisStore ran its SCRIPT LOAD against a dead server, cached a
// broken script hash, and then kept failing forever — the app stayed silently on
// memory-only limiting even after Redis came back. Constructing on a ready client
// (and discarding the limiter whenever it errors) is what makes recovery automatic.
function limiter(
  prefix: string,
  cfg: Cfg,
  message: object,
  extra: Partial<Parameters<typeof rateLimit>[0]> = {},
): RequestHandler {
  const base = { ...cfg, standardHeaders: true, legacyHeaders: false, skip: () => isTestEnv, message, ...extra };
  const memory = rateLimit({ ...base });
  let distributed: RateLimitRequestHandler | null = null;

  return (req, res, next) => {
    const client = redis;
    // Not configured, or currently unreachable → memory, with no waiting. ioredis
    // reconnects in the background, so `status` flips back on its own.
    if (!client || client.status !== 'ready') { memory(req, res, next); return; }

    if (!distributed) {
      const store = redisStore(prefix);
      if (!store) { memory(req, res, next); return; }
      distributed = rateLimit({ ...base, store });
    }

    distributed(req, res, (err?: unknown) => {
      if (!err) { next(); return; }
      // Drop it so the next ready request rebuilds against a live Redis — this is
      // what recovers from a Redis restart, where the cached script hash is gone.
      distributed = null;
      memory(req, res, next);
    });
  };
}

export const globalRateLimiter = limiter(
  'global', rateLimitConfig.global,
  { error: 'Too many requests', code: 'RATE_LIMITED' },
);

export const authRateLimiter = limiter(
  'auth', rateLimitConfig.auth,
  { error: 'Too many authentication attempts', code: 'AUTH_RATE_LIMITED' },
);

export const chatRateLimiter = limiter(
  'chat', rateLimitConfig.chat,
  { error: 'Too many messages, please slow down', code: 'CHAT_RATE_LIMITED' },
  {
    // Key on the authenticated user, not the client IP. The chat route runs behind
    // auth + a reverse proxy, so req.ip resolves to the proxy's address unless
    // TRUST_PROXY names it — keying on it would collapse every user into ONE shared
    // bucket and throttle the whole platform's assistant at once. userId keeps the
    // limit strictly per-user; req.ip is only a fallback (never hit while authed).
    keyGenerator: (req) => req.user?.userId ?? req.ip ?? 'anonymous',
  },
);
