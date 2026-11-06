# Squid outbound guardrails implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Track verification here.

**Goal:** Secure outbound HTTPS over TCP and provide tenant-safe proxy tickets and automation pause controls.

**Architecture:** Keep polling and the existing agent/bot executors. Nginx authenticates client certificates; application authentication binds certificates to enrolled machine identities and verifies signed messages. Database controls persist pauses; Redis provides replay reservations and distributed admission limits.

**Tech Stack:** Existing Express/TypeScript, Prisma/PostgreSQL, Redis, Next/React, Nginx and Python standard library.

**Spec:** Approved Plan A design saved in the Codex Security standalone artifact collection, `hardening/plan-a-outbound-squid-design.md`.

## Global constraints

- No inbound customer agent ports or custom TCP framing: HTTPS is the TCP protocol stack.
- Preserve existing working-tree changes. Git metadata is read-only in this sandbox; work in place, uncommitted.
- No production migrations, deployment, firewall edits, secrets, resets or seeds.
- Automation pause must not emit deny-all or stop Squid.
- Customer identity is resolved server-side; platform employees reuse existing permission roles.

## Review focus

Certificate/key mismatches; concurrent nonce replay; pause bypass through bot polling; cross-client ticket targeting; false completion from unrelated revision acknowledgements.

### Task 1: Machine protocol and deployment boundary

Files: `server/src/lib/machineAuth.ts`, new `machineProtocol.ts`, agent/worker routers, Prisma schema, additive SQL migration, env/server bind, Nginx machine template, Python protocol client.
Interfaces: `verifyMachineSignature` accepts optional v2 actor/nonce; enrolled machine row supplies SHA-256 certificate fingerprint and minimum protocol version. Replay SET NX fails closed.
- [ ] Add failing unit tests for v2 tampering, downgrade, replay, certificate binding, store outage and invalid-signature non-disable behavior.
- [ ] Implement versioned auth and private backend binding; remove spoofable auto-disable for actual machine routers; enable agent hash cross-check.
- [ ] Add authenticated TLS client and server/host deployment documentation; verify tests and Python self-check.

### Task 2: Durable pause and bounded dispatch

Files: new `squidAutomation.ts`, schema/SQL, squid service and bot store/state, org/admin routes.
Interfaces: `assertAutomationRunning(proxyId, customerId)`, `automationState`, `setAutomationPause`, distributed queue admission and dispatch lease.
- [ ] Add failing tests for parent pause precedence, paused submissions, store failure and serialized dispatch.
- [ ] Implement durable global/client/proxy pause, submission/queue bounds, polling hints and checks on agent and bot delivery.
- [ ] Bind each bundle request to its dispatched revision; reject future/unknown acknowledgements.
- [ ] Run targeted tests and typecheck.

### Task 3: Client/employee ticket management

Files: squid admin/org routes, shared change validation, client API and new `/squid` page, client management link.
Interfaces: staff select client then server-filtered proxy; org select owned proxy. Ticket target is separate from human assignee. Existing change-request workflow is reused.
- [ ] Add failing ownership/permission tests.
- [ ] Implement routes, provisioning/enrolment controls and page with independent loading per action.
- [ ] Quarantine legacy alternate mutation mounts; maintain explicit 410 responses.
- [ ] Run permission, protocol and client/server typechecks.

### Task 4: Integration and verification

Files: operator protocol/runbook, tests, local adapter contract/client.
- [ ] Inspect available host/WebUI code and implement only through its shared policy writer; record any unavailable or sandbox-blocked host integration explicitly.
- [ ] Run focused regression tests, build/typechecks and review diff with a fresh reviewer.
- [ ] Record actual checks and remaining deployment/host work. Do not call source validation production certification.

## Execution ledger

Ruling: user explicitly requested implementation, so execute inline without another plan approval round. No branch or commit can be created because sandbox Git metadata is read-only.
Ruling: do not install a new raw TCP listener; use standard HTTPS/TLS over TCP 443 with explicit signed-message versioning.

Task 1: implemented v2 HMAC/nonce reservations, certificate enrollment binding, private backend default, dedicated Nginx template and Python TLS client. Existing v1 wire remains only for unenrolled development actors; production requires enrollment/v2.
Task 2: implemented durable global/client/proxy pauses, automatic pressure pause, Redis admission/leases, single bot delivery, exact revision mapping, failed-apply pause and transactional bundle dispatch.
Task 3: implemented `/squid` with scoped client/proxy ticket creation, provisioning, agent enrollment and pause controls; linked client management and reused existing employee roles. Legacy mutation doors return 410; unfinished source preserved in `server/legacy/orb`.
Task 4: host package and opt-in WebUI managed-mode source integration implemented. Shared writer source synchronized to the sibling WebUI checkout. Operational rollout documented in `docs/squid-outbound-production.md`.

Review: fresh reviewer identified revision supersession, ACL ownership and transactional dispatch issues. Fixed with included-revision remapping before delivery, uid/gid/mode journal preservation, and a transaction that claims the change and stores policy/revision/dispatch together. Regression tests added.

Ruling: unfinished Orb ticket enums/metadata did not exist in the actual database contract and broke TypeScript. Preserve their original source as `.disabled` snapshots, use ordinary task tickets plus the Squid ledger, and retain the working approval hook.
Ruling: transferring a proxy identity would expose historical client state. Reject reassignment and provision a fresh identity for a new client.
Ruling: current certificate replacement is explicit and immediate; automatic certificate issuance and overlapping fingerprint renewal are not implemented. Operator pauses automation during renewal.

Verification so far: 77 database-free TypeScript tests and 9 host Python tests pass; server and client typechecks pass; temporary-certificate Nginx configuration validation passes; WebUI integration parses and shared writer digests match. Full client build is blocked by the existing Google Fonts download timing out. No runtime restart, live database migration, browser approval, real host apply or production deployment was performed.

Deployment boundary: installed SQUID_BOT source is outside this checkout. The shared transport/executor adapters are provided; integration with that installed worker and a disposable-host test remain rollout requirements. Source delivery does not certify that external installed worker.
