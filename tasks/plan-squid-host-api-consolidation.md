# Squid Host API Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared, audited machine-auth path for every host-to-platform API surface (squid agent + host bot), removal of the dead duplicate surface, and a single canonical contract document for Squid host operators.

**Architecture:** Extract the two near-identical inline HMAC verifiers (`agentAuth`, `workerAuth`) into `server/src/lib/machineAuth.ts` — a configured middleware factory plus a pure verification function — consumed by both routers with unchanged wire behavior (A2, A3). Enable the existing-but-unused `regKeyHash` guard on the agent path (A4). Delete the caller-less `/api/squid-web` router (A5). Consolidate documentation (A6–A8) and add an opt-in nginx mTLS profile (A9).

**Tech stack:** Express, Node `crypto`, existing `lib/redis` (ioredis), vitest, Prisma (no schema change).

**Spec:** [docs/decisions/ADR-003-squid-host-api-consolidation.md](../docs/decisions/ADR-003-squid-host-api-consolidation.md)

## Global Constraints

- **Wire format is frozen.** Canonical string exactly `${ts}\n${METHOD}\n${path}\n${sha256(rawBody)}`; timestamp = epoch **milliseconds**; acceptance window `Math.abs(Date.now() - ts) > 300_000 → reject` (boundary value 300_000 accepted). No path or header changes anywhere.
- Headers stay exactly as deployed: agent → `X-Proxy-Id: <proxyId>`, `X-Proxy-Timestamp: <ts>`, `Authorization: Bearer <hex>`; bot → URL param `:botId`, `X-Worker-Timestamp: <ts>`, `Authorization: Bearer <hex>`.
- Signature always covers `req.originalUrl` (the string the Python client signs as `path`) and the **exact raw body bytes** — never a re-serialized JSON body (`app.ts` line ~74 stores `rawBody` before parsing; keep that).
- All comparisons constant-time (`timingSafeEqual`, length-checked first); no secret (key, HMAC, token) is ever logged.
- `cd server && npx tsc --noEmit` clean after every code task; existing suites `squid-agent-hmac.test.ts` and `bot-worker.test.ts` must pass **unmodified**.
- New unit tests must run **without Postgres** (pure functions only); integration behavior is pinned by the existing suites.
- Repo follows its own conventions: plans live in `tasks/`, decisions in `docs/decisions/`.

## Review Focus

Inputs the spec implies but no task's integration tests exercise; each is pinned by a named unit test:

1. **GET with no body** (agent `GET /poll`) — signature must verify when the body hash is over empty bytes. → Task 1 `verify: empty body (GET)`.
2. **Timestamp at the boundary** — 300_000 ms accepted, 300_001 rejected. → Task 1 `verify: replay window boundary`.
3. **Query string on a machine path** — signature covers `originalUrl` *including* any query string; a host appending `?x=1` after signing is rejected. → Task 1 `verify: query string is signed`.
4. **Ciphertext/hash divergence** — a tampered `regKeyEncrypted` that decrypts to a key whose SHA-256 differs from the stored hash column must 401. → Task 4 `agent: regKeyHash divergence rejects`.
5. **Counter reset on success** — 4 consecutive bad signatures must NOT auto-disable if the 5th attempt signs correctly. → Task 1 `counter: success resets the streak`.
6. **Identical replay of a change request** — same host re-submitting the same whitelisting within the 5-minute window must receive the original ticket receipt, not a second ticket. → Task 10 `duplicate identical /request within the window returns the original receipt`.

---

### Task 1: Shared machine-auth module `server/src/lib/machineAuth.ts`

**Files:**
- Create: `server/src/lib/machineAuth.ts`
- Test: `server/tests/machineAuth.test.ts`

**Interfaces:**
- Consumes: `import { redis } from '../lib/redis'` (nullable when `REDIS_URL` unset — same pattern as `services/agentApi.ts`).
- Produces (used by Tasks 2, 3, 4):

```ts
export const MAX_BAD_AUTH = 5;
export const REPLAY_WINDOW_MS = 300_000;

export function canonicalMachineString(ts: string, method: string, path: string, bodySha256Hex: string): string;
// -> `${ts}\n${method.toUpperCase()}\n${path}\n${bodySha256Hex}`

export function verifyMachineSignature(input: {
  tsMs: number;             // parsed timestamp header value
  sig: string;              // raw hex without "Bearer "
  secret: string;           // decrypted raw machine key
  secretHash?: string | null; // sha-256 hex of the raw key from its hash column, if the table has one
  method: string;           // req.method
  path: string;             // req.originalUrl
  rawBody?: Buffer;         // undefined for an empty/GET body
  nowMs?: number;           // injectable clock for tests (defaults Date.now())
}): { ok: true } | { ok: false; code: 'BAD_TIMESTAMP' | 'BAD_SIGNATURE' | 'KEY_DIVERGED' };

export interface MachineActor<TCtx> {
  actorId: string;
  context: TCtx;                 // attached to req under `reqKey` on success
  secretHash?: string | null;    // sha-256 hex of the raw secret from its hash column, when the table has one
}
// `loadActor` returns null when the actor or its key columns are missing or the
// columns diverge — every null leads to the same generic 401 (wire stability).
export interface MachineAuthConfig<TCtx> {
  actorIdOf: (req: Request) => string;
  timestampHeader: string;                    // 'X-Proxy-Timestamp' | 'X-Worker-Timestamp' — factory parses it (NaN-safe)
  loadActor: (actorId: string) => Promise<MachineActor<TCtx> | null>;
  reqKey: string;                             // 'proxy' | 'workerBot' — property set on req
  authFailedCode: string;                     // 'PROXY_AUTH_FAILED' | 'WORKER_AUTH_FAILED'
  auditAction: string;                        // 'SQUID_AGENT_AUTH_FAILED' | 'WORKER_AUTH_FAILED'
  onBruteForceDisable: (actorId: string) => Promise<void>;
}
export function createMachineKeyAuth<TCtx>(cfg: MachineAuthConfig<TCtx>): RequestHandler;
// Behavior: 401 { error: 'Authentication failed', code: cfg.authFailedCode } for:
// missing actorId, or a null loadActor result (missing/undecryptable/diverged
// keys all collapse here). For a present actor: verification failures surface
// the codes produced by verifyMachineSignature (BAD_TIMESTAMP / BAD_SIGNATURE /
// KEY_DIVERGED) in place of the cfg default. On BAD_SIGNATURE: bump the shared
// badAuthCounter, audit { reason: 'signature mismatch', ip: req.ip, attempts: n }
// (the agent router audits org context first — preserved by the router), and at
// MAX_BAD_AUTH: reset counter + await cfg.onBruteForceDisable(actorId). Every
// 401 sent by the factory sets res.locals['machAuthFailed'] = { actorId, code }
// BEFORE responding, so a router that needs richer org-aware auditing can run
// its own audit from that flag (botWorker does). On success: reset counter, set
// req[cfg.reqKey] = context, next().
export const badAuthCounter: { bump(id: string): Promise<number>; reset(id: string): Promise<void> };
// In-memory Map when redis is null; otherwise INCR 'b2b:machauth:bad:<id>' with
// 10-minute EXPIRE, DEL on reset. On a redis error mid-bump: fall back to the
// in-memory Map for that call (never throw).
```

**Contract decisions fixed here:**
- `MachineActor` carries a `keyMissing?: true` flag; the factory's 401 for a missing
  key uses `<cfg.authFailedCode>` unchanged (both routers today return the generic
  code, not dedicated ones) — do not invent new codes (AH: wire stability).
- The agent router currently audits with `customerId` from the proxy row; that
  stays the router's job — `createMachineKeyAuth` audits only actorId/ip/attempts.

- [ ] **Step 1: Write the failing unit test** (`server/tests/machineAuth.test.ts`, imports only `machineAuth.ts` — no DB, no app). Table-driven, at minimum:
  - `canonical`: known vector `canonicalMachineString('1000','POST','/api/proxy-agent/result','abc') === '1000\nPOST\n/api/proxy-agent/result\nabc'`.
  - `verify: valid` — round-trip HMAC over a real key + body verifies `{ok:true}`.
  - `verify: empty body (GET)` — `rawBody` undefined signs sha256 of empty string; server verify still `{ok:true}`.
  - `verify: tampered body` — one flipped byte after signing → `BAD_SIGNATURE`.
  - `verify: replay window boundary` — `nowMs = ts + 300_000` → ok; `nowMs = ts + 300_001` → `BAD_TIMESTAMP`.
  - `verify: query string is signed` — path with `?x=1` signed, verified without it → `BAD_SIGNATURE`.
  - `verify: KEY_DIVERGED` — secretHash provided and mismatching → `KEY_DIVERGED` even though the signature is valid.
  - `counter: success resets the streak` — 4 bumps then `reset`, bump again → 1 (not 5).
  - `counter: falls back to memory` — construct with redis null (default in the unit env) and assert identical behavior.
- [ ] **Step 2: Run it to verify it fails** — `npm --prefix server test -- machineAuth` → FAIL (module not found).
- [ ] **Step 3: Implement `server/src/lib/machineAuth.ts`** exactly to the interface above. Body of `verifyMachineSignature` is the extract of the existing two inlines (canonical → HMAC → length-checked `timingSafeEqual`), plus the window check and hash cross-check.
- [ ] **Step 4: Run the test to verify it passes** — `npm --prefix server test -- machineAuth` → PASS.
- [ ] **Step 5: Typecheck** — `cd server && npx tsc --noEmit` → clean.
- [ ] **Step 6: Commit** — `git add server/src/lib/machineAuth.ts server/tests/machineAuth.test.ts && git commit -m "feat(security): shared machine-key auth module (machineAuth)"`.

### Task 2: Migrate `squid-agent.routes.ts` to the shared module

**Files:**
- Modify: `server/src/modules/squid/squid-agent.routes.ts` (replace `agentAuth` body, delete its local `badAuthCount`/`sha256`)
- Test (existing, must pass unmodified): `server/tests/squid-agent-hmac.test.ts`

**Interfaces:**
- Consumes: `createMachineKeyAuth`, `MAX_BAD_AUTH` from Task 1.
- Produces: route exports unchanged; `req.proxy` context preserved (same `AuthedProxy` shape).

Config wiring for this router: `actorIdOf` → `req.get('X-Proxy-Id')`; `timestampHeader: 'X-Proxy-Timestamp'` (factory reads + parses); `loadActor` → find proxy incl. customer name, decrypt `regKeyEncrypted`, return `{ actorId, context: AuthedProxy }`; `reqKey: 'proxy'`; `authFailedCode: 'PROXY_AUTH_FAILED'`; `auditAction: 'SQUID_AGENT_AUTH_FAILED'`; `onBruteForceDisable` → existing `autoDisable(proxyId)`.
Hash cross-check is deliberately **not** wired yet — Task 4 owns it so its failure mode gets its own review.

- [ ] **Step 1: Baseline** — `npm --prefix server test -- squid-agent-hmac` → PASS (record: suite is green before touching the router).
- [ ] **Step 2: Replace the inline auth** with one `createMachineKeyAuth` call + `export const agentAuth = <that handler>`; keep `autoDisable` and `AuthedProxy` as-is; every `agentAuth`-consuming route untouched. Audit metadata gains `attempts: n` (it already has it — keep).
- [ ] **Step 3: Run the suite** — `npm --prefix server test -- squid-agent-hmac` → PASS, unmodified file proving wire behavior is intact.
- [ ] **Step 4: Typecheck** — `cd server && npx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** — `git commit -am "refactor(security): squid agent auth through shared machineAuth"`.

### Task 3: Migrate `botWorker.routes.ts` to the shared module

**Files:**
- Modify: `server/src/modules/slack-bots/botWorker.routes.ts` (`workerAuth` body → factory call; delete local `badAuthCount`/`sha256`; keep `requireWorkerMode` untouched)
- Test (existing, must pass unmodified): `server/tests/bot-worker.test.ts`

**Interfaces:**
- Consumes: `createMachineKeyAuth` from Task 1.
- Produces: `workerAuth` export survives (same name/signature) because the ops status route and service code reference it.

Config wiring: `actorIdOf` → `req.params['botId'] ?? ''`; `timestampHeader: 'X-Worker-Timestamp'`; `loadActor` → find bot selecting `workerKeyHash`/`workerKeyEnc`/etc., decrypt, run the **existing hash equality check** (constant-time) inside `loadActor` and return null on mismatch (preserves today's 401 behavior); `reqKey: 'workerBot'`; `authFailedCode: 'WORKER_AUTH_FAILED'`; `auditAction: 'WORKER_AUTH_FAILED'`. This router audits with `customerId` from `slackBotOrg` before responding; keep that behavior: wrap the factory handler and, when `res.locals['machAuthFailed']` is set (the factory's flag on any 401), emit the org-aware audit exactly as the current inline does.
`onBruteForceDisable` → `prisma.slackBot.update({ enabled: false })`.

- [ ] **Step 1: Baseline** — `npm --prefix server test -- bot-worker` → PASS.
- [ ] **Step 2: Replace the inline auth** per the wiring above; keep the brute-force org audit observable (unit-verifiable via the factory's `res.locals` flag).
- [ ] **Step 3: Run the suite** — `npm --prefix server test -- bot-worker` → PASS unmodified.
- [ ] **Step 4: Typecheck** — `cd server && npx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** — `git commit -am "refactor(security): bot-worker auth through shared machineAuth"`.

### Task 4: Enable the `regKeyHash` cross-check on the agent path

**Files:**
- Modify: `server/src/modules/squid/squid-agent.routes.ts` (Task 2's `loadActor`: select `regKeyHash`, pass it to Task 1's `verifyMachineSignature` via the factory — add `secretHash` passthrough to `MachineActor`)
- Test: `server/tests/squid-agent-hmac.test.ts` (one new case)

**Interfaces:**
- Consumes: Task 1 `verifyMachineSignature` `secretHash` input and `MachineActor.secretHash` (already defined in Task 1); existing `squidProxies.regKeyHash` column (already in `server/db/2026-09-17-squid-proxy.sql`, no migration).

- [ ] **Step 1: Write the failing test** — append `agent: regKeyHash divergence rejects` to `squid-agent-hmac.test.ts`: seed a proxy with `regKeyEncrypted` decrypting to key `K`, `regKeyHash` = sha256 of a *different* key; a correctly signed request must get **401** (`PROXY_AUTH_FAILED`) and no route handler work.
- [ ] **Step 2: Run it** → FAIL (auth currently succeeds).
- [ ] **Step 3: Implement** — in Task 2's config, `loadActor` selects `regKeyHash` and returns it as `MachineActor.secretHash`; the shared verifier applies the cross-check.
- [ ] **Step 4: Run the suite** — full `squid-agent-hmac` → PASS (old cases green, new case green).
- [ ] **Step 5: Typecheck + commit** — `git commit -am "fix(security): verify agent reg key against regKeyHash"`.

### Task 5: Delete the dead `/api/squid-web` surface

**Files:**
- Modify: `server/src/app.ts` (remove import + mount at lines 39/144)
- Delete: `server/src/modules/squid/squid-web.routes.ts`

- [ ] **Step 1: Prove zero callers** — `grep -rn "squid-web" server/src client/src deploy` must return only `app.ts` lines and the file's own comments (verified at planning time: no client or agent caller; `slackWebhook` post stays, it lives in `slackWebhook.ts`, not the route file).
- [ ] **Step 2: Delete the file and its mount**; keep `postProxyChangeNotification` imports working for other users (`squid.controller.ts` may import it — leave `slackWebhook.ts` alone).
- [ ] **Step 3: Verify** — `cd server && npx tsc --noEmit` clean; `npm --prefix server test` full run → PASS (nothing references the router).
- [ ] **Step 4: Commit** — `git commit -am "refactor: remove dead /api/squid-web surface (no callers, duplicated logic)"`.

### Task 6: Correct the doc drift in `docs/Squid-bot-Web.md`

**Files:**
- Modify: `docs/Squid-bot-Web.md`

- [ ] **Step 1: Rewrite §9 "Status"** to reality: platform API + host bot phases 1–4 **implemented** (per `tasks/plan-squid-bot-integration.md` §6); SLACK_THIN worker deployment remains open.
- [ ] **Step 2: Extend §3 "connection surface" table** with the SQUID_BOT dialect rows (`request`, `state`, `command-result`, mode gates, `GET /:botId/status`) and a pointer to the new contract doc `docs/squid-host-api.md` (Task 7) for the auth scheme (removing the dual-"Scheme B" confusion: state explicitly that `agentApi.ts`'s `${ts}.${body}` variant belongs to the analytics agent API, not this integration).
- [ ] **Step 3: Add ADR-003 to the header links.**
- [ ] **Step 4: Commit** — `git commit -am "docs: Squid-bot-Web.md to the web-first, SQUID_BOT-dialect reality"`.

### Task 7: Canonical contract doc `docs/squid-host-api.md`

**Files:**
- Create: `docs/squid-host-api.md`

Sections (all values verbatim from the constraints above):

- [ ] **Step 1: Auth scheme spec** — canonical string, ms timestamps, ±5 min window (boundary-admissible), constant-time compare, `Authorization: Bearer <hex>`, header names per actor, raw-body coverage rule, no-query-string rule (hosts append nothing after signing). Include a green/known test vector snippet imported from `server/tests/machineAuth.test.ts` so doc and tests cannot diverge silently (cross-reference the file).
- [ ] **Step 2: Actor table** — proxy agent (`pk_` reg key, auto-disable → `squidProxies.status = DISABLED`) vs host bot (`wrk_` key, hash cross-check, auto-disable → `slackBots.enabled = false`, 5 strikes); dialect gate codes `BOT_MODE_SLACK_THIN` / `BOT_MODE_SQUID` (409).
- [ ] **Step 3: Endpoint tables** — `/api/proxy-agent/*` (public-key, poll, result, telemetry, ticketing-config) and `/api/bot-worker/:botId/*` (provision, heartbeat, message, request, state, command-result, status) with request/response shapes copied from the existing zod schemas + plan §5.1–5.4.
- [ ] **Step 4: Key lifecycle** — mint once (admin UI, shown once), rotate (revoke → new key → restart), revoke (client 401s on next call); storage: AES-256-GCM `*Enc` + sha-256 `*Hash` columns; never committed, `0600` on host.
- [ ] **Step 5: Transport & ops** — nginx TLS profile pointer (Task 9), `/health` self-check, error-code list, brute-force behavior, audit actions (`SQUID_AGENT_AUTH_FAILED`, `WORKER_AUTH_FAILED`, `SQUID_CHANGE_*`).
- [ ] **Step 6: Commit** — `git commit -am "docs: canonical squid host API contract"`.

### Task 8: Materialize `squid/squid-bot/INTEGRATION.md`

**Files:**
- Create: `squid/squid-bot/INTEGRATION.md` (content per `docs/s6_phases_s1_s2_s3.md` §S2 — key mint/rotate/revoke procedures, first-install sequence incl. `install-seam.sh` + `/etc/squid-bot/env` 0600, `/state` semantics incl. at-least-once redelivery + 15-min ack timeout + late-ack recovery, failure runbook table)

- [ ] **Step 1: Write the file** from the S2 table (that content is already approved and complete — this materializes it next to the vendored bot where `install-seam.sh` and `.env.example` live).
- [ ] **Step 2: Cross-link** — README.md → INTEGRATION.md; `docs/squid-host-api.md` links back for key minting.
- [ ] **Step 3: Commit** — `git commit -am "docs(squid-bot): vendored INTEGRATION.md (ops lifecycle + runbook)"`.

### Task 9: Opt-in mTLS profile in nginx

**Files:**
- Modify: `deploy/nginx/b2b-site.conf` (commented block only)
- Modify: `deploy/nginx/https-nginx.sh` (optional `--mtls-cert <dir>` hook wiring `ssl_client_certificate`)

- [ ] **Step 1: Add a fully commented `# mTLS profile (opt-in)` block** after both machine locations: `ssl_verify_client optional;` + `ssl_client_certificate /etc/nginx/ca-squid-clients.crt;` + a comment that with mTLS enabled the HMAC ships unchanged (defense in depth; ADR-003 §6) and how to make it `required` per-location once all hosts carry certs. `optional` keeps the profile zero-risk when uncommented partially.
- [ ] **Step 2: Verify config remains valid as-is** — `nginx -t` (profile commented) → syntax ok, no server restart performed beyond the deploy script's own flow.
- [ ] **Step 3: Reference from Task 7's doc** — “Transport & ops” section gains the activation steps (CA generation, distributing client certs to hosts, nginx reload, verification curl with `--cert/--key`).
- [ ] **Step 4: Commit** — `git commit -am "ops: opt-in mTLS profile for squid machine API endpoints"`.

### Task 10: Idempotent change-request door (anti-replay)

**Files:**
- Modify: `server/src/modules/squid/squidBot.service.ts` (`submitChange` dedupe layer) or `server/src/modules/squid/squid.service.ts#createChangeRequest` — whichever the machine door funnels through; verify the web door's behavior in the test so both converge
- Test: append to `server/tests/squid-bot.test.ts`

**Interfaces:**
- Consumes: Redis-or-null pattern from `server/src/lib/redis` as used by `services/agentApi.ts`.
- Produces: `submitChange(...)` returns the **original** receipt `{ ticketId, ticketNumber, status, webUrl, changeRequestId }` when an identical request body from the same bot arrives within `REPLAY_WINDOW_MS` (300_000). No new response shape, no new error code.

**Design fixed here (why not a signature-digest replay cache):** `platform_client/client.py` legitimately re-sends identical bytes under identical signatures for `command-result` retries — rejecting seen signatures would break ack delivery. So dedupe lives on the *write door*, keyed by the semantic content, not the wire bytes: `sha256(botId + '\n' + JSON.stringify({ type, payload, requester }))` stored via Redis `SET NX PX 300000` (10-min slack is fine; window must be ≥ the replay window). Key collision → fetch the stored original receipt from `SquidChangeRequest` by the request id recorded in the redis value and return it verbatim; a redis error → proceed as today (fail open, like the agent lane lock). No race between "miss then find original" is possible because only SETNX winners create.

- [ ] **Step 1: Write the failing test** — `duplicate identical /request within the window returns the original receipt`: post the same `{type:'allow', payload, requester}` twice; both responses 201 with the **same** `ticketId`/`changeRequestId`; `SquidChangeRequest` has exactly one row; a *different* payload (same everything else) still creates a second request.
- [ ] **Step 2: Run it** — `npm --prefix server test -- squid-bot` → FAIL (second call creates a second ticket/CR).
- [ ] **Step 3: Implement** the dedupe layer per the design above, inside the machine funnel path so the web door is untouched in behavior (verify: web door creating a legitimately new request right after the bot's identical one is unaffected — different botId key).
- [ ] **Step 4: Run the suite** → PASS (all 16 prior cases + 2 new).
- [ ] **Step 5: Typecheck + commit** — `git commit -am "fix(security): idempotent change-request door (replay returns original receipt)"`.

---

## Definition of done

- `cd server && npx tsc --noEmit` clean.
- `npm --prefix server test` green where a provisioned DB exists; `machineAuth` + `squid-agent-hmac` + `bot-worker` suites pass regardless (pure units where possible).
- No wire change: concatenated diff of both routers shows handler bodies collapsed, headers/canonical/responses untouched.
- `/api/squid-web` gone with zero references.
- `docs/squid-host-api.md` + corrected `Squid-bot-Web.md` + vendored `INTEGRATION.md` exist and cross-link ADR-003.
- nginx config validates with the profile commented.

## Risks / mitigations

| Risk | Mitigation |
|---|---|
| Refactor subtly changes a 401 body/code | Both existing suites are byte-locked in this plan (unmodified pass required) |
| Replay of identical signed bytes within the 5-min window (middlebox with broken TLS re-submits `/request`, creating a duplicate ticket) | Task 10: the change-request door is idempotent — identical `(botId, type, payload)` within the window returns the original receipt; no naive sig-digest replay cache, which would break `client.py`'s legitimate identical-bytes ack retries |
| Redis counter changes brute-force timing | Redis path falls back to memory on error, mirrors `agentApi` lane pattern; threshold unchanged at 5 |
| Deleting `/api/squid-web` breaks an unknown consumer | Step 1 grep gate; zero callers at planning time; nginx paths for it never existed |
| Doc contract diverges from code over time | Task 7 imports its test vector from the unit test file, cross-reference enforced in review |
