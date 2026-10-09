# Squid-bot ↔ Web Application Connection

> How the **Squid bot** (a Slack bot whose live process runs on the Squid host — client
> infrastructure) connects to and works with **this web application** (the B2B platform).
> Governing design: [ADR-002 — Remote Slack bot workers (reverse control plane)](decisions/ADR-002-remote-slack-bot-workers.md).

---

## 1. What the Squid bot is

The Squid bot is a Slack app companion that ships alongside the Squid outbound proxy on a
customer's host. In this repo it appears as a `SlackBot` row with
`executionOwner = 'HOST_WORKER'`:

- Its **live connection to Slack** (Socket Mode, `wss://` outbound) runs in a worker process
  on the Squid host — **not** inside the platform's network.
- It answers DMs in Slack, links a user's Slack identity to their platform account, and lets
  linked admins approve/decline ticket approval cards.
- The host reports the bot service's health back through Squid telemetry
  (`server/src/modules/squid/squid.schema.ts:114`) as
  `{ table: 'slack-squid-proxy', state: active|inactive|failed|unknown, lastError }`, surfaced
  on the proxy dashboard.

## 2. Why there is a separate connection story (the constraint)

The platform's normal path keeps every bot inside its own process: `SlackManager`
(`server/src/modules/slack-bots/slackManager.ts`) opens the Socket Mode WebSocket, bridges
messages, and persists status. A customer network **will not open an inbound port**, and we
will not ship plaintext tokens across the wire. So for host-run bots:

- Both channels — bot → Slack and bot → platform — must be **outbound only**.
- The control plane is a **reverse control plane**: the worker *calls home* over HTTPS, and
  every command from the platform is answered only through the response to those calls.
- The platform never pushes, never opens a port toward the customer, and the worker only ever
  reaches out over 443 (TLS).

## 3. The connection surface

Three `POST` endpoints, mounted **before** the cookie auth wall in
`server/src/app.ts:88` (`app.use('/api/bot-worker', botWorkerRoutes)`) — a machine
authenticates, not a browser session:

| Endpoint | Purpose |
|---|---|
| `POST /api/bot-worker/:botId/provision` | First call ever. Decrypts the bot's Slack tokens **once** and returns them over authenticated TLS. Succeeds once; see §5. |
| `POST /api/bot-worker/:botId/heartbeat` | Periodic health + instance lease (default **30 s**, `HEARTBEAT_MS` in `botWorker.service.ts:21`). Carries `{status, socketConnected, lastEventAt, msgCount, instanceId, version, lastError}`. The **response is the command channel** — it carries `disable` / `rotated` when needed. |
| `POST /api/bot-worker/:botId/message` | One Slack event (`message` or `block_actions`) forwarded for platform-side resolution; the reply rides back for the worker to post. |

The worker is the only holder of the live Slack tokens, so it posts replies/card updates
itself; the platform is the authority for *decisions* (identity, assistant chat, approvals).

### Request bodies (`botWorker.schema.ts`)

- **Provision:** `{ instanceId? }` — opaque worker self-identity; binding it to the bot row is
  what lets a retried provision (lost response) be recognized as the same worker, and a
  duplicate instance be told to die.
- **Heartbeat:** `{ status: CONNECTED|DISCONNECTED|ERROR|INACTIVE, socketConnected?,
  lastEventAt?, msgCount?, instanceId, version?, lastError? }`.
- **Message:** `{ type: message|block_actions, user, channel, text?, actions?,
  response_url?, message_ts? }`.

## 4. Authentication & security model

Every request is authenticated twice — a per-bot machine credential **plus** a per-request
HMAC signature (`workerAuth` in `botWorker.routes.ts:46`):

1. **`wrk_` worker key (Bearer).** Minted by an Administrator, shown exactly once, stored as:
   - `workerKeyHash` — SHA-256 of the raw key, for constant-time lookup;
   - `workerKeyEnc` — AES-256-GCM ciphertext of the raw key, needed to verify each HMAC
     (the route decrypts in memory; plaintext is never staged at rest);
   - `workerKeyHint` — masked hint (`wrk_…`).
   The decrypted key must still match the hash via `crypto.timingSafeEqual` — guards against
   the two columns ever diverging.
2. **Scheme B request HMAC.** Same pattern the squid agent already uses (`signSchemeB` in
   `agentApi.ts`): HMAC-SHA256 over
   `"${timestamp}\n${METHOD}\n${path}\n${sha256(rawBody)}"`, with a **5-minute replay window**
   and constant-time comparison. A captured request cannot be replayed against a later clock
   or a different body.

Other protections:

- **Brute-force auto-disable.** 5 consecutive signature failures (`MAX_BAD_AUTH` in
  `botWorker.routes.ts:32`) flip the bot to `enabled = false` and audit
  `WORKER_AUTH_FAILED`. So an attacker that steals or guesses a key degrades the bot rather
  than being handed data.
- **Tokens leave only over `provision`.** The response body of `provision` is the only place
  the bot's Slack tokens ever exist outside the platform, and only over this authenticated
  TLS channel. At rest they stay as `botTokenEnc` / `appTokenEnc` (AES-256-GCM).
- **Audit.** Every worker call family is audited with the existing `audit()` helper:
  `WORKER_KEY_GENERATED`, `WORKER_KEY_REVOKED`, `BOT_WORKER_PROVISIONED`,
  `WORKER_AUTH_FAILED` (`server/src/config/auditActions.ts:130-133`).
- **No shared-key coupling.** `wrk_` is deliberately separate from the AD-automation key
  (`adk_`) and the squid-agent key (`pk_`), so one leaked credential cannot fetch tokens or
  mint anything outside its own bot.

## 5. Session lifecycle: one-time provision + instance lease

- **Provision gate.** The first successful provision sets `workerProvisionedAt`. A second
  provision with a **different** `instanceId` is refused `409 ALREADY_PROVISIONED` — a second
  host can never re-fetch tokens. The one deliberate recovery hole: the **same** `instanceId`
  may re-provision after a lost response (the worker stored nothing but the platform already
  flipped the gate).
- **Instance lease.** Every heartbeat carries `instanceId` (a UUID minted at worker boot).
  The platform records it on `slackBots.activeInstance`. A heartbeat whose `instanceId`
  differs from the recorded one gets a **`disable`** command in the response — the active
  instance wins, the duplicate kills itself. Combined with one-worker-per-bot, this prevents
  duplicate Socket Mode connections (Slack would otherwise deliver every event to each).
- **Commands ride the heartbeat response** (the heartbeat *is* the command channel, no second
  poll to keep in sync):
  - `disable` — ownership moved back to the platform, the bot was disabled, or this
    `instanceId` is a duplicate → the worker must shut down (and wipe its local token vault).
  - `rotated` — Slack tokens were rotated → the worker must re-provision now.
  - `null` — keep running.
- **Status persistence is unchanged.** The heartbeat writes `status`, `lastCheckedAt`,
  `lastError`, `activeInstance` exactly like `slackManager` used to, so the existing
  dashboard keeps working without UI change.

## 6. Features of the connection (what the bot can do through it)

The worker is "just the connection." All behavior is resolved platform-side in
`botWorker.service.ts` and mirrored from the in-process `slackManager` path, so one state
machine has two doors:

### 6.1 Identity linking (Phase C)
- `link LINK-XXXX` — redeems the one-time link code (`redeemLinkCode`), binds the Slack user
  id to a platform account. The reply confirms the linked email. Unrecognized/expired codes
  get a regenerated-code hint (codes expire in 5 minutes, generated from
  *My Profile → Slack* in the web app).
- `unlink` — removes the Slack identity binding.
- This binding is what authorizes a user's approval-card decisions (§6.3).

### 6.2 Assistant chat
- Any other DM text is forwarded as `{ type: 'message' }`; the platform runs it through
  `agentChat(text, 'end_user')` and returns the reply. Because Slack users are not
  authenticated to the platform, assistant guidance is always end-user-floored.
- Agent credentials **never leave the platform network** — the worker only ever sees the
  question and the reply. This is a deliberate rejection of the "worker calls the agent
  directly" alternative (ADR-002).

### 6.3 Approval cards (block_actions)
- Button clicks on a ticket approval card arrive as `{ type: 'block_actions', actions, response_url }`
  and are resolved by `resolveWorkerBlockAction` — the same `approveTicket` / `declineTicket`
  services the platform uses, with platform-side authorization:
  - the acting Slack user must be **linked** (have a `slackId` in the platform),
  - `ORG_ADMIN`s may only decide tickets of their own organization (`resolveTicketOrg`),
    `ADMINISTRATOR`s may decide anything, plain `USER`s are refused,
  - outcome is audited (`TICKET_APPROVED` / `TICKET_DECLINED`, `via: 'slack-host-worker'`)
    and an org webhook event is emitted.
- The worker posts the replacement card text (`updateCard`) to Slack's `response_url`.

### 6.4 Coexistence with the platform-owned path
- `executionOwner` decides who owns the live Slack connection: `PLATFORM` = the API
  process's `SlackManager`; `HOST_WORKER` = the remote worker.
- `slackManager.init()`/`connect()` **skip** `HOST_WORKER` bots
  (`slackManager.ts:25,35`), so the two paths never double-connect.
- Handing a bot to a host worker (`updateBot` with `executionOwner: 'HOST_WORKER'`)
  disconnects the in-process Socket Mode connection immediately; the worker's next heartbeat
  confirms the handover.
- Field edits (`name`, `description`, tokens, `enabled`, owner) still flow through the web
  app's bot admin API; token rotation sets `workerRotationPending` so the next heartbeat
  returns `rotated`.

### 6.5 Live synthetic ✕ dashboard visibility
- Nothing to hide: the bot's `status`, `lastCheckedAt`, `activeInstance` and
  `workerKeyHint` are exposed on the bot DTO (`slackBots.service.ts:28-29`) and the Squid
  proxy's telemetry reports the host bot's systemd state. An admin can see at a glance that
  the bot is running remotely, whether its Socket Mode socket is up, and the last error.

## 7. Data model (all on the existing `slackBots` table)

Migration `server/db/2026-10-07-bot-worker.sql` (safe to re-run; declared on
`model SlackBot` in `server/prisma/schema.prisma:542`):

| Column | Purpose |
|---|---|
| `workerKeyHash` | SHA-256 of the `wrk_` key — constant-time lookup/compare |
| `workerKeyEnc` | AES-256-GCM ciphertext of the raw `wrk_` key (HMAC verification) |
| `workerKeyHint` | Masked hint for the admin UI |
| `workerProvisionedAt` | One-time provision gate |
| `activeInstance` | Instance currently leasing the bot (heartbeat-written) |
| `executionOwner` | `SlackBotExecutionOwner` enum: `PLATFORM` \| `HOST_WORKER` (default `PLATFORM`) |
| `workerRotationPending` | Token was rotated → next heartbeat must return `rotated` |

Rollback is one flag: clear `workerKeyHash` (and set `executionOwner = 'PLATFORM'`) and the
bot falls back to the in-process `slackManager` path.

## 8. Admin lifecycle from the web app

| Action | Route (`slackBots.routes.ts`) | Effect |
|---|---|---|
| Mint `wrk_` key | `POST /api/slack-bots/:id/worker-key` | Generates a fresh `wrk_…` (returned once), clears the provision gate + lease — the worker must re-provision from scratch |
| Revoke | `DELETE /api/slack-bots/:id/worker-key` | Clears all worker columns; immediately invalidates the worker (its next request 401s) |
| Rotate Slack tokens | `PATCH /api/slack-bots/:id` | Sets `workerRotationPending`; next heartbeat tells the live worker to re-provision (same key) |

Both key endpoints require an `ADMINISTRATOR` and are audited.

## 9. Status of this implementation

**Platform API side — implemented** (verified: `tsc --noEmit` clean for the new files, schema
migration registered):

- `server/src/modules/slack-bots/botWorker.routes.ts` — router + `workerAuth` middleware +
  brute-force auto-disable.
- `server/src/modules/slack-bots/botWorker.service.ts` — provision / heartbeat / message /
  block_actions resolution.
- `server/src/modules/slack-bots/botWorker.schema.ts` — zod schemas for the 3 endpoints.
- `server/tests/bot-worker.test.ts` — 6 integration tests, **written, not yet run** (needs a
  provisioned `*_test` database).
- Migration + Prisma model + audit actions + admin key endpoints — all wired.

**Host-side worker process — deferred.** The worker that would run on the Squid host
(Socket Mode connection, local AES vault under `WORKER_TOKEN_SECRET`, heartbeat/message loop
honoring `disable` / `rotated`) is designed in ADR-002 §1/§4 but not yet built. Until it
exists, this API is exercised only by tests, and every bot keeps running on the platform's
own `slackManager`.

## 10. Key files

| File | Role |
|---|---|
| `docs/decisions/ADR-002-remote-slack-bot-workers.md` | Governing design |
| `server/src/modules/slack-bots/botWorker.routes.ts` | Routes + `workerAuth` |
| `server/src/modules/slack-bots/botWorker.service.ts` | Provision/heartbeat/message logic |
| `server/src/modules/slack-bots/botWorker.schema.ts` | Request validation |
| `server/src/modules/slack-bots/slackBots.service.ts` | `generateWorkerKey` / `revokeWorkerKey` / `updateBot` handover |
| `server/src/modules/slack-bots/slackManager.ts` | Platform-owned path (skips `HOST_WORKER` bots) |
| `server/db/2026-10-07-bot-worker.sql` | Migration |
| `server/prisma/schema.prisma` (`model SlackBot`, line 542) | Data model |
| `server/tests/bot-worker.test.ts` | Integration tests (unrun) |
| `server/src/app.ts:88` | Mount: `/api/bot-worker` before the auth wall |