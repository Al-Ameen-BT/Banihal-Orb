# ADR-003 — Consolidate the Squid host ↔ platform machine API

> Date: 2026-10-21 · Status: **Proposed** · Extends [ADR-002](ADR-002-remote-slack-bot-workers.md)
> Implementation plan: [`tasks/plan-squid-host-api-consolidation.md`](../../tasks/plan-squid-host-api-consolidation.md)

## Context

The B2B platform serves Squid proxies installed on **customer hosts, outside the
platform's infrastructure** (ADR-002's constraint: outbound-only HTTPS, no inbound
ports, no plaintext secrets). Three machine-API surfaces grew independently:

| Surface | Actor | Auth | State |
|---|---|---|---|
| `POST/GET /api/proxy-agent/*` | per-proxy Squid agent (`poll`, `result`, `telemetry`, `public-key`, `ticketing-config`) | `regKeyEncrypted` + HMAC, headers `X-Proxy-Id` / `X-Proxy-Timestamp` | live |
| `/api/bot-worker/:botId/*` | Squid Slack-bot host worker (SQUID_BOT and SLACK_THIN dialects) | `workerKeyEnc`/`workerKeyHash` + HMAC, headers/URL param, `X-Worker-Timestamp` | live (phases 1–4 of `tasks/plan-squid-bot-integration.md` done) |
| `/api/squid-web/:proxyId/*` | (intended) Slack-independent web config API | mixed, self-handled | **dead** — zero callers anywhere (client or server), contains a divergent second change-request path and dead code |

Two nearly-identical inline HMAC verifiers (`agentAuth` in `squid-agent.routes.ts`,
`workerAuth` in `botWorker.routes.ts`) duplicate ~40 lines each; the two things
named "Scheme B" are different schemes (the analytics-agent variant signs
`${ts}.${body}`, the squid/bot surfaces sign `${ts}\n${METHOD}\n${path}\n${sha256(rawBody)}`).
`agentAuth` does not consult the existing `squidProxies.regKeyHash` column, so the
hash-divergence guard `workerAuth` has is missing there. Documentation drifts:
`docs/Squid-bot-Web.md` §9 still says the host worker is "deferred"; the vendored
`squid/squid-bot/INTEGRATION.md` promised by S2 does not exist. There is no single
API contract document a Squid host operator can be handed.

## Decision

1. **Protocol frozen; implementation consolidated.** Deployed hosts pin the exact
   canonical string, header names, paths and the ±5-minute replay window. Nothing on
   the wire changes. All verification moves into **one shared module**
   (`server/src/lib/machineAuth.ts`) used by both routers via per-actor configuration
   (actor id source, timestamp header, secret loader, audit action, brute-force hook).
2. **One brute-force counter.** The shared module owns the consecutive-failure
   counter (in-memory by default; Redis-backed when `REDIS_URL` is set, matching the
   `agentApi` lane pattern) and the threshold→disable hook per surface.
3. **Reg-key hash cross-check enabled.** The agent loader passes `regKeyHash` to the
   shared verifier, so a diverged `regKeyEncrypted`/`regKeyHash` pair 401s instead of
   silently authenticating — the same guard `workerAuth` already applies.
4. **`/api/squid-web` is deleted.** Zero callers; the duplicated change-request logic
   is a drift hazard bypassing the single core (`submitChange`). The canonical doors
   remain: machine → `POST /api/bot-worker/:botId/request`; user (session) →
   `POST /api/squid/:id/:change-requests` form surface; admin → `/api/saas-admin/squid`.
5. **One contract doc.** `docs/squid-host-api.md` becomes the single reference
   (actor types, signing scheme with known vectors, endpoint tables, error codes,
   key lifecycle, mTLS opt-in profile). `docs/Squid-bot-Web.md` is corrected to the
   web-first reality; `squid/squid-bot/INTEGRATION.md` is materialized.
6. **mTLS documented, not default.** nginx gains a commented, opt-in
   `ssl_verify_client` profile for the machine locations (defense-in-depth; the HMAC
   remains mandatory on both paths regardless).

## Consequences

- Both routers shrink to configuration + dialect gates; signature logic and its
  security review live in one file with one test suite.
- The agent surface gains the hash-divergence guard with no wire change and no
  migration (the column exists since `server/db/2026-09-17-squid-proxy.sql`).
- The dead duplicate path and its drift risk disappear.
- Host operators get one authoritative document, ending the Markdown split-brain.

## Non-goals

- No new endpoints, no path/header renames, no protocol version bump.
- `agentApi.ts`'s distinct `${ts}.${body}` "Scheme B" (analytics agent, different
  API) is only clarified in docs — renaming it touches unrelated modules.
- Session-based surfaces (`/api/squid`, `/api/saas-admin/squid`) are untouched.
