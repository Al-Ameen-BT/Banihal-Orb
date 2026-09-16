# External Ticketing API — integration guide

REST + OAuth 2.0 (client credentials) surface for machine integrations (a CRM
syncing tickets, a bot filing incidents, a dashboard polling work items). Build
against this contract; never against the internal platform routes.

- **Base URL:** `https://<your-host>/api/external`
- **Auth:** OAuth 2.0 `client_credentials` → short-lived Bearer JWT, refreshable
- **Create-op status:** success is HTTP **200** with a JSON body (not 201)
- **Errors:** JSON `{ error, code, details? }` — see [Errors](#errors)

---

## 1. Provisioning an API key

An `ADMINISTRATOR` creates a key in the platform UI at **Platform → External API**
(`/saas-admin/api-keys`). The **client secret is shown exactly once** — store it
in your secret store; only a SHA‑256 hash is kept server-side.

A key has three properties that define what it can touch:

| Property | Values | Meaning |
|---|---|---|
| `scopes` | `tickets.view`, `tickets.write`, `api_keys.manage` | What the token may do. `api_keys.manage` is reserved for a future self-management flow and currently grants nothing. |
| `ticketStore` | `default`, `admin` | Which database the key acts on — see below. |
| `customerIds` | list of org ids (cuid) | Org restriction for `default` keys. Empty = no cross-tenant access allowed. |

**Stores.**

- **`default`** — customer organization tickets. The key is restricted to the
  orgs in `customerIds`, and **every ticket create must pass `orgCustomerId`**
  matching one of them. This is the cross-tenant guard: no single key sees every
  org's tickets.
- **`admin`** — the platform-internal ticketing store. No org restriction, no
  `orgCustomerId`. Access to this store is a higher trust level; yours is almost
  certainly a `default` key.

A revoked or expired key stops working **immediately** — its already-issued
tokens are re-validated against the key on every request.

---

## 2. Authentication

### 2.1 Get an access token

`POST /api/external/token` (accepts form-encoded or JSON):

```http
POST /api/external/token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=ext_ck_...&client_secret=ext_sk_...&scope=tickets.view%20tickets.write
```

`scope` is optional; the token is issued for the *intersection* of the requested
scopes and the key's scopes.

```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "tickets.view tickets.write",
  "refresh_token": "..."
}
```

The access token is a JWT valid for a short TTL. Treat it as opaque.

### 2.2 Refresh a token (optional)

The `refresh_token` is **single-use and rotates**: every redemption returns a new
pair. Keep it server-side only.

```http
POST /api/external/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=...
```

Redis is `refresh_token`'s backing store; if it is unavailable the token response
simply omits `refresh_token` and you must repeat client credentials instead.

### 2.3 Using the token

```http
Authorization: Bearer eyJ...
```

---

## 3. Endpoints

All under `/api/external`. GETs need `tickets.view`; mutations need `tickets.write`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/token` | issue / refresh access token (no auth) |
| GET | `/projects` | list projects (their `id` feeds `projectId`) |
| GET | `/tickets` | list tickets (filters below) |
| POST | `/tickets` | create a ticket |
| GET | `/tickets/:id` | single ticket |
| PATCH | `/tickets/:id` | update a ticket |
| GET | `/tickets/:id/comments` | comments on a ticket |
| POST | `/tickets/:id/comments` | add a comment |
| GET | `/search?q=` | free-text search over tickets |

`GET /tickets` filters (all optional, combined with AND): `status`,
`priority`, `type`, `projectId`, `assigneeId`, `search`. An empty string is
treated as "not provided". Unknown/misspelled query keys are rejected (400).

---

## 4. Creating a ticket

`POST /api/external/tickets`

```json
{
  "title": "Production API returns 500 on checkout",
  "description": "POST /v1/checkout starts failing at 14:02 UTC. Stack: ...",
  "type": "bug",
  "priority": "high",
  "status": "todo",
  "projectId": "3f2c…-0000-0000-uuid",
  "assigneeId": "9ab1…-0000-0000-uuid",
  "orgCustomerId": "cm0…cuid-of-your-org",
  "storyPoints": 5,
  "dueDate": "2026-09-20T18:00:00.000Z",
  "labels": ["checkout", "p0-candidate"],
  "branch": "fix/checkout-500",
  "onSiteSupportRequired": false
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string ≤255 | yes | |
| `description` | string ≤10 000 | yes | |
| `type` | enum | no (default `task`) | `bug` `feature` `task` `story` |
| `priority` | enum | no (default `medium`) | `low` `medium` `high` `urgent` |
| `status` | enum | no (default `todo`) | `todo` `in_progress` `client_pending` `completed` `declined` |
| `projectId` | uuid | yes | from `GET /projects` |
| `assigneeId` | uuid | yes | a ticket-store user id — your machine **persona**. It becomes reporter **and** assignee of every ticket you file, and posts your later comments. Must reference an existing ticket user, else 400 `ASSIGNEE_NOT_FOUND`. |
| `orgCustomerId` | cuid | **default store only** | your org id, must be in the key's `customerIds`. Rejected with 403 `ORG_NOT_ALLOWED` otherwise, and rejected with 400 on the `admin` store. |
| `customerId` | uuid/null | admin store only | mirror of `orgCustomerId` for the admin store. |
| `storyPoints` | int 0–100 | no | |
| `dueDate` | ISO-8601 | no | |
| `labels` | string[] ≤30 | no | |
| `branch` | string ≤255 | no | |
| `onSiteSupportRequired` | bool | no | |

`.strict()` bodies: a **typo'd or unknown field is a 400**, so the caller learns
immediately instead of silently ignoring a typo.

### Approval gating — read this before it bites you

Every ticket created through this API is born with the label **`pending:approval`**
appended automatically, in status `todo`. Until a human approves it:

- it stays `todo` and does **not** become a live work item;
- your webhook consumers will see `pending:approval` in `labels`.

Approval happens out of band: a platform approver in the ticketing UI, or an
**Approve / Decline** card in the org's Slack approval channel. On approve the
ticket moves to `in_progress` and the label is removed; on decline it moves to
`declined` with the label removed and a reason comment attached. Another
consumer creating the same ticket twice gets a 409 `TICKET_ALREADY_DECIDED` guard
on the decision paths — design your idempotency around that, don't fight it.

### Ticket object (the shape you will read everywhere)

```json
{
  "id": "uuid",
  "ticketNumber": "TKT-1042",
  "title": "…",
  "description": "…",
  "status": "in_progress",
  "priority": "high",
  "type": "bug",
  "projectId": "uuid",
  "projectName": "NOC",
  "reporter": { "id": "uuid", "name": "…", "email": "…" },
  "assignee": { "id": "uuid", "name": "…", "email": "…" },
  "customer": { "id": "cuid", "name": "Acme", "email": "…", "contactPerson": "…" },
  "storyPoints": 5,
  "dueDate": "…",
  "labels": ["checkout", "pending:approval"],
  "branch": "fix/checkout-500",
  "onSiteSupportRequired": false,
  "reasonForDelay": null,
  "resolvedMethods": null,
  "resolvedAt": null,
  "sla": { "id": "uuid", "name": "Gold", "responseTime": 2, "resolutionTime": 8, "timeUnit": "hours" },
  "slaStatus": "normal",
  "slaRemainingSeconds": 28500,
  "slaDeadline": "2026-09-16T18:30:00.000Z",
  "responseSla": { "status": "normal", "deadline": "…", "remainingSeconds": 7200 },
  "resolutionSla": { "status": "normal", "deadline": "…", "remainingSeconds": 28500 },
  "pausedTime": null,
  "totalPausedTime": 0,
  "createdAt": "2026-09-16T14:00:00.000Z",
  "updatedAt": "2026-09-16T14:02:00.000Z"
}
```

- `slaStatus`: `none` `paused` `breached` `critical` `warning` `normal`
- Deleting/resolving a ticket is a *platform* operation — the machine surface is
  create/read/update/comment only.

### Updating

`PATCH /api/external/tickets/:id` — same field rules as create (minus
`projectId`/`orgCustomerId`/`customerId`); only fields you send change. Setting
`status` to a different value emits a `ticket.status_changed` webhook.

### Comments

- `GET /api/external/tickets/:id/comments` → list
- `POST /api/external/tickets/:id/comments` with `{ "content": "…" }` → append.
  Comments are posted by your `assigneeId` persona.

---

## 5. Webhooks (push events your app subscribes to)

When integration *actions* happen, the platform pushes signed JSON to webhook
URLs registered per API key (set up in the same Platform → External API page —
the webhook signing secret is shown once, like the key secret).

### Events

| Event | Fires when |
|---|---|
| `ticket.created` | a ticket is created via the API (or decision events resignal the org) |
| `ticket.status_changed` | status transitions (approve, decline, platform updates, your own updates) |
| `ticket.comment_added` | a comment is posted |

### Delivery

```http
POST <your-registered-url> HTTP/1.1
Content-Type: application/json
X-Webhook-Event: ticket.status_changed
X-Webhook-Event-Id: evt-<uuid>
X-Webhook-Key: ext_ck_...
X-Webhook-Signature: sha256=<hex HMAC-SHA256 of the exact raw body bytes>

{ "eventId": "evt-…", "type": "ticket.status_changed",
  "keyId": "…", "triggeredAt": "…",
  "data": { "ticket": { /* full ticket object, as §4 */ },
             "comment": { "id": "…", "content": "…", "authorId": "…", "createdAt": "…" } } }
```

`comment` is present only for `ticket.comment_added`.

### Contract

- **Verify every delivery**: recompute HMAC-SHA256 over the exact body bytes with
  your signing secret and compare with `X-Webhook-Signature`. Do not trust a
  request just because it hits your URL.
- Reply **2xx** to ack. 
- Retries: network errors, timeouts (>10 s), `5xx` and `429` are retried up to
  **3 attempts** (5 s then 10 s backoff). Other `4xx` are dropped — a stable 4xx
  is treated as a bug in your endpoint, it will not fix itself.
- After **5 consecutive failures** the webhook is **auto-disabled** (audited). If
  you stop seeing events, check the webhook is still enabled in the UI.
- Delivery is **fire-and-forget**: the ticket API responds immediately and push
  happens in the background, so a slow endpoint never delays ticket writes.

---

## 6. Errors

All failures are JSON: `{ "error": "<human message>", "code": "<MACHINE_CODE>" }`.
Likely codes:

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | bad body/query — `details` describes the offending field(s) |
| `NOT_FOUND` | 404 | unknown ticket (cross-org snooping returns this too, deliberately) |
| `INSUFFICIENT_SCOPE` | 403 | token/key lacks the required scope |
| `ORG_NOT_ALLOWED` | 403 | `orgCustomerId` not in the key's allowed orgs |
| `KEY_DISABLED` | 403 | key revoked/expired after the token was issued |
| `ASSIGNEE_NOT_FOUND` | 400 | `assigneeId` is not a ticket-store user |
| `CONFLICT` / `TICKET_ALREADY_DECIDED` | 409 | duplicate / already-decided approval |
| `DATABASE_UNAVAILABLE` | 503 | backing store unreachable — retry with backoff |
| `invalid_client` | 401 | bad / revoked / expired credentials on `/token` |
| `invalid_scope` | 400 | requested scope exceeds the key's scopes |
| `invalid_grant` | 400 | unknown / already-used refresh token |

Token endpoint responses use OAuth-shape `{ error, error_description }`.

---

## 7. Rate limits

- `/token`: strict brute-force limit (per-IP). Back off and retry on 429.
- Resource calls: **per key, 600 requests / minute** (redis), historically keyed
  for the token flow too. A 429 with limits in classic headers means you exceeded
  it — space your calls, batch your syncs.

---

## 8. End-to-end (curl)

```bash
# 1) token
TOKEN=$(curl -s http://localhost:3001/api/external/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&client_id=ext_ck_DEMO&client_secret=ext_sk_DEMO&scope=tickets.write' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

# 2) create a ticket (default store → orgCustomerId required)
curl -s http://localhost:3001/api/external/tickets \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "title": "Checkout 500 on prod",
    "description": "POST /v1/checkout starts failing at 14:02 UTC.",
    "type": "bug", "priority": "high",
    "projectId": "3f2c0000-0000-4000-8000-000000000000",
    "assigneeId": "9ab10000-0000-4000-8000-000000000000",
    "orgCustomerId": "cm0yourorgcuid",
    "labels": ["checkout"]
  }'

# 3) list your org's tickets
curl -s http://localhost:3001/api/external/tickets?status=todo \
  -H "Authorization: Bearer $TOKEN"
```

`localhost:3001` is the local dev default; use the deployed base URL in production.