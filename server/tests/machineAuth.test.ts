import crypto from 'crypto';
import { vi, describe, it, expect } from 'vitest';
import {
  MAX_BAD_AUTH,
  REPLAY_WINDOW_MS,
  canonicalMachineString,
  verifyMachineSignature,
  badAuthCounter,
} from '../src/lib/machineAuth';
import { redis } from '../src/lib/redis';

/**
 * Pure-function unit test for the shared machine-key auth module. No database,
 * no app, no network: REDIS_URL is unset in the unit env, so lib/redis exports
 * null and the counter takes its in-memory path — which is exactly the branch
 * this file pins. The wire behavior of the whole module is additionally pinned
 * by the (unmodified) squid-agent-hmac and bot-worker suites.
 */

// machineAuth reaches lib/redis, whose config/env parser hard-exits on missing
// required vars; seed them via vi.hoisted BEFORE the import graph evaluates.
// REDIS_URL is deliberately left unset — the unit env exercises redis = null.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://x:y@localhost:5432/x';
  process.env.CHAT_DATABASE_URL ??= 'postgresql://x:y@localhost:5432/x';
  process.env.TICKETING_DATABASE_URL ??= 'postgresql://x:y@localhost:5432/x';
  process.env.ADMIN_TICKETING_DATABASE_URL ??= 'postgresql://x:y@localhost:5432/x';
  process.env.TICKET_DATABASE_URL ??= 'postgresql://x:y@localhost:5432/x';
  process.env.JWT_ACCESS_SECRET ??= 'x'.repeat(48);
  process.env.IMPERSONATION_SECRET ??= 'x'.repeat(48);
  delete process.env.REDIS_URL;
});

// ─── Signing helpers: build signatures the way a machine client does ────────

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

interface Signed { tsMs: number; secret: string; method: string; path: string; rawBody?: Buffer }

/** HMAC over the canonical string, exactly as the Python agent client signs. */
function sign({ tsMs, secret, method, path, rawBody }: Signed): string {
  const canonical = canonicalMachineString(String(tsMs), method, path, sha256Hex(rawBody ?? Buffer.alloc(0)));
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

const KEY = 'raw_machine_key_for_unit_tests';
// "Now" at run time: rows that pass no nowMs must land INSIDE the replay
// window against the real clock, so the base timestamp cannot be a fixed date.
const TS = Date.now();
const PATH = '/api/proxy-agent/result';
const BODY = Buffer.from('{"seq":42}');

type VerifyInput = Parameters<typeof verifyMachineSignature>[0];
type Verdict = { ok: true } | { ok: false; code: string };

interface Row {
  /** Signature construction overrides (the "client" side). */
  make: Partial<Signed>;
  /** Verifier input overrides (the "server" side). Absent keys inherit the signed-overrides. */
  input?: VerifyInput;
  want: Verdict;
}

const BASE: Signed = { tsMs: TS, secret: KEY, method: 'POST', path: PATH, rawBody: BODY };

describe('machineAuth', () => {
  // Every verify row derives from one correctly signed request. The row's
  // `make` decides what was signed; unfilled *server* inputs stay identical to
  // what was signed, so a row diverges from the happy path in exactly one place.
  const rows: Array<Row & { name: string }> = [
    {
      name: 'verify: valid — HMAC round-trip over a real key + body',
      make: {},
      want: { ok: true },
    },
    {
      name: 'verify: empty body (GET) — undefined rawBody signs sha256 of empty string',
      make: { method: 'GET', path: '/api/proxy-agent/poll', rawBody: undefined },
      want: { ok: true },
    },
    {
      name: 'verify: tampered body — one flipped byte after signing',
      make: {},
      input: {
        // Same correct signature, but the body the server received differs in
        // one byte — the exact attack the signature exists to catch.
        rawBody: Buffer.from('{"seq":43}'),
      },
      want: { ok: false, code: 'BAD_SIGNATURE' },
    },
    {
      name: 'verify: replay window boundary — ts + 300_000 is inside the window',
      make: {},
      input: { nowMs: TS + REPLAY_WINDOW_MS },
      want: { ok: true },
    },
    {
      name: 'verify: replay window boundary — ts + 300_001 is rejected',
      make: {},
      input: { nowMs: TS + REPLAY_WINDOW_MS + 1 },
      want: { ok: false, code: 'BAD_TIMESTAMP' },
    },
    {
      name: 'verify: query string is signed — path with ?x=1, verified without it',
      make: { path: `${PATH}?x=1` },
      input: { path: PATH },
      want: { ok: false, code: 'BAD_SIGNATURE' },
    },
    {
      name: 'verify: KEY_DIVERGED — valid signature but mismatching key hash column',
      make: {},
      input: {
        // Server also carries a sha-256 of the raw key; a row whose stored hash
        // was taken from a DIFFERENT key proves the columns diverged even
        // though the HMAC signature itself is perfectly valid.
        secretHash: sha256Hex(Buffer.from('a_different_raw_key')),
      },
      want: { ok: false, code: 'KEY_DIVERGED' },
    },
  ];

  for (const { name, make, input, want } of rows) {
    it(name, () => {
      // The client (sign side) signs over the *make* view; the server (verify
      // side) sees *make* UNLESS *input* deliberately diverges — so a row
      // differs from the happy path in exactly the tampering it describes.
      expect(verifyMachineSignature({
        ...BASE,
        ...make,
        ...input,
        sig: sign({ ...BASE, ...make }),
      })).toEqual(want);
    });
  }

  it('canonical: known vector — lowercase method uppercased, fixed field order', () => {
    expect(canonicalMachineString('1000', 'POST', '/api/proxy-agent/result', 'abc'))
      .toBe('1000\nPOST\n/api/proxy-agent/result\nabc');
    expect(canonicalMachineString('1000', 'post', '/api/proxy-agent/result', 'abc'))
      .toBe('1000\nPOST\n/api/proxy-agent/result\nabc');
  });

  it('pins the security constants (window 5 min, disable threshold 5)', () => {
    expect(REPLAY_WINDOW_MS).toBe(300_000);
    expect(MAX_BAD_AUTH).toBe(5);
  });
});

describe('badAuthCounter', () => {
  // Distinct ids per test: the counter is module-level state and a streak
  // bleeding between tests would mask a wrong-key bug.
  let seq = 0;
  const uniqueId = (tag: string): string => `unit:${tag}:${++seq}`;

  it('counter: success resets the streak — 4 bumps, reset, bump again → 1 (not 5)', async () => {
    const id = uniqueId('reset');
    for (let n = 1; n <= 4; n++) expect(await badAuthCounter.bump(id)).toBe(n);
    await badAuthCounter.reset(id);
    expect(await badAuthCounter.bump(id)).toBe(1);
  });

  it('counter: falls back to memory — redis null in the unit env gives identical INCR/DEL semantics', async () => {
    expect(redis).toBe(null);
    const id = uniqueId('memory');
    for (let n = 1; n <= MAX_BAD_AUTH; n++) expect(await badAuthCounter.bump(id)).toBe(n);
    await badAuthCounter.reset(id);
    expect(await badAuthCounter.bump(id)).toBe(1);
  });
});
