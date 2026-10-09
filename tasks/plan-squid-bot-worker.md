# Implementation Plan: Squid bot host worker + Squid config-change control plane + hardening

> ⚠️ **SUPERSEDED for the Squid bot** by
> [`plan-squid-bot-integration.md`](plan-squid-bot-integration.md) (2026-10-08): a real,
> self-contained Python bot now lives at `squid/squid-bot/`, so building a new TypeScript
> host worker (`Phase A` here) is no longer needed and execution is performed *by the bot*
> (not the agent). This document remains valid as the **ADR-002 thin-worker / platform-side
> spec** and for the general approval-gated change-flow concepts that the revised plan reuses.

> Governing decision records: [ADR-002 — Remote Slack bot workers](../docs/decisions/ADR-002-remote-slack-bot-workers.md),
> and the connection spec in [`docs/Squid-bot-Web.md`](../docs/Squid-bot-Web.md).
> User decisions (2026-10-08): **Node.js + TypeScript** worker; **Option A** (extend the
> existing squid agent) for executing approved config changes.

## Overview

Three deliverables, one plan:

1. **Phase A — Production host-side worker** (`squid-bot-worker`). The missing half of
   ADR-002: the thing that runs on client infrastructure, holds the live Socket Mode
   connection, calls `/api/bot-worker` home, and can be told to die. Platform API side is
   done (routes/service/schema/migration + unrun tests); the worker is the other side of
   that wire.
2. **Phase B — Squid config changes through the ticket + approval path.** Today every Squid
   config change (ACL branch edit, port change, full-access flip) applies **immediately**:
   the platform bumps `revision` and the agent picks the change up on its next poll
   (`squid.service.ts:279`, `:739`). There is no approval gate, and no path for host-level
   actions (editing external files like `/etc/squid/allowed_domains.txt`, an ad-hoc
   `squid -k reconfigure`, a restart). This phase routes *requested* changes through the
   existing ticket state machine — a request creates a `pending:approval` ticket, the same
   Slack approval cards and `approveTicket`/`declineTicket` atoms decide it, and only an
   approval executes anything. Execution goes through the **existing agent** (Option A), not
   the Slack worker, so the worker never gets root-level Squid privileges.
3. **Phase C — Hardening.** Concrete fixes to the bot-worker API and the worker itself
   (provision race, command injection surface, vault key derivation, replay window, brute
   force, rotation challenge, logging policy, instance persistence, wipe durability).

## Current Behaviour (verified, not assumed)

| # | Area | Where | Today | Gap this plan closes |
|---|---|---|---|---|
| 1 | Bot host worker | `deploy/` | The squid agent (`deploy/agents/squid/`) is the only host-side process: it polls `/api/proxy-agent/poll`, applies signed bundles, acks via `/result`, pushes `/telemetry`. | No host-side Slack worker exists. `botWorker.routes/service` are implemented but only exercised by unrun tests. |
| 2 | Bot control API | `server/src/modules/slack-bots/botWorker.*` | 3 endpoints (`provision`/`heartbeat`/`message`), `wrk_` key + Scheme-B HMAC, 5-min window, per-bot brute-force disable after 5 failures, one-time provision gate, `disable`/`rotated` commands in heartbeat response. | Hardening table (§3) — provision re-race, rotation challenge, command echo, IP rate-limit, status endpoint, force re-provision. |
| 3 | Squid config apply | `server/src/modules/squid/squid.service.ts`, `deploy/agents/squid/*` | Edits bump `revision`; `agentPoll` renders + signs a bundle for `revision > appliedSeq`; agent validates `squid -k parse` → `squid -k reconfigure` → monotonic ack. Default-deny lock exists. | No **approval gate** on changes. No **generic host-command channel** (external file edits, ad-hoc reconfigure/restart). |
| 4 | Approval machinery | `server/src/modules/ticketing/ticketing.service.ts`, `server/src/modules/slack-bots/slackApprovals.ts` | Tickets with label `pending:approval` + status `todo` are decided atomically by `approveTicket` → `in_progress` / `declineTicket` → `declined` (both `WHERE labels has 'pending:approval' AND status='todo'`). Slack cards post via `notifyApprovalForExternalTicket`, *only* in the external-ticket create path, when assignee is a bot persona and the org has an `approvalChannelId`. | Cards work for our own org-created requests too — we must call the (already exported) `notifyApprovalForExternalTicket` after creating our ticket. Approving a ticket has **no side effects today** — nothing runs on approval. |
| 5 | Approval decisions | `slackApprovals.ts` (platform path), `botWorker.service.ts:195` (host-worker path) | Both paths funnel into the same `approveTicket`/`declineTicket`. | Approval → execution must hook *once*, downstream of both doors. |

## Architecture Decisions

### D1. Worker lives at `deploy/agents/squid-bot-worker/` (Node.js + TypeScript)

Sits beside the existing agent; shares the deployment/ops conventions
(`install.sh`, `systemd/`, `.env.example`, README). Node LTS (18+, target **20**) is fine on
the Squid host: the agent already requires a Python runtime, and the platform stack is
node/TS so `botWorker.schema.ts` types and `@slack/socket-mode` slot in directly. A Go static
binary is a documented follow-on if a customer host cannot run Node.

### D2. Execution of approved config changes → Option A (existing squid agent)

The worker is the **Slack** connection, nothing else. Actually executing Squid changes belongs
to the agent that already renders/validates/reloads — it holds the key to `squid -k`, it
already knows how to write `/etc/squid/acls/*` safely, and it is covered by the
revision/seq monotonic-ack machinery. Giving the Slack worker the same ability would hand a
Slack-facing process root Squid privileges. (Alternative B rejected.)

### D3. Two execution paths, one approval gate

| Request type | Execution path |
|---|---|
| ACL rules via branches (`add domain|ip|user`, `remove`, `replace`) | **Bundle path:** mutate the target branch, `bumpRevision` (`squid.service.ts:279`), let `agentPoll` deliver the signed bundle. No new host surface. |
| Host-level actions (`externalFile` edit, `reconfigure`, restart) | **Command path:** new agent command channel — `pendingCommand` rides the poll response, a new `/command-result` acks it, agent scripts learn a small allowlisted command set. |

Both paths are gated identically: the change is recorded in a `SquidChangeRequest` row at
request time, created as a `pending:approval` ticket, and **executed idempotently exactly once
on approval** (`executedAt` flag). Decline → ticket `declined`, request stays unexecuted.

### D4. Approval → execution via a lifecycle hook, not module coupling

`ticketing.service` gains `registerOnTicketApproved(handler)`; `squidControl.service`
(located in `server/src/modules/squid/`) registers its executor at bootstrap. `approveTicket`
calls registered handlers after a successful transition. This keeps the ticketing module free
of any squid import, both Slack doors (`slackApprovals.ts`, `resolveWorkerBlockAction`) and
the web-UI door all land in the same hook, and the executor never has to know where the
approval came from.

### D5. Structured request payload in a new table, not ticket metadata

A `SquidChangeRequest` table (one row per request, `ticketId` unique) holds the structured
payload (`action`, `target`, `value[]`, `externalFile`, `reason`, `executionPath`,
`status`, `executedAt`, `result`). The ticket keeps its normal title/description/labels so
the existing UI and Slack cards render unchanged; the table carries what the executor needs.
No schema mutation to the external ticketing store.

### D6. Worker token handling follows ADR-002 §4 with hardened derivation

`WORKER_TOKEN_SECRET` (required, no fallback) + per-bot scrypt salt → AES-256-GCM; ciphertext
(+IV+tag+salt) in `tokens.enc`, plaintext only in memory. `disable`/wipe is synchronous and
`fsync`'d; exit code is nonzero if the wipe fails (systemd alerts). InstanceId persisted so a
crash/restart is the same instance, not a new one.

### D7. Hardening table from the brief — accepted as described

Severities as given; all tracked in Phase C with exact touch points (see Phase C).

## Dependency Graph

```
Phase A (worker, standalone)                    Phase B + C (platform + agent)
─────────────────────────────                   ───────────────────────────────
scaffold → vault → auth → client                B-schema (SquidChangeRequest) ──┐
        → slack → worker loop → systemd         B-service (squidControl)    ◄───┘
        → smoke harness                          B-lifecycle hook (register...) 
                                                  ├── B-executor ─ bundle path ──► squid.service
                                                  ├── B-executor ─ command path ─► squid-agent.routes ─► agent script
                                                  ├── B-web form (needs [id] route)
                                                  └── B-tests

Phase C touches botWorker.routes/service + worker vault/auth independently of B
(no shared code; C1/C6 share the provision flow, sequenced together).
```

Phases A and B are independent. C depends on B only for the worker-side (same repo tree,
different files) — C can land in any order after A's auth/vault exist.

## Task List

### Phase A — Host-side worker (`deploy/agents/squid-bot-worker/`)

Files (~450 lines TS, as spec'd in the brief): `package.json`, `tsconfig.json`,
`src/index.ts`, `src/config.ts`, `src/vault.ts`, `src/auth.ts`, `src/client.ts`,
`src/slack.ts`, `src/worker.ts`, `.env.example`, `systemd/squid-bot-worker.service`,
`install.sh`, `README.md`.

- [ ] **A1 Scaffold** — package (`@slack/socket-mode`, `@slack/web-api`, `pino`, `zod`),
      tsconfig (strict, `module: node16`), `.env.example` documenting `WORKER_TOKEN_SECRET`,
      `PLATFORM_BASE_URL`, `BOT_ID`, `BOT_SLUG`, `WORKER_KEY`, `HEARTBEAT_MS=30000`,
      `LOG_LEVEL`. No secrets defaults.
- [ ] **A2 `vault.ts`** — AES-256-GCM; key = `scrypt(WORKER_TOKEN_SECRET, perBotSalt)`; file
      layout `tokens.enc` = `salt ‖ IV ‖ ciphertext ‖ tag`. API: `hasTokens`, `read`,
      `write`, `wipe` (**synchronous + `fsync`, returns success/failure** — no best-effort
      wipe per C9). Never logs key material.
- [ ] **A3 `auth.ts`** — exact Scheme-B: `HMAC-SHA256("${ts}\n${METHOD}\n${path}\n${sha256(rawBody)}")`,
      5-min window, `timingSafeEqual`, Bearer `wrk_` header `X-Worker-Timestamp`. Same
      constants as `botWorker.routes.ts` so the two sides stay in lockstep.
- [ ] **A4 `client.ts`** — typed `provision` / `heartbeat` / `message` + the echo header from
      C2; retry/backoff (heartbeats must not hammer), request-scoped logging with pino
      redaction (`wrk_`, tokens, HMAC signature values). Response-shape validation shares
      `botWorker` zod-free copies (worker isn't linked to the server package).
- [ ] **A5 `slack.ts`** — `SocketModeClient` boot, event filter mirroring `slackManager.ts:97`
      (skip bots/subtypes/self, only `im` DMs + `app_mention`; `block_actions` forwarded for
      platform resolution), `chat.postMessage`/`response_url` replacement. No agent/assistant
      logic here — everything is forwarded.
- [ ] **A6 `worker.ts` main loop** —
      1. load/create **persistent** `instanceId` (D6/C8, file `instance` → UUID)
      2. no tokens → `provision` once (incl. C1 nonce dance), write vault
      3. connect Socket Mode
      4. heartbeat every `HEARTBEAT_MS`: on `disable` → wipe vault (sync), close socket, `exit 0`;
         on `rotated` → wipe, re-provision (C6 challenge), reconnect
      5. forward every message/`block_actions` → `message`; post returned reply / `response_url`
      6. `SIGTERM`/`SIGINT`: graceful Socket Mode close, final heartbeat, exit.
- [ ] **A7 Systemd + install** — `squid-bot-worker.service` (`Restart=always`,
      `EnvironmentFile`, `EnvironmentFile=-/etc/squid-bot-worker/env`), install script writing
      `wrk_` key 0600 + provisioning the bot via the admin UI, README with the ADR-002 §4
      vault/keystore note.
- [ ] **A8 Smoke harness** — a small `mock-platform` script (in-repo, no Slack/Postgres
      needed) that fakes the three endpoints and asserts the state machine: provision once,
      heartbeat, `disable` → exit 0 + vault empty, `rotated` → re-provision. This is what CI
      runs; a real Slack E2E is a documented deployment step, not a test.

**Checkpoint A:** harness green, `tsc`/lint clean, no secrets in logs, systemd unit reviewed.

### Phase B — Squid config changes via ticket + approval

- [ ] **B1 Schema** — `SquidChangeRequest` model + migration `server/db/2026-10-08-squid-change-request.sql`
      (id, proxyId, ticketId `@unique`, action, target, `value Json`, externalFile?, reason?,
      executionPath `'bundle'|'agent_command'`, status
      `'pending_approval'|'approved'|'declined'|'executed'|'failed'`, requestedById,
      executedAt?, result Json?), registered in `provision.sh`.
- [ ] **B2 `squidControl.service.ts`** — `requestAclUpdate`, `requestReconfigure`,
      `requestExternalFileUpdate` per the brief: validate (reuse `aclEngine.classifyEntry` /
      `splitEntries` / `dedupeDomains` for ACL entries), `ticketing.createTicket` with
      `type: 'squid-config-change'` + `labels: ['pending:approval', 'squid:config-change']` +
      assignee = the bot persona for the proxy's org (so the existing card path keys),
      persist the `SquidChangeRequest`, then **call the exported
      `notifyApprovalForExternalTicket(dto, orgCustomerId)`** to post the card. Returns
      `{ ticketId, status: 'pending_approval' }`.
- [ ] **B3 Lifecycle hook** — `ticketing.service.ts`: `registerOnTicketApproved(fn)`; call
      handlers after a successful `approveTicket` (with the TicketDTO). Register the executor
      from squid module bootstrap. Zero-failure policy: a handler error must not roll back an
      already-applied ticket decision.
- [ ] **B4 Executor** — `executeSquidChange(ticketId)`: load request, run once (`status not
      already executed/failed` — idempotent), then
      - **bundle path:** apply to branch via the ACL CRUD service, `bumpRevision`, request →
        `executed` when the appliedSeq catches up (checked on next `agentResult`/ack);
      - **command path:** enqueue `SquidAgentCommand`, mark `executed` from the ack.
      Failure → `status: 'failed'` + ticket comment; audit `SQUID_CONFIG_APPLIED` /
      `SQUID_CONFIG_FAILED` with `via: 'slack-host-worker' | 'web-app' | 'slack'`.
- [ ] **B5 Agent command channel** — `server/src/modules/squid/squid-agent.routes.ts`:
      include `pendingCommand` in the (already HMAC'd) `agentPoll` response; new
      `POST /api/proxy-agent/command-result` (same `agentAuth`, extends `AgentResultSchema`);
      enqueue/ack/state in `squid.service.ts`. Extend `deploy/agents/squid/squid-agent.sh`:
      fetch command verb + args, execute **only from an allowlist** (`apply-bundle` exists
      already; add `touch-external-file`, `reconfigure`, `reload-cache`? — fixed verbs, fixed
      paths, no shell interpolation per the existing agent hardening note), report `{ok,
      stderr}`. Parse-fail-safe: any unsupported verb is refused with `unknown-command`.
- [ ] **B6 Audit + webhook** — register `SQUID_CHANGE_REQUESTED`, `SQUID_CONFIG_APPLIED`,
      `SQUID_CONFIG_DECLINED`, `SQUID_CONFIG_FAILED`, `AGENT_COMMAND_DISPATCHED`,
      `AGENT_COMMAND_FAILED` in `server/src/config/auditActions.ts`; emit `squid.change_*` org
      events so org admins hear outcomes.
- [ ] **B7 Web UI** — since the org `/squid/[id]/` pages don't exist yet (only `/squid` index
      and the platform `/saas-admin/squid`), ship the request surface as a self-contained
      `client/src/app/squid/[id]/requests/page.tsx` — a "Request a change" form
      (action/target/value/reason/externalFile) + the ticket status follow-up (existing
      ticket list already renders approvals). This deliberately is *not* blocked on the full
      dashboard build. Use `squidApi` style; new `squidApi.requestChange` calls
      `POST /api/squid/:id/change-request`.
- [ ] **B8 Tests** — `server/tests/squid-control.test.ts`: request → ticket created +
      `pending_approval`; approve via service atom → executor ran once → bundle path bumped
      revision / command path enqueued; decline → nothing executed + `SQUID_CONFIG_DECLINED`;
      double-execution guard; hook registered once. Plus command-result route tests through
      `agentAuth` (fixture `pk_` key).

**Checkpoint B:** server suite green, agent script reviewed for allowlist-only behaviour,
form manual-verified against `run-test-dbs` env.

### Phase C — Hardening (brief §3, all accepted)

| # | Item | Touch point | Severity |
|---|---|---|---|
| C1 | **Provision nonce** — first `provision` response returns a single-use nonce; column `workerProvisionNonceHash` (short TTL). Any re-provision (same or new instance) must present it; using it once burns it. | `botWorker.service.ts` + migration | Medium |
| C2 | **Signed command echo** — heartbeat commands (`disable`/`rotated`) come back with `HMAC(sever\|command\|ts)`; worker echoes `X-Worker-Command-Echo` on its next call so the platform can detect a worker that didn't act on a command (treat as failed/needs-alert). | `botWorker.routes.ts`, heartbeat response, worker `client.ts` | Low–Medium |
| C3 | **Vault key derivation** — worker uses `scrypt(WORKER_TOKEN_SECRET, perBotSalt)` (D6), env secret stored alongside ciphertext only as salt. Rotation of `WORKER_TOKEN_SECRET` forces re-provision (wipe + provisions with same `wrk_`). | worker `vault.ts`, README | Medium |
| C4 | **Strictly-increasing timestamps** — per bot, reject any request whose `ts` ≤ the last successful request for that bot (keeps 5-min window; memory map like `badAuthCount`). | `botWorker.routes.ts` | Low |
| C5 | **Source-IP rate limit** — per-IP failure cap in addition to per-bot (shared NAT makes it coarse; still useful for scanners); `WORKER_AUTH_FAILED` stays high-priority in the sadmin feed + document optional Slack alert. | `botWorker.routes.ts` | Low |
| C6 | **Rotation challenge** — when tokens rotate near-`workerRotationPending`, mint a short-lived `workerRotationChallenge`; re-provision after `rotated` must present it. Shares storage approach with C1. | `slackBots.service.ts` updateBot, `botWorker.service.ts` | Medium |
| C7 | **Logging policy** — worker pino redact `wrk_`, tokens, full HMAC values; platform route logs hint/error only; document the prohibition in the worker README. | worker `config.ts`/`client.ts`, README | High (policy) |
| C8 | **Persistent instanceId** — file-persisted at first boot; heartbeat across a crash/restart is the same instance (no spurious `disable`). | worker `worker.ts` | Medium |
| C9 | **Synchronous durable wipe** — `vault.wipe()` waits on `fsync`, reports failure → exit code ≠ 0 for systemd `OnFailure`. | worker `vault.ts` + systemd unit | Medium |
| C10 | **Admin status endpoint** — `GET /api/bot-worker/:botId/status` (admin-only, behind the existing slack-bots auth) returning last heartbeat payload + `activeInstance`, `workerKeyHint`, `workerProvisionedAt` for debugging remotely-run bots. | new route in `botWorker.routes.ts` (or `slackBots.routes.ts`) | Low |
| C11 | **Force re-provision** — admin action setting `workerProvisionedAt = null` + clearing lease/nonce while keeping `wrk_` (today only key revocation fully resets). | `slackBots.service.ts` | Low |
| C12 | **Block Kit contract doc** — document the exact approval-card payload (header/section/actions blocks, `approve`/`decline` action_ids, `value` = ticketId) so worker and platform stay in sync; reference `slackApprovals.ts:39-58`. | `docs/Squid-bot-Web.md` + new `docs/slack-approval-cards.md` | Doc |

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Worker E2E requires a live Slack app + a provisioned `HOST_WORKER` bot — can't be covered in CI | Medium | A8 mock-platform harness tests the full state machine without Slack/Postgres; real-Slack install is a documented deploy step (ADR-002 Phase 2). |
| Giving the agent a generic command channel weakens its "parse-gate" safety | **High** | Allowlist-only verbs + fixed paths, no shell interpolation (same rule as the existing agent); `squid -k parse` gates every squid.conf write regardless of path; unsupported verbs refused. A config-change request that fails parse never applies. |
| Approve-then-execute is racy if the hook is called from three doors (Slack ×2, web) | Medium | Single hook in `approveTicket` (D4); `status` transition in `SquidChangeRequest` is the exactly-once guard (B4), not a best-effort flag. |
| External ticket store used by both this feature and the AD flow | Low | `type` + `squid:config-change` label namespace and the 1:1 `SquidChangeRequest.ticketId` keep this feature's tickets separable from AD tickets. |
| Host worker crashes and restarts → looks like a new instance → self-`disable` | Medium | C8 persisted instanceId removes the ambiguity: a restarted worker heartbeats as the same instance. |
| Token rotation challenge + provision nonce make the provision dance easy to get wrong (worker stuck unable to re-provision) | Medium | C1/C6 shared storage + TTL, tested in A8 harness (mock covers rotated → re-provision); platform mirrors the challenge in getBot so admins can see state. |
| `WORKER_TOKEN_SECRET` leak/rotation on an air-gapped segment | Med | C3 forces re-provision; C11 lets an admin reset without a new `wrk_`. Documented ops runbook. |
| guard: `wrk_` rotation currently clears the provision gate — fine; token rotation does not — C6 covers it | — | covered by C6 |

## Resolved Decisions

- **Worker runtime:** Node.js + TypeScript (user, 2026-10-08). Go static binary = documented follow-on for Node-less hosts.
- **Execution channel:** Option A — extend the existing squid agent command surface. Option B (worker-assisted execution) rejected: a Slack-facing worker must not hold Squid root privileges.
- **Fan-out on approval:** single lifecycle hook registered by the squid module (D4), not per-door side effects.
- **Request persistence:** new `SquidChangeRequest` table (D5), not ticket-metadata surgery.
- **Worker location:** `deploy/agents/squid-bot-worker/`.
- **Hardening:** the brief's §3 table accepted with the stated severities, plus C10 (status endpoint), C11 (force re-provision), C12 (Block Kit doc).

## Open Questions

1. **Approval channel prerequisite:** card delivery needs the org's bot → `approvalChannelId`
   link (`slackBotOrg`). Do our test orgs have one configured? Affects B2/B8 fixtures and E2E.
2. **Command allowlist depth (B5):** which host verbs beyond `reconfigure` are wanted in v1 —
   `touch-external-file` (append/prepend/replace at allowlisted fixed paths), cache-clear, or
   a generic `run-script` verb (a fixed, deploy-approved script path, no arbitrary args)?
   Defaulting to the narrow set unless told otherwise.
3. **Who may request host-level changes (B2):** `requestExternalFileUpdate` / reconfigure for
   non-admin users? Default: `org.squid.manage`, same guard as branch edits today; escalate
   only if a reason appears.
4. **Node version floor on customer hosts** — 18 vs 20; affects the image/build contract in A1.
5. **Provision nonce vs same-instance idempotency (C1):** with a nonce, a genuinely lost
   provision response can no longer be simply retried. Acceptable (admin force-reset C11 is
   the recovery), but confirm the trade is worth closing the retry hole.

## Definition of Done (project-wide, applies to every phase)

- `npm --prefix server test` green (no regressions; C-phase changes keep `bot-worker.test.ts` passing)
- `npm --prefix server run build` clean; worker `tsc --noEmit` + pino-redaction lint clean
- Behaviour verified at runtime against a real API where possible; worker verified via the A8
  mock harness (Slack E2E is a deploy step, documented)
- Docs updated: `docs/Squid-bot-Web.md` (worker exists, control-plane extension), new
  `docs/slack-approval-cards.md`, agent README (command allowlist), worker README (vault/ops)
- Migration for `SquidChangeRequest` (and any Phase C columns) registered in `provision.sh`
  and covered by `cleanDb` in `tests/helpers.ts`