import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import rateLimit, { type Store } from 'express-rate-limit';

// ─── Regression: ERR_ERL_CREATED_IN_REQUEST_HANDLER ──────────────────────────
// middleware/rateLimiter.ts builds its Redis-backed limiter LAZILY, inside the
// request handler — that is what recovers from a Redis that was dead at boot.
// express-rate-limit v7 flags exactly that shape by scanning the construction
// stack for Express's "Layer.handle [as handle_request]" frame, so the frame has
// to be real: these tests go through an actual router rather than faking a stack.
//
// The warning does not apply to us (a store without `localKeys` keeps its
// counters in Redis, not per-instance memory), but left on it printed a stack
// trace on every rebuild. Production logged it as an apparent crash.

/** A shared-state store, like RedisStore: deliberately no `localKeys`. */
function sharedStore(): Store {
  const hits = new Map<string, number>();
  return {
    async increment(key: string) {
      const totalHits = (hits.get(key) ?? 0) + 1;
      hits.set(key, totalHits);
      return { totalHits, resetTime: new Date(Date.now() + 60_000) };
    },
    async decrement(key: string) { hits.set(key, Math.max(0, (hits.get(key) ?? 0) - 1)); },
    async resetKey(key: string) { hits.delete(key); },
  };
}

/** Build a limiter inside a request handler, exactly as rateLimiter.ts does. */
function appBuildingLimiterMidRequest(opts: Parameters<typeof rateLimit>[0]) {
  const app = express();
  let built: ReturnType<typeof rateLimit> | null = null;
  app.use((req, res, next) => {
    built ??= rateLimit(opts);
    built(req, res, next);
  });
  app.get('/', (_req, res) => { res.json({ ok: true }); });
  return app;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('lazy Redis limiter construction', () => {
  it('logs nothing when creationStack validation is disabled', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = appBuildingLimiterMidRequest({
      windowMs: 60_000, max: 100, store: sharedStore(),
      validate: { creationStack: false },
    });
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still enforces the limit — the flag silences the warning, not the limiter', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = appBuildingLimiterMidRequest({
      windowMs: 60_000, max: 2, store: sharedStore(),
      validate: { creationStack: false },
    });

    expect((await request(app).get('/')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(429);
  });

  it('proves the guard is real: without the flag it logs the error we saw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = appBuildingLimiterMidRequest({
      windowMs: 60_000, max: 100, store: sharedStore(),
    });
    await request(app).get('/');

    // Guarding against a future version that stops flagging this: if this ever
    // fails, the `validate` opt-out above is dead weight and can be removed.
    expect(spy).toHaveBeenCalled();
    const logged = spy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('ERR_ERL_CREATED_IN_REQUEST_HANDLER');
  });

  it('keeps every other validation switched on', async () => {
    // Two spies on purpose: express-rate-limit splits its own output, sending
    // ChangeWarnings to console.warn and everything else to console.error.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // `max: 0` trips WRN_ERL_MAX_ZERO — a different validation, which must still
    // fire while creationStack is off.
    const app = appBuildingLimiterMidRequest({
      windowMs: 60_000, max: 0, store: sharedStore(),
      validate: { creationStack: false },
    });
    await request(app).get('/');

    const errored = err.mock.calls.flat().map(String).join('\n');
    const warned = warn.mock.calls.flat().map(String).join('\n');
    expect(errored).not.toContain('ERR_ERL_CREATED_IN_REQUEST_HANDLER');
    expect(warned).toContain('WRN_ERL_MAX_ZERO');
  });
});
