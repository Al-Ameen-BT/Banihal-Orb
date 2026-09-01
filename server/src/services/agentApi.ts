// Signed client for the Analytics Agent's external API (/v1/*, port 8001).
//
// Distinct from services/agentClient.ts and modules/chat: those call the agent's
// UNSIGNED `/api/chat` SSE endpoint and stream tokens with conversation history.
// This module speaks the documented, HMAC-signed `/v1` surface, which is
// request/response JSON with no streaming and no history. Both are live and both
// point at the same host — see AGENT_URL vs AGENT_BASE_URL in .env.example.
//
// Auth is "Scheme B" from the agent's API_INTEGRATION.md: the shared secret never
// travels on the wire; each request carries a signature over the timestamp and the
// exact body bytes, so a captured request cannot be replayed against a different
// body or at a later time.

import crypto from 'crypto';
import { env } from '../config/env';
import { redis } from '../lib/redis';

// ─── Roles ───────────────────────────────────────────────────────────────────

/** The five audience roles the agent scopes its guidance to. */
export const AGENT_ROLES = ['end_user', 'l1', 'l2', 'l3', 'security'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * This app's platform role → the agent's audience role.
 *
 * The mapping must stay inside the allowed-roles list the agent administrator
 * set on our `ext-*` credential, or the agent answers 403 `role_not_allowed`
 * rather than downgrading the answer. Widen the credential first, then this map.
 */
const ROLE_MAP: Record<string, AgentRole> = {
  USER: 'end_user',          // branch/office staff — GUI click-paths, never commands
  ORG_ADMIN: 'l1',           // an org's own first-line support
  ADMINISTRATOR: 'l3',       // provider staff — deep technical detail
};

export const agentRoleFor = (platformRole: string): AgentRole => ROLE_MAP[platformRole] ?? 'end_user';

// ─── Config ──────────────────────────────────────────────────────────────────

// AGENT_BASE_URL is the name the agent's own useAPI.md tells integrators to use.
// It falls back to AGENT_URL because both name the same server — one origin, one
// port (8001). Keeping the fallback means a deployment that only ever set
// AGENT_URL does not silently point the signed calls at localhost.
const baseUrl = (): string => (env.AGENT_BASE_URL ?? env.AGENT_URL).replace(/\/+$/, '');

/** The `/v1/chat` integration is inert until both chat credentials are set. */
export const agentChatEnabled = (): boolean =>
  Boolean(env.AGENT_CHAT_CLIENT_ID && env.AGENT_CHAT_SECRET);

/** `/v1/top-complaints` uses a SEPARATE credential set from chat (dc-* vs ext-*). */
export const agentComplaintsEnabled = (): boolean =>
  Boolean(env.AGENT_COMPLAINTS_CLIENT_ID && env.AGENT_COMPLAINTS_SECRET);

// The deadline for one reply. The agent's guide asks for >= 180s because that is
// its own upstream ceiling; we deliberately run a much tighter budget (default 15s,
// AGENT_CHAT_TIMEOUT_MS) because a chat that answers in 15s or says so beats one
// that might answer in three minutes. Measured: short answers land in 0.2-5s, a
// long multi-step one took 18.9s — those are the replies this cuts off.
//
// ponytail: a deadline, not a fix for slow generation. The only real lever on
// answer LENGTH (and therefore time) lives on the agent side.
const CHAT_TIMEOUT_MS = env.AGENT_CHAT_TIMEOUT_MS;
// Complaints is a plain database read on the agent's side — no model involved.
const COMPLAINTS_TIMEOUT_MS = 15_000;

// ─── Signing ─────────────────────────────────────────────────────────────────

/**
 * Scheme B signature: hex(HMAC-SHA256(secret, `${timestamp}.${body}`)).
 *
 * The `.` separator is load-bearing — without it ("12" + "3body") and
 * ("123" + "body") hash identically. A GET has no body and signs the empty
 * string, i.e. the payload ends at the dot.
 *
 * Exported for tests: this is the one function whose failure mode is a flat 401
 * with no detail, so it is worth pinning to known vectors.
 */
export function signSchemeB(secret: string, timestamp: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

type Creds = { clientId: string; secret: string };

function signedHeaders(creds: Creds, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  return {
    'X-Client-Id': creds.clientId,
    'X-Timestamp': ts,
    'X-Signature': signSchemeB(creds.secret, ts, body),
  };
}

// ─── Errors ──────────────────────────────────────────────────────────────────

// The agent returns a stable machine code, `{"error": "<code>"}`. Surfacing that
// code verbatim (rather than a generic 502) is what lets a caller distinguish
// "widen my allowlist" from "retry in two seconds" — and errorHandler passes
// `status`/`code` straight through to the HTTP response.
type AgentError = Error & { status: number; code: string; retryAfter?: number };

function agentError(message: string, status: number, code: string, retryAfter?: number): AgentError {
  return Object.assign(new Error(message), { status, code, ...(retryAfter ? { retryAfter } : {}) });
}

// Our own credentials/clock/allowlist are the cause of these, not the caller's
// input. The agent reports them as 401/403 — which we must NOT pass through: the
// browser client redirects to /login on a 401 and to /403 on a 403, so relaying
// them would sign the user out (or strand them on access-denied) over a
// server-side misconfiguration their session had nothing to do with. They all
// become 502: the upstream rejected US.
const OUR_FAULT = new Set([
  'bad_timestamp', 'malformed_signature', 'stale_timestamp', 'bad_signature',
  'unknown_client', 'role_not_allowed',
]);

/**
 * The status the BROWSER should see — chosen for what the client must do about it,
 * not copied from the agent. The agent's own code always travels alongside in
 * `code`, so nothing is lost for diagnosis.
 */
function statusFor(code: string, transportStatus: number): number {
  if (OUR_FAULT.has(code)) return 502;
  // Genuinely transient: the interceptor surfaces 429 as a "try again" toast.
  if (code === 'rate_limited' || code === 'server_busy') return 429;
  // We build the body ourselves and zod-validate the role first, so these mean a
  // contract drift on our side rather than bad user input — still not the user's 400.
  if (code === 'bad_request' || code === 'bad_role') return 502;
  if (code === 'upstream_error') return 502;
  return transportStatus >= 500 ? 502 : 502;
}

function describe(code: string): string {
  if (code === 'role_not_allowed') return 'This assistant credential is not permitted to use that role';
  if (OUR_FAULT.has(code)) return 'The assistant rejected this server\'s credentials';
  if (code === 'rate_limited' || code === 'server_busy') return 'The assistant is busy — please try again shortly';
  if (code === 'upstream_error') return 'The assistant model is unavailable';
  return 'The assistant rejected the request';
}

// ─── Transport ───────────────────────────────────────────────────────────────

/**
 * One signed request. `body` is the EXACT string sent on the wire — it is signed
 * and transmitted without re-serialisation, because a re-serialised copy (different
 * key order or spacing) produces a signature over bytes the server never sees, and
 * every request 401s. This is the single most common way this integration breaks.
 *
 * Pass `null` for a GET: signs and sends no body.
 */
async function signedFetch(
  creds: Creds, path: string, body: string | null, timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: globalThis.Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method: body === null ? 'GET' : 'POST',
      headers: {
        ...signedHeaders(creds, body ?? ''),
        ...(body === null ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === null ? {} : { body }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    // A transport failure that returns in ~25ms is almost never "the agent is
    // down" — it is the self-signed certificate going untrusted because
    // NODE_EXTRA_CA_CERTS is missing from this process's environment.
    console.error(`[agentApi] ${path} transport failure${aborted ? ' (timeout)' : ' — if instant, suspect NODE_EXTRA_CA_CERTS / the self-signed cert'}:`, err);
    throw agentError(
      aborted
        ? `The assistant took longer than ${Math.round(timeoutMs / 1000)}s to answer — try asking for a shorter answer, or ask again`
        : 'The assistant is unavailable',
      503, aborted ? 'AGENT_TIMEOUT' : 'AGENT_UNAVAILABLE',
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

  if (!res.ok) {
    // `{"error": code}` is the documented shape; `{"detail": ...}` is what
    // /v1/top-complaints returns on an auth failure, so accept either.
    const code = (parsed as { error?: string; detail?: string } | null)?.error
      ?? (parsed as { detail?: string } | null)?.detail
      ?? 'AGENT_ERROR';
    const retryAfter = Number(res.headers.get('Retry-After')) || undefined;
    // Never let a non-200 disappear into a generic user-facing message: the agent's
    // own status + code is the whole diagnosis (403 role_not_allowed vs 429
    // server_busy vs 401 bad_signature) and it is unrecoverable after the fact.
    console.error(`[agentApi] ${path} failed: HTTP ${res.status} ${code}`);
    throw agentError(describe(code), statusFor(code, res.status), code, retryAfter);
  }
  return parsed;
}

/**
 * The agent serves one model request at a time and says so with 429 `server_busy`
 * rather than queueing us into a timeout. A single bounded retry, honouring
 * Retry-After, turns the common case (someone else's request finishing) into a
 * success instead of an error the user sees.
 *
 * ponytail: one retry, not a backoff ladder. Add more only if `server_busy`
 * actually surfaces to users under real concurrency.
 */
async function withBusyRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    const e = err as AgentError;
    if (e.code !== 'server_busy' && e.code !== 'rate_limited') throw err;
    const waitMs = Math.min((e.retryAfter ?? 2) * 1000, 10_000);
    await new Promise((r) => setTimeout(r, waitMs));
    return attempt();
  }
}

// ─── Serialization ───────────────────────────────────────────────────────────

/**
 * The agent processes ONE /v1/chat at a time across every client and role — a
 * second concurrent call is refused instantly with 429 `server_busy`, never
 * queued. So the queue has to live on this side: model calls run one at a time,
 * in arrival order, and a busy user waits instead of failing.
 *
 * The per-request timeout starts inside `signedFetch`, so time spent waiting for
 * the lane does not eat into the 180s model budget.
 *
 * TWO layers, because they solve different halves of the problem:
 *   1. `inLane` serializes calls WITHIN this process, in arrival order, with no
 *      network round trip per waiter.
 *   2. `withAgentLock` serializes the head of each process's queue ACROSS
 *      processes. Required from the moment more than one API instance exists —
 *      which containerization makes trivially easy to do by accident.
 *
 * With REDIS_URL unset, layer 2 is a pass-through and the behaviour is exactly
 * the single-process lane this replaced.
 */
let lane: Promise<unknown> = Promise.resolve();
function inLane<T>(run: () => Promise<T>): Promise<T> {
  const next = lane.then(run, run);
  lane = next.catch(() => undefined);
  return next;
}

const LOCK_KEY = 'b2b:agent:lane';
// Must exceed the longest a call can hold the lane, or the lock expires under a
// running request and a second process starts one — the exact breach this
// prevents. The +20s covers the wait for the agent's own response teardown.
const LOCK_TTL_MS = env.AGENT_CHAT_TIMEOUT_MS + 20_000;
const POLL_MS = 250;

// Release only if we still own it. A plain DEL would let a call that overran its
// TTL delete the NEXT holder's lock, silently allowing two concurrent requests.
const RELEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end
`;

async function withAgentLock<T>(run: () => Promise<T>): Promise<T> {
  if (!redis) return run();

  const token = crypto.randomUUID();
  const deadline = Date.now() + env.AGENT_CHAT_TIMEOUT_MS;

  for (;;) {
    let acquired: string | null = null;
    try {
      acquired = await redis.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');
    } catch {
      // Redis went away mid-wait. The in-process lane still holds for this
      // instance, and refusing the request outright would be a worse failure
      // than the cap it protects — proceed unlocked.
      return run();
    }
    if (acquired) break;

    if (Date.now() >= deadline) {
      throw agentError(
        'The assistant is busy with another request — please try again in a moment',
        503, 'AGENT_BUSY',
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  try {
    return await run();
  } finally {
    // Best-effort: if this throws, the TTL releases the lane anyway.
    try { await redis.eval(RELEASE, 1, LOCK_KEY, token); } catch { /* TTL covers it */ }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface AgentChatReply { reply: string; role: AgentRole }

/**
 * `POST /v1/chat` — one question, one answer, scoped to an audience role.
 * No history: the agent's signed surface is stateless, so each call stands alone.
 */
export async function agentChat(message: string, role: AgentRole): Promise<AgentChatReply> {
  if (!agentChatEnabled()) {
    throw agentError('The assistant API is not configured', 503, 'AGENT_NOT_CONFIGURED');
  }
  const creds = { clientId: env.AGENT_CHAT_CLIENT_ID!, secret: env.AGENT_CHAT_SECRET! };

  const send = async (as: AgentRole): Promise<AgentChatReply> => {
    // Serialised once, here — this exact string is both signed and sent.
    const body = JSON.stringify({ message, role: as });
    const data = await inLane(() =>
      withAgentLock(() => withBusyRetry(() => signedFetch(creds, '/v1/chat', body, CHAT_TIMEOUT_MS))));
    const reply = (data as { reply?: unknown } | null)?.reply;
    if (typeof reply !== 'string') throw agentError('The assistant returned an unreadable reply', 502, 'AGENT_MALFORMED');
    return { reply, role: as };
  };

  try {
    return await send(role);
  } catch (err) {
    // A role can be perfectly valid and still be outside THIS credential's
    // allowed-roles list — the agent answers 403 role_not_allowed. Measured on
    // ext-55df9387: only `end_user` is granted, so every ORG_ADMIN (l1) and
    // ADMINISTRATOR (l3) chat used to fail outright and left an orphan user turn
    // in chat history. Falling back gives them a working assistant with
    // end-user-scoped guidance, and the richer role resumes on its own the moment
    // the agent's administrator widens the credential — no redeploy.
    if ((err as AgentError).code !== 'role_not_allowed' || role === 'end_user') throw err;
    console.error(`[agentApi] role "${role}" not allowed for this credential — answering as end_user; widen the credential's allowed-roles list to restore role-scoped answers`);
    return send('end_user');
  }
}

export interface ComplaintCategory { category: string; count: number }
export interface TopComplaints {
  complaints: ComplaintCategory[];
  /** Sum of the returned categories' counts. */
  total: number;
  fetchedAt: string;
}

/**
 * `GET /v1/top-complaints` — the highest-volume ticket categories, plus their total.
 *
 * Returns however many the agent sends (documented as up to seven) rather than
 * padding or truncating to a fixed length: a hardcoded slice count would either
 * invent empty rows or silently hide a category if the agent's cap ever changes.
 * `total` sums exactly the rows returned, so the figure always matches the list
 * beside it — it is NOT a count of all tickets ever raised.
 */
export async function topComplaints(): Promise<TopComplaints> {
  if (!agentComplaintsEnabled()) {
    throw agentError('The complaints API is not configured', 503, 'AGENT_NOT_CONFIGURED');
  }
  const creds = { clientId: env.AGENT_COMPLAINTS_CLIENT_ID!, secret: env.AGENT_COMPLAINTS_SECRET! };
  // GET: null body signs the empty string, i.e. `${ts}.` with nothing after the dot.
  const data = await signedFetch(creds, '/v1/top-complaints', null, COMPLAINTS_TIMEOUT_MS);

  const raw = (data as { top_complaints?: unknown } | null)?.top_complaints;
  if (!Array.isArray(raw)) throw agentError('The complaints API returned an unreadable payload', 502, 'AGENT_MALFORMED');

  const complaints: ComplaintCategory[] = raw
    .map((r) => r as { category?: unknown; count?: unknown })
    .filter((r) => typeof r.category === 'string' && Number.isFinite(Number(r.count)))
    .map((r) => ({ category: r.category as string, count: Number(r.count) }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  return {
    complaints,
    total: complaints.reduce((sum, c) => sum + c.count, 0),
    fetchedAt: new Date().toISOString(),
  };
}
