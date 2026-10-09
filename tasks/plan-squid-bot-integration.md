# Implementation Plan (v2): Squid Slack bot ↔ Web Application — web-first, platform-ticketed

> **Supersedes** the v1 "dual-track" plan in this file and the older
> `tasks/plan-squid-bot-worker.md`. Governing docs:
> [ADR-002](../docs/decisions/ADR-002-remote-slack-bot-workers.md),
> [`docs/Squid-bot-Web.md`](../docs/Squid-bot-Web.md).
> **User decisions (2026-10-08, v2):** the **web application is the main window**; **remove
> everything Jira-related** from the bot; the **web application's ticketing is the bot's
> auto-ticketing**; plan a proper implementation of bot auto-ticketing, Squid config changes,
> and status updates end-to-end.

---

## 1. Requirements (this plan)

1. **Web app is the main surface.** Every Squid change the bot can do in Slack
   (`/allow`, `/deny`, `/extend`, `/full-net`, `/lock-net`) is requestable, visible, and
   approvable from the web application. Slack stays as a *convenience input channel*, not the
   system of record.
2. **No Jira.** Delete the Jira client, env vars, docs and `pending_requests.json` store from
   `squid/squid-bot`. The bot must never open a ticket itself; it asks the platform to.
3. **Web application ticketing = bot auto-ticketing.** Every write request — from Slack *or*
   the web app — creates a ticket in the platform's `ticketing` module
   (`pending:approval`), posts the existing Block Kit approval card, and is decided by the
   existing `approveTicket` / `declineTicket` state machine. Execution happens **by the bot**
   only after approval, with an exactly-once command/ack channel.
4. **Status updates, properly**: ticket lifecycle states (requested → approved/declined →
   dispatched → executed/failed) and bot/proxy health (socket, squid systemd, last reload,
   active rules, expirations) surface in the web dashboard, in Slack receipts, and in org
   notifications — all fed from one platform-owned state.

## 2. Today vs. Target (delta)

| Concern | Today (`squid/squid-bot`) | After this plan |
|---|---|---|
| Ticketing | **Jira Cloud** REST calls in `bot.py` (`jira_create_ticket`, transitions, labels, comments) | **Platform `ticketing` module** via a new `/request` endpoint; Jira code deleted |
| Approval card source | Bot posts card (`build_approval_blocks`, action_ids `squid_approve`/`squid_reject`) | **Platform posts** the existing card (`notifyApprovalCardForTicket`, action_ids `approve`/`decline`) using the stored bot token |
| Card-click resolution | Bot-local `handle_approve`/`handle_reject` + static `SLACK_ADMIN_USER_IDS` | Bot **forwards** `block_actions` to `POST /message` → existing `resolveWorkerBlockAction` (platform auth: slackId binding + role) — zero new approval logic |
| Request ledger | `pending_requests.json` on host | Platform tickets + `SquidChangeRequest` + `SquidBotCommand` tables (exactly-once execution) |
| Requester receipt | Bot replies with Jira key | Bot replies with **platform ticket number + web URL** |
| Execution | Local engine (`execute_proxy_change`) after its own approval | Same local engine — but driven by a platform **command** and acked with `command-result` |
| Web visibility | None | Requests, approvals, active rules/expiry, bot socket, squid health, last discovery all on the squid dashboard |
| Identity for approvals | Hard-coded Slack user IDs | Platform-bound: `slackId`-linked `ORG_ADMIN`/`ADMINISTRATOR` (web is the fallback door) |

## 3. Target architecture

```
                WEB APPLICATION (main window)
   ┌─────────────────────────────────────────────────────────────────┐
   │  /squid/[id]/requests  → request allow|deny|extend|full-net|…    │
   │  /squid/[id]/rules     → active rules + expiry (mirror)          │
   │  /squid/[id]/status    → bot socket · squid health · last scan   │
   │  ticket list (approve/decline) · audit feed · notifications      │
   └───────────────┬───────────────────────────┬─────────────────────┘
                   │ (web form)                 │ (approval from web)
                   ▼                           ▼
        squidControl.service ◄──┐       ticketing.approveTicket
        (single core service)   │            │ onTicketApproved hook
                   │            │            ▼
      ┌────────────┴────────────┴─────►  executor → SquidBotCommand (exactly-once)
      │                                        │
      │  POST /api/squid/:id/change-request    │ rides state response
      │  POST /api/bot-worker/:botId/request   │ (or /command sql poll on next state)
      ▼                                        ▼
   HOST (Python bot, vendored repo)      ┌─────────────────────────────┐
   Socket Mode ──Slack commands──►        │ platform_client:
    /allow /deny /extend /full-net        │  auth(HMAC wrk_) · keyring ·
    /lock-net /list                       │  state push · command loop ·
        │                                 │  result ack · bridge→engine  │
        ▼                                 └──────────────┬──────────────┘
   platform: POST /request  ──reply ticket #──► user        │ POST /state
   approval card click → POST /message (block_actions)     │ POST /command-result
        (platform resolves, bot posts replacement)         ▼
   engine: domains.json → conf.d/* + lists/* ── squid -k parse → reconfigure
   expiry_worker · squid_monitor → included in state snapshot
```

**Three inbound doors, one core service, one execution engine:**
- _Slack request_ → `POST /api/bot-worker/:botId/request`
- _Web request_ → `POST /api/squid/:id/change-request`
- both call `squidControl.requestChange(...)` → ticket + card + `SquidChangeRequest`
- _Approval_ (web or Slack card) → `approveTicket` → hook → `SquidBotCommand`
- _Execution_ → command rides the bot's `state` response → bot's existing engine → `command-result`

## 4. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Platform ticketing is the single source of truth.** The bot never creates tickets; it calls `/request`. | Web main window + single audit + exactly-once execution guard. |
| D2 | **`squidControl.requestChange()` is the one core service**; `/request` (bot) and `/change-request` (web) are thin wrappers over it. | Identical ticketing/approval/card/audit semantics from both doors. |
| D3 | **Platform posts approval cards** via the existing `notifyApprovalForExternalTicket`/`notifyApprovalCardForTicket` (uses `botTokenEnc` it already holds). Bot forwards `block_actions` to the existing `message` endpoint, which resolves via `resolveWorkerBlockAction` and returns the `updateCard` text the bot posts. **No new approval logic anywhere.** | Both halves already exist in `slackApprovals.ts` and `botWorker.service.ts`. |
| D4 | **No token provisioning for this bot.** It already holds its own Slack tokens; it only needs a `wrk_` key (minted once via admin UI, stored `0600` on host) for the control channel. `workerProvisionedAt`/provision flow stays for thin workers only; `squid_bot` mode uses `request`/`state`/`command-result`. | Smaller surface; tokens never cross the wire. |
| D5 | **Squid commands keep bot's proven engine** (`execute_proxy_change`, expiry worker, squid monitor, Playwright). The bot becomes a *platform-driven executor*: commands in, results out, state pushed. | Preserves the hardened host behavior; zero logic port. |
| D6 | **Rule mirror for the dashboard** (`SquidBotRule`), upserted from `state` deltas. Expiry stays host-side; expired-rule events flow back as deltas. | Web shows "active rules + countdown" without hosting the expiry engine. |
| D7 | **Layered Squid config contract + single `http_access deny all` seam.** Platform agent owns `/etc/squid/acls/**`; bot owns `/etc/squid/conf.d/**` + `/etc/squid/lists/**`. Include order: acls → fullnet → override → per-IP/group → rules → **one host-maintained deny-all**. Bot stops emitting its own deny-all. Both writers `squid -k parse`-gate. | Without D7, either layer's rules are silently shadowed by the other's `deny all` — the critical correctness fix. |
| D8 | **Approval identity = platform binding.** Static `SLACK_ADMIN_USER_IDS` deleted. Slack approvers must be `slackId`-linked (Phase C machinery); unlinked slack users are told to use the web app. | One authorization model, platform-audited. |
| D9 | **Status model is event-sourced from the bot**, not reverse-engineered: `state` (health + rules + discovery), `command-result` (execution outcome), ticket transitions (approval). Dashboard and Slack receipts render the same lifecycle. | No polling guesses; one flow of truth. |
| D10 | **One bot per organization.** Each client org owns exactly one bot; Slack-originated `/request` resolves the org from the bot's single `slackBotOrg` link. Zero links or >1 link = config error (409) with an ops-doc pointer. Web requests always scope explicitly to their proxy/org. *(User decision 2026-10-08.)* | Org A's bot can only create Org A's changes; no cross-tenant ambiguity. |
| D11 | **Expiry unchanged.** The host expiry worker, `hours` presets (1h/24h/7d/30d) and the indefinite default stay **exactly as today** — no new caps, no behavior changes. Expiry remains host-side; the `SquidBotRule` mirror only reports it. Platform-side validation mirrors the bot's existing rules (does not tighten them). *(User decision 2026-10-08: "keep the expiry worker as the same.")* | Zero regression risk on a proven host component; web shows expiry as-is. |
| D12 | **Retention:** `SquidBotCommand` and `SquidBotRule` rows trimmed after **90 days**; `SquidBotState` keeps only the **latest** row per bot. *(User decision 2026-10-08.)* | Bounded table growth with a full quarter of audit history. |

## 5. Integration seams (spec)

All endpoints under `/api/bot-worker/:botId/*` reuse `workerAuth` (Bearer `wrk_` + Scheme-B
HMAC, 5-min window, per-bot/per-IP brute-force caps). New `workerMode` column:
`'slack_thin'` (existing message-forwarding bots) | `'squid_bot'` (this bot).

### 5.1 `POST /api/bot-worker/:botId/request` (bot → platform, Slack-originated)

```jsonc
{
  "instanceId": "uuid",
  "type": "allow" | "deny" | "extend" | "full-net" | "lock-net",
  "payload": {
    "ip": "10.0.0.5",
    "domain": "example.com",          // allow/deny/extend only
    "hours": 24                       // allow (option) / extend only
  },
  "requester": { "slackUserId": "U…", "slackUserName": "alice", "channelId": "C…" }
}
```

Platform (inside `squidControl`):
1. Validate via the same rules the bot used (`validateIP`, domain/`validateDomain`, class of
   dest IP vs domain, `hours` semantics identical to the bot — no tightened cap, D11);
   reject with a user-facing 400.
2. Resolve org context from the bot's **single** `slackBotOrg` link (D10; 0 or >1 links →
   409 `bot_org_misconfigured`), mint `getOrCreateSquidBotUser()` as ticket **assignee** and
   creator actor.
3. `ticketing.createTicket` → `type: 'squid-config-change'`,
   `labels: ['pending:approval', 'squid:config-change', type]`, human description +
   canonical JSON payload, `b2bCustomerId` = org.
4. Persist `SquidChangeRequest` (idempotency + exactly-once guard).
5. `notifyApprovalForExternalTicket(dto, orgCustomerId)` → approval card. If the org has no
   `approvalChannelId`, the card is skipped — the web ticket list is the door (consistent
   with D8).
6. Audit `SQUID_BOT_TICKET_REQUESTED`.
7. Return `{ ticketId, ticketNumber, status: 'pending_approval', webUrl }`; the bot replies to
   the slash command with the receipt + web link.

### 5.2 `POST /api/bot-worker/:botId/state` (bot → platform, every ~30 s)

```jsonc
{
  "instanceId": "uuid", "version": "2.0.0",
  "status": "CONNECTED" | "DISCONNECTED" | "ERROR",
  "socketConnected": true, "lastEventAt": 0, "msgCount": 42,
  "squid": { "active": true, "parseOk": true, "lastReloadAt": 0 },
  "counts": { "domains": 17 },
  "discovery": { "domain": "example.com", "deps": [".cloudflare.com", "…"], "at": 0 },
  "rules": [ { "ip": "10.0.0.5", "domain": "x", "isDestIp": false, "expires": 0, "app": null } ],
  "rulesDelta": [ { "op": "up" | "down", "ip": "10.0.0.5", "domain": "x", "expires": 0, "app": null } ],
  "lastError": null,
  "requestContext": { "commandIdAcked": null }
}
```

`rules` = full snapshot the platform replaces wholesale, sent **only when its signature
changed** since the last poll (this bot's chosen path — self-healing, no delta tracking);
`rulesDelta` stays the incremental alternative. Both are optional.

Platform: update instance lease (`activeInstance`), persist latest `SquidBotState`, update
`slackBots.status/lastCheckedAt/lastError`, apply `rulesDelta` to `SquidBotRule`, and return
**the command inbox**:

```jsonc
{
  "commands": [
    { "id": "cmd_…", "type": "allow",
      "payload": { "ip": "…", "domain": "…", "is_dest_ip": false, "hours": 1.5 },
      "context": { "requesterChannelId": "C…",
                   "requesterSlackUserId": "U…", "requesterSlackUserName": "…" } }
  ],
  "heartbeatIntervalMs": 30000
}
```

`context` is projected from `cr.details.requester` when the request originated in Slack —
it exists so the host can post progress/result messages to the requester's channel (B5).
It is **absent for web-originated commands**, where the host posts nothing. Additive and
optional on the wire.

Delivering a command changes its status `pending → dispatched`; expired/unchanged keep
`SquidBotCommand` rows append-only for the audit trail.

### 5.3 `POST /api/bot-worker/:botId/command-result` (bot → platform, after execution)

```jsonc
{ "commandId": "cmd_…", "instanceId": "uuid", "ok": true, "detail": "squid reloaded", "at": 0 }
```

Platform: mark the command `acked` (or `failed`), finalize the owning `SquidChangeRequest` and
ticket (comment on ticket; emit `notifications`); audit `SQUID_CONFIG_APPLIED` /
`SQUID_CONFIG_FAILED` with `via: 'slack-host-worker' | 'web-app'`; return `{}`. Failure also
flags the ticket for operator attention.

### 5.4 `POST /api/bot-worker/:botId/message` — unchanged, now carries approval clicks

The bot forwards every interactive `block_actions` payload (card approve/decline) here;
`resolveWorkerBlockAction` authorizes (slackId-bound `ORG_ADMIN`/`ADMINISTRATOR`), calls
`approveTicket`/`declineTicket`, and returns `updateCard` text the bot posts to
`response_url`. The approval is picked up by `syncBotChangeRequests` on the next
`/state` poll (or web list) and enqueues the `SquidBotCommand` — see P5.

### 5.5 Web endpoints

- `POST /api/squid/:id/change-requests` — authed org manage; same `requestChange` core
  as 5.1 with `requester` from the session user; returns the ticket receipt (plural name
  matches the pre-existing GET — deviation from the original singular draft, noted in P2).
- `GET /api/squid/:id/change-requests` — `SquidChangeRequest` lifecycle list; **runs
  `syncBotChangeRequests` first** so an approval made anywhere is visible (and dispatched)
  by the time the list renders.
- `GET /api/squid/:id/status` — bot `SquidBotState` + `SquidBotRule` summaries + last commands.
- `GET /api/bot-worker/:botId/status` — admin-only raw last snapshot (ops). Mounted on the
  pre-cookie-wall router, so it carries its own `authMiddleware` + `requireRole('ADMINISTRATOR')`.

## 6. Task list

### Phase 1 — Platform API (server) — **DONE (2026-10-08)**
- [x] **P1** `workerMode` column + migration (`server/db/2026-10-08-squid-bot.sql`),
      registered in `provision.sh`; Prisma models `SquidBotState`, `SquidBotCommand`,
      `SquidChangeRequest`, `SquidBotRule`. Also: `SlackBotWorkerMode` enum,
      `SlackBotOrg.squidProxyId` (D10), `SquidChangeStatus.DISPATCHED` (exactly-once
      hand-off state), `botWorker.schema.ts` shared with the thin dialect.
- [x] **P2** `requestChange` core — implemented as `squid.service.ts#createChangeRequest`
      + `squid.schema.ts#refineBotChange` (shared zod refine, `classifyEntry`-consistent
      semantics for all five types), with `squidBot.service.ts#submitChange` as the thin
      wrapper both doors call. **Deviation:** no separate `squidControl.service.ts` — the
      module layout is `squidBotStore` (leaf) → `squid.service` → `squidBot.service` →
      `botWorker.routes` to keep imports cycle-free.
- [x] **P3** `/api/bot-worker/:botId/request` route (behind `workerAuth`,
      `requireWorkerMode('SQUID_BOT')`) + `RequestSchema`.
- [x] **P4** `state` + `command-result` routes (mode-gated) + both status surfaces:
      `GET /api/squid/:proxyId/status` (dashboard, §5.5) and
      `GET /api/bot-worker/:botId/status` (admin-only ops snapshot, session-authed since
      the bot-worker router mounts before the cookie wall).
- [x] **P5** Executor — **deviation:** no `registerOnTicketApproved` hook exists for
      ticket-created-outside-the-slack-flow; instead `syncBotChangeRequests` detects the
      ticket decision (`todo` = pending, `in_progress`/`completed` = approved,
      `declined`/`rejected` = rejected → atomic CR transition) at the top of every
      `/state` poll and before the web change-request list. Approval → command dispatch
      is therefore latency-free (same response). Ack finalizes CR + ticket comment +
      org notification + audit as specified.
- [x] **P6** Audit actions — **implemented names:** `SQUID_CHANGE_REQUESTED` (with
      `via: 'slack-host-worker' | 'web-app'`, replacing `SQUID_BOT_TICKET_REQUESTED`),
      `SQUID_BOT_COMMAND_SENT`, `SQUID_BOT_STATE` (health **transitions only**, never
      per-poll); outcomes reuse `SQUID_CHANGE_APPLIED` / `SQUID_CHANGE_REJECTED` /
      `SQUID_CHANGE_FAILED` (replacing `SQUID_CONFIG_*`).
- [x] **P7** Tests — `tests/squid-bot.test.ts`, 16 cases: dialect gates + free-text
      block/forward, lease/telemetry/rules upsert, transition-only audit, D10 scope 409s,
      shared-core parity web↔slack, validation rejections, card skip without
      `approvalChannelId` + decrypted-token post, exactly-once dispatch guard,
      idempotent/late ack, timeout → FAILED, concurrent sync single-command, brute-force
      auto-disable on the new routes, ops snapshot route auth.
- [x] **P8** Retention job (D12): `server/src/services/squidBotRetention.ts` (90-day
      trim of terminal `SquidBotCommand`/`SquidBotRule` rows via `trimBotHistory`),
      started in `server.ts` beside `startExpiryReminders()`; `SquidBotState` is
      upsert-latest by construction. `cleanDb` covers the new tables through FK cascades.

### Phase 2 — Bot refactor (`squid/squid-bot`, vendored repo) — **DONE (2026-10-08)**
- [x] **B1** **Delete Jira:** `jira_*` functions, `JIRA_*` env refs, `build_approval_blocks`,
      `_update_approval_card`, `handle_approve`/`handle_reject`, `_submit_ticket`,
      `pending_requests.json` store, `SLACK_ADMIN_USER_IDS`. Update `.env.example`,
      `DEPLOYMENT.md`, `README.md`, drop `requirements.txt` leftovers.
      *Also removed `SLACK_ADMIN_CHANNEL` (cards are platform-posted now) and added
      `cryptography` to `requirements.txt` (encrypted-key unwrap); residual grep clean.*
- [x] **B2** `platform_client/` module: `auth.py` (Scheme-B HMAC + `wrk_` Bearer, shared
      constants contract with the server), `keyring.py` (`/etc/squid-bot/key` 0600, optional
      AES-256-GCM under `PLATFORM_MASTER_SECRET`), `client.py` (request/state/command-result),
      `state.py` (snapshot incl. squid health + rules deltas + discovery),
      `bridge.py` (headless entry into the existing execution engine).
      *Deviation: `state.py` sends a signature-gated full `rules` snapshot (replace path)
      instead of deltas; `bridge.py` also owns a persisted executed-id journal (~500) so a
      redelivery after a lost ack re-acks instead of re-executing (`/extend` is not
      idempotent). Cross-language signature test: Python/Node digests byte-identical.*
- [x] **B3** Command handlers now call `client.request(...)`, reply with the returned
      ticket receipt + web URL. `/list` stays local (no ticket).
- [x] **B4** Interactive-event forwarding: catch-all action handler → `client.message`
      (`block_actions`) → post returned `updateCard` to `response_url`. Keep ACK-first.
      *Implemented as `@app.action(re.compile(".*"))` projecting
      `{type, user, channel, actions[], response_url?, message_ts?}` per MessageSchema.*
- [x] **B5** Headless execution: refactor `execute_proxy_change` to run from an inbound
      command without a Slack card; keep progress/result posts to requester thread/channel;
      post `command-result` (ok/fail + detail) after `reload_squid`.
      *`reload_squid()`'s bool return is now checked (raise → `ok:false` ack); progress is a
      single posted message edited through `build_progress_blocks` stages in
      `context.requesterChannelId` (no context → silent); extend not-found/no-expiry ack
      `ok:false` with detail; only `hours` goes on the wire — expiry derived at execution.*
- [x] **B6** Remove bot's own `http_access deny all` from `regenerate_squid_configs()`
      (D7); systemd hardening per Phase 3/5; single-instance guard (flock) + persisted
      `instanceId`; heartbeat/`state` timer honors `heartbeatIntervalMs`.
      *flock exits code 0 on a second instance; instance id persisted at
      `/etc/squid-bot/instance-id`; `reload_squid` now sets `LAST_PARSE_OK`/`LAST_RELOAD_AT`
      for `/state`. **Ships together with C1** (seam provides the replacement deny-all).
      Systemd hardening deferred to Phase 5.*

### Phase 3 — Host config-layer seal — **DONE (2026-10-08)**
- [x] **C1** Documented include contract (acls → fullnet → override → per-IP/group → rules →
      one deny-all) + `seam.conf` template + install script edits squid.conf.
      *`squid/squid-bot/seam.conf` (contract header comments + ordered includes),
      `squid/squid-bot/install-seam.sh` (idempotent `squid.conf` editor: installs the
      seam, absorbs legacy `conf.d`/`acls` includes into the canonical position,
      carries operator-owned files into a marked block above the deny-all, keeps
      exactly one `http_access deny all` — appends one if the host had none), and
      DEPLOYMENT.md §2 "Config Layering (the D7 seam)" with the layer table.
      **Coupled with B6:** the bot no longer emits its own deny-all, so the seam is
      what keeps a B6-upgraded host closed — both ship together.*
- [x] **C2** `squid -k parse` gating on both writers; precedence fixture (`squid -k parse`)
      in CI; doc note: full-net overrides platform policy layer — each `full-net` is
      ticketed + audited.
      *Bot writer: `reload_squid()` parse-gates before every reconfigure (and B5 turns a
      failed parse into an `ok:false` ack). Platform writer: the GUI reload path
      parse-gates per `squid/ProxyControlFlow.md` (parse fail → abort, no reload); the
      agent's bundle apply is retired (`squid-agent.sh` note) — its README still
      describes it (stale, harmless). Fixture: `tests/precedence-fixture.sh` — builds
      the full layer stack, runs the real installer twice (idempotence + legacy-glob
      absorption + carried-over operator files), asserts acls < seam < deny-all, and
      parse-fails the installer into a backup restore when a layer file is corrupt; CI
      job `squid-seam` (`.github/workflows/ci-cd.yml`) installs squid and runs it with
      `FORCE_SQUID_PARSE=1`. Full-net note lives in `seam.conf` header + DEPLOYMENT §2.*

### Phase 4 — Web application (main window) — **DONE (2026-10-08)**
- [x] **W1** `/squid/[id]/requests` — form for all five write types (domain/IP picker, expiry
      hours, reason); posts `change-request`; shows the new ticket + web link.
      *Created `client/src/app/squid/[id]/requests/page.tsx` with action selector, IP/domain/hours/reason fields, validation mirroring `BotChangeBodySchema`, and a live change-request list with status badges, source badges, ticket links, and SSE-ready refetch.*
- [x] **W2** `/squid/[id]/requests` lifecycle list — requested → approved/declined →
      dispatched → executed/failed, with the approver and/or execution detail inline.
      *Same page shows the lifecycle table with columns: Action, Target, Source, Status, Requested, Approver/Detail. Statuses: Pending Approval / Approved / Dispatched / Declined / Applied / Failed. Each row shows ticket link when available.*
- [x] **W3** `/squid/[id]/rules` — active rules mirror (`SquidBotRule`) with countdown,
      source (web/Slack), and the bot latest discovery deps; row-level "request extend/deny".
      *Created `client/src/app/squid/[id]/rules/page.tsx` with bot status summary cards, filterable rules table (IP, domain, expiry countdown badge, source badge, app/special, last seen), discovery deps expandable panel, raw state debug view. Expiry countdown shows days/hours/minutes with color coding (emerald=indefinite, amber=expiring, rose=expired).*
- [x] **W4** `/squid/[id]/status` — bot socket status, squid systemd/reload state, last
      heartbeat, `lastError`, automation version (feeds `SquidBotState`); platform
      `/saas-admin/squid` shows the same fields per proxy.
      *Created `client/src/app/squid/[id]/status/page.tsx` with link status card, bot telemetry grid (socket, messages, instance, bot status), Squid service health grid (service, parse, rules, errors), command pipeline counters (pending/dispatched/acked/failed/timedOut), discovery deps panel, raw state debug. Handles unlinked proxy state with CTA to provision.*
- [x] **W5** Notifications: org admins notified on request created, approved/declined,
      executed, failed (`notifications.service` + toast bus).
      *Added `notifyAdminsOfProxy` calls at all lifecycle transitions in `squid.service.ts` (create → pending, sync approved/rejected, apply → dispatched/applied) and `squidBot.service.ts` (command result ACKED/FAILED). Uses existing durable `Notification` rows + web push; appears in the NotificationBell for org admins.*

### Phase 5 — Hardening (from the v1 analysis, retained)
- [ ] **H1** Tokens: move `.env` → `/etc/squid-bot/env` 0600 + optional `PLATFORM_MASTER_SECRET`
      vault; Jira secrets deleted with B1.
- [ ] **H2** Approver access: Slack unlinked → web-only; doc that approvals are platform
      role-bound (D8).
- [ ] **H3** Duplicate-instance: systemd flock + instance lease (state carries `instanceId`).
- [ ] **H4** `discover()` budget: wall-clock + page + dep caps; abort error visible.
- [ ] **H5** Logging: never log `wrk_`, tokens, HMACs; `SQUID_BOT_AUTH_FAILED` high-priority
      audit; journal redaction assert in tests.
- [ ] **H6** systemd scoping: `NoNewPrivileges=yes`, `ProtectHome=yes`, `PrivateTmp=yes`,
      narrow `ReadWritePaths`, `Restart=on-failure`.

### Phase 6 — Docs, ops, rollout
- [ ] **S1** `docs/Squid-bot-Web.md` rewritten to the web-first model (ticketing, seams,
      lifecycle); new `docs/squid-layered-policy.md` (D7 contract).
- [ ] **S2** Vendored `INTEGRATION.md`: key mint/rotate/revoke (admin UI), first install,
      state semantics, failure runbook.
- [ ] **S3** Migration plan for a live host: replace `bot.py` with B1–B6 artifact, mint
      `wrk_` key, point `PLATFORM_BASE_URL`, verify first `/allow` end-to-end from Slack and
      web before cutting over remaining orgs.

## 7. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Deny-all shadowing between the two config layers | **Critical** | D7/C1/C2 unified seam + parse-gating on both writers + CI precedence fixture |
| Slowly-provisioned approvals if org has no `approvalChannelId` | Med | Web ticket list is a full door (D8); card is best-effort by design |
| Slack approver with no `slackId` binding blocked | Med | Explicit Slack reply "approve from the web app"; web is the main window by requirement |
| Bot's local engine diverges from platform validation | Med | One core service (`requestChange`) validates both doors; bot retains client-side checks as UX only |
| Command dispatched but bot never acks (crash loop) | Med | `SquidBotCommand` status `dispatched → timed-out` after N heartbeats → ticket flagged + admin alert |
| `workerMode` misuse opens message-forwarding on a squid_bot | Low | Mode gates: `squid_bot` rejects `message` free-text and `provision`; thin rejects `request`/`state` |
| Removed Jira flow regresses Slack UX during cutover | Med | Python-side contracts tested with a mock platform (Phase 2 harness) before live rollback |

## 8. Resolved decisions and open questions

**Resolved:** D1–D12; Jira removed; web-first; single-track platform ticketing; bot keeps its
engine; layered config contract; platform-bound approval identity; `wrk_` key only (no token
provisioning).

**Resolved (user decisions, 2026-10-08):**
1. **Org scope → D10:** one bot per organization; `/request` resolves the org from the bot's
   single `slackBotOrg` link, 409 on 0 or >1 links. No multi-org ambiguity to document.
2. **Expiry → D11:** keep the expiry worker and all expiry semantics exactly as they are —
   no caps, no preset changes, host-side as today.
3. **Retention → D12:** 90 days for commands/rules, latest-only state (task P8).

**Open:** none blocking Phase 1.

## 9. Definition of done (per phase)

- `npm --prefix server test` green; `npm --prefix server run build` clean; new tables in
  `cleanDb` and migrations in `provision.sh`.
- Bot: `python -m py_compile`, strict mypy on `platform_client/`, and the mock-platform harness
  asserting `request → ticket → approve → command rides state → execute → result`, incl.
  `block_actions` forwarding and duplicate-instance rejection.
- Host seam: `squid -k parse` fixture + precedence test in CI; a real-squid dev-container run
  where possible.
- Verified live (rollout gate, S3): first `/allow` and first web request both create tickets,
  are approved, execute, and reach `executed` with dashboard + Slack + notification updated.
- Docs updated (S1/S2); no Jira references remain in `squid/squid-bot`.