// ─── Shared machine-key auth (ADR-003) ──────────────────────────────────────
// One module for both machine control planes: the per-proxy squid agent
// (modules/squid) and the host slack-bots worker. Both routers today carry ~40
// near-identical inline HMAC lines; this module is that extract, so the routers
// can only differ in what is genuinely theirs: WHICH actor they load and WHAT
// it costs to be disabled.
//
// The wire format is provisioned — DO NOT change it, deployed agents and
// workers pin it (squid-agent-hmac / bot-worker suites are the proof):
//   canonical = `${ts}\n${METHOD}\n${path}\n${sha256(rawBody)}`,
//   HMAC-SHA256 keyed with the raw machine key, sent as
//   `Authorization: Bearer <hex>`; `ts` is epoch MILLISECONDS.
// The window keeps `Math.abs(now - ts)` because that is how production has
// always tolerated clock skew, in either direction.
//
// `redis` is nullable by design (lib/redis): the bad-auth streak degrades to an
// in-process Map, never to a hard dependency. And when something fails — even a
// redis error mid-bump — the module must still answer the request, failing
// closed toward 401.

import crypto from 'crypto';
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { redis } from './redis';
import { audit } from './audit';
import type { AuditAction } from '../config/auditActions';

/** Consecutive bad-auth attempts after which the actor is force-disabled. */
export const MAX_BAD_AUTH = 5;
/** Acceptance window on the signed timestamp, in either direction (ms). */
export const REPLAY_WINDOW_MS = 300_000;

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * The exact byte string both machine clients sign. `path` is `req.originalUrl`
 * — WITH the query string: the url is signed as the client saw it, so a signed
 * request cannot be replayed against a different query.
 */
export function canonicalMachineString(ts: string, method: string, path: string, bodySha256Hex: string): string {
  return `${ts}\n${method.toUpperCase()}\n${path}\n${bodySha256Hex}`;
}

/**
 * Verify one machine request against its parsed headers. Every failure is a
 * RETURN, never a throw — the caller answers a generic 401 with this code and
 * nothing else. `secretHash`, when the backing table has one, is cross-checked
 * BEFORE the HMAC: if the encrypted key and its stored hash ever diverge (one
 * rotated, one cleared), the signature below could still verify, and the
 * columns' drift must surface as KEY_DIVERGED, not silently pass.
 */
export function verifyMachineSignature(input: {
  tsMs: number; // parsed timestamp header value
  sig: string; // raw hex without "Bearer "
  secret: string; // decrypted raw machine key
  secretHash?: string | null; // sha-256 hex of the raw key from its hash column, if the table has one
  method: string; // req.method
  path: string; // req.originalUrl
  rawBody?: Buffer; // undefined for an empty/GET body
  nowMs?: number; // injectable clock for tests (defaults Date.now())
}): { ok: true } | { ok: false; code: 'BAD_TIMESTAMP' | 'BAD_SIGNATURE' | 'KEY_DIVERGED' } {
  const { tsMs, sig, secret, secretHash, method, path, rawBody, nowMs = Date.now() } = input;

  // A NaN timestamp would stringify into the canonical string and come back as
  // a misleading BAD_SIGNATURE; the window rejects both directions with the
  // same abs comparison the routers ran before this module existed.
  if (!Number.isFinite(tsMs) || Math.abs(nowMs - tsMs) > REPLAY_WINDOW_MS) {
    return { ok: false, code: 'BAD_TIMESTAMP' };
  }

  if (secretHash) {
    const have = Buffer.from(sha256Hex(Buffer.from(secret, 'utf8')), 'hex');
    const want = Buffer.from(secretHash.toLowerCase(), 'hex');
    // Compare DECODED digests, case-normalized on the stored side so a
    // lowercase-digest writer and an uppercase-hex DB row cross-check equal;
    // garbage rows truncate shorter and diverge fail-closed.
    // Length-check first: timingSafeEqual THROWS on unequal lengths (an
    // attacker-controllable `want` — a row value — must never crash the handler).
    if (want.length !== have.length || !crypto.timingSafeEqual(want, have)) {
      return { ok: false, code: 'KEY_DIVERGED' };
    }
  }

  const canonical = canonicalMachineString(String(tsMs), method, path, sha256Hex(rawBody ?? Buffer.alloc(0)));
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest();
  const sigBuf = Buffer.from(sig, 'hex');
  // hex-DECODE before comparing: any value that is not exactly the digest's
  // hex (wrong length, non-ASCII like 64× 'é' whose UTF-8 is 128 bytes,
  // ordinary garbage) decodes short or unequal and fails flat with
  // BAD_SIGNATURE — the old string-length guard passed it to
  // timingSafeEqual, which THROWS on unequal byte lengths. Decoding also
  // makes the compare case-insensitive on hex digits for the same digest —
  // strictly a normalization, never a weaker acceptance.
  if (sigBuf.length !== expected.length || !crypto.timingSafeEqual(sigBuf, expected)) {
    return { ok: false, code: 'BAD_SIGNATURE' };
  }
  return { ok: true };
}

// ─── Bad-auth streak counter ─────────────────────────────────────────────────
// "Streak" semantics, the same the two inline routers had: consecutive failures
// counted per actor, cleared on a successful auth. Redis keeps the streak
// alive across processes (INCR with a 10-minute EXPIRE); without redis an
// in-process Map gives IDENTICAL numbers — the gap you inherit is only that a
// process restart clears the measure-in-progress, as before.

const BAD_AUTH_KEY_PREFIX = 'b2b:machauth:bad:';
/** Streak TTL: one failure keeps counting only if the next one arrives within 10 min. */
const BAD_AUTH_TTL_S = 600;
const memoryBadAuth = new Map<string, number>();

export const badAuthCounter: { bump(id: string): Promise<number>; reset(id: string): Promise<void> } = {
  /** Returns the consecutive-failure streak (so `n >= MAX_BAD_AUTH` disable). Never throws. */
  async bump(id: string): Promise<number> {
    if (redis) {
      try {
        const n = await redis.incr(BAD_AUTH_KEY_PREFIX + id);
        await redis.expire(BAD_AUTH_KEY_PREFIX + id, BAD_AUTH_TTL_S);
        return n;
      } catch {
        // Redis down mid-bump: the count is advisory, the 401 itself must not
        // fail over it. Fall back to the in-process Map for this call.
      }
    }
    const n = (memoryBadAuth.get(id) ?? 0) + 1;
    memoryBadAuth.set(id, n);
    return n;
  },

  /** Success (or disable) clears the streak in whichever store is live. */
  async reset(id: string): Promise<void> {
    memoryBadAuth.delete(id);
    if (redis) {
      try { await redis.del(BAD_AUTH_KEY_PREFIX + id); } catch { /* memory is clear; a stale key expires via TTL */ }
    }
  },
};

// ─── The middleware factory ──────────────────────────────────────────────────
// Everything the two routers shared is here; everything they differ in is
// config. The response wire is frozen on purpose: 401
// `{ error: 'Authentication failed', code }` with the router's default code for
// every "cannot even try to verify" case (missing actor id, undecryptable or
// diverged key), and the verifier's specific code only once verification
// actually ran. A missing/`keyMissing` actor still 401s — indistinguishably
// from a bad signature, per the wire contract: an attacker learns nothing from
// the error taxonomy except what a valid actor would learn anyway.

export interface MachineActor<TCtx> {
  actorId: string;
  context: TCtx; // attached to req under `reqKey` on success — `secret` is NOT attached
  /**
   * The decrypted raw machine key. Lives here only long enough to reach
   * verifyMachineSignature inside this handler — never logged, never put on
   * req. OPTIONAL on purpose: a loader whose row exists but carries no usable
   * key sets `keyMissing` and omits this; an empty string is treated exactly
   * like an absent one. There is no fabricated key — a missing key can never
   * verify by accident.
   */
  secret?: string;
  /** sha-256 hex of the raw secret from its hash column, when the table has one. */
  secretHash?: string | null;
  /** True when the row exists but carries no usable key: same generic 401 as null. */
  keyMissing?: true;
  /**
   * The actor's org, when the loader already selected it. The factory's generic
   * audit row needs it because AuditLog.customerId is NOT NULL and the factory
   * itself knows nothing about orgs. Loaders that DON'T supply it simply leave
   * the org-aware audit to the router (which audits on machAuthFailed anyway) —
   * a null customerId would be unreachable by the schema, so never faked here.
   */
  customerId?: string;
}

export interface MachineAuthConfig<TCtx> {
  actorIdOf: (req: Request) => string;
  /** 'X-Proxy-Timestamp' | 'X-Worker-Timestamp' — the factory reads and parses it (NaN-safe). */
  timestampHeader: string;
  /** Null when the actor, its key columns, or their agreement is missing. */
  loadActor: (actorId: string) => Promise<MachineActor<TCtx> | null>;
  /** 'proxy' | 'workerBot' — property name the authenticated context is set under. */
  reqKey: string;
  /** 'PROXY_AUTH_FAILED' | 'WORKER_AUTH_FAILED' — the default 401 code. */
  authFailedCode: string;
  /**
   * 401 code for "cannot even try to verify": loadActor returned null or a
   * keyMissing-flagged actor. Defaults to authFailedCode; a router whose table
   * distinguishes "key never provisioned" from a signature failure (botWorker
   * pins WORKER_KEY_NOT_SET) overrides it here.
   */
  keyMissingCode?: string;
  /**
   * 'SQUID_AGENT_AUTH_FAILED' | 'WORKER_AUTH_FAILED'. AuditAction rather than a
   * bare string so a typo stays a compile error — the reason lib/audit types
   * actions at all.
   */
  auditAction: AuditAction;
  /** Disable the actor after MAX_BAD_AUTH consecutive bad signatures. */
  onBruteForceDisable: (actorId: string) => Promise<void>;
}

/**
 * Builds the shared machine-auth middleware. Org-aware auditing (customer
 * context) stays with the ROUTER, which can audit richer facts from
 * `res.locals['machAuthFailed']` — this factory audits only what it knows:
 * actorId, ip and the attempt count.
 */
export function createMachineKeyAuth<TCtx>(cfg: MachineAuthConfig<TCtx>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // `actorId` lives in the enclosing scope so the failure flag can still be
    // written (with the id known so far) when something downstream throws.
    let actorId = '';
    const res401 = (code: string, attempts = 0) => {
      res.locals['machAuthFailed'] = { actorId, code, attempts };
      res.status(401).json({ error: 'Authentication failed', code });
    };
    try {
      actorId = cfg.actorIdOf(req);
      const ts = Number(req.get(cfg.timestampHeader));
      const sig = (req.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');

      if (!actorId || !sig || !Number.isFinite(ts)) { res401(cfg.authFailedCode); return; }
      // Cheap pre-check (semantics identical to the verifier's own window):
      // a stale clock must never pay for the DB trip + decrypt in loadActor.
      if (Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) { res401('BAD_TIMESTAMP'); return; }

      const actor = await cfg.loadActor(actorId);
      if (!actor || actor.keyMissing || !actor.secret) { res401(cfg.keyMissingCode ?? cfg.authFailedCode); return; }

      const verdict = verifyMachineSignature({
        tsMs: ts,
        sig,
        secret: actor.secret,
        secretHash: actor.secretHash,
        method: req.method,
        path: req.originalUrl,
        rawBody: (req as { rawBody?: Buffer }).rawBody,
      });

      if (!verdict.ok) {
        // The failure flag reports the strike count the counter produced for
        // THIS request (bad signature), 0 for any other denial.
        let attempts = 0;
        if (verdict.code === 'BAD_SIGNATURE') {
          // Count only signature mismatches — a stale clock is not an attack
          // signal. The generic row is written only when the actor carries an
          // org, because audit() cannot write one without a customerId (schema
          // NOT NULL); routers auditing on machAuthFailed keep their own richer,
          // org-aware row regardless. Fired, NOT awaited — the deny response
          // must not wait on a DB write, and a lost row must not lose the 401.
          attempts = await badAuthCounter.bump(actorId);
          if (actor.customerId) {
            void audit({
              action: cfg.auditAction,
              performedById: null,
              customerId: actor.customerId,
              targetId: actorId,
              metadata: { reason: 'signature mismatch', ip: req.ip, attempts },
            }).catch(() => undefined);
          }
          if (attempts >= MAX_BAD_AUTH) {
            await badAuthCounter.reset(actorId);
            await cfg.onBruteForceDisable(actorId);
          }
        }
        res401(verdict.code, attempts);
        return;
      }

      await badAuthCounter.reset(actorId);
      (req as Request & Record<string, unknown>)[cfg.reqKey] = actor.context;
      next();
    } catch {
      // Fail CLOSED: a loadActor / onBruteForceDisable / counter blip becomes
      // a generic 401, never an unhandled rejection and never `next(err)` —
      // an UNVERIFIED request reaching the route handlers is the one failure
      // this module must never allow.
      if (!res.headersSent) res401(cfg.authFailedCode);
    }
  };
}
