# BanihalOrb: feature and update inventory before pushing

Date: 6 November 2026 (Asia/Kolkata). Product version: **2.0.0-dev.0 — unreleased**.

Repository: `Al-Ameen-BT/B2B-Site`. Comparison baseline: local HEAD `f8cfb5e710fafcfcbf48d651b037297b488381ee`, plus the current tracked and untracked working-tree files. This is not a comparison with the live production installation or a newly fetched remote branch.

This inventory describes source capabilities, current updates, and incomplete areas. An API route is not proof that a host operation is implemented. “Present” below means source exists; it does not mean the feature was exercised in production.

## Existing application features

| Area | Features present in source | Main source |
| --- | --- | --- |
| Registration and admission | Organisation registration; joining an existing organisation; email verification/resend; organisation approval verification/resend; pending-organisation administration | `server/src/modules/auth`, `server/src/modules/saas-admin` |
| Authentication | Login; email MFA verification/resend; refresh/logout; forgot/reset password; session and trusted-device handling | `server/src/modules/auth`, `server/src/middleware/auth.middleware.ts` |
| Personal account | Profile read/update; password change; security controls exposed through existing account flows | `server/src/modules/users`, `client/src/app/profile` |
| Customer tenancy | Organisation context and scoped queries; organisation profile/security settings; own organisation services | `server/src/config/database.ts`, `server/src/modules/organizations` |
| Organisation users | List/invite users; change roles; remove users within the authorised organisation scope | `server/src/modules/users` |
| Platform staff | Invite/update/remove staff; reset staff passwords; editable platform roles and permission catalogue; Administration/HR/Employee/Intern role patterns | `server/src/modules/saas-admin`, `server/src/config/permissions.ts` |
| Client administration | Organisation directory and detail; client users/org admins; security/service administration; controlled impersonation; pending admissions | `client/src/app/clients`, `client/src/app/saas-admin/orgs`, `server/src/modules/saas-admin` |
| Service catalogue | Create/update/delete catalogue entries; assign services to clients; renew/update/remove customer services; expiry-related handling | `server/src/modules/saas-admin`, `server/src/services/expiryReminders.ts` |
| Service requests | Raise/list/read requests; organisation request listing; closure; platform review/update | `server/src/modules/requests`, `server/src/modules/saas-admin` |
| Ticket core | Create/read/edit tickets; status/priority/type/project/assignee/search filters; client/contact/branch and support-resolution fields; configurable ticket numbering | `server/src/modules/ticketing`, `client/src/app/ticketing` |
| Ticket collaboration | Comments; attachments and authorised download; watchers; mentions; activity history; personal ticket updates | `server/src/modules/ticketing/ticketing.routes.ts` |
| Ticket ownership and escalation | Organisation scope; owner-based platform editing; separate client/admin ticket stores; org-admin escalation; platform escalation alerts and first-wins claim | `server/src/modules/ticketing/access.ts`, `ticketing.routes.ts`, `ticketing.service.ts` |
| Ticket approvals | Approve/decline; conditional first-decision transition; registered approval consumers | `server/src/modules/ticketing/ticketing.service.ts` |
| Projects and SLAs | Project create/update; empty-project deletion; SLA CRUD; dashboard, stats, analytics, reports and alerts; pause/resolution accounting | `server/src/modules/ticketing` |
| Ticket retention | No ticket-delete endpoint; records remain part of the ticket history | `server/src/modules/ticketing/ticketing.routes.ts` |
| AI assistant | Chat endpoint; saved conversation sessions; read/delete own sessions; separate signed agent chat and top-complaints endpoints | `server/src/modules/chat`, `server/src/modules/agent` |
| Slack bot registry | Bot CRUD; connect/disconnect; organisation assignments; dynamic ticket form fields; approval channels; API/worker key issuance and worker key revocation | `server/src/modules/slack-bots` |
| Organisation bots | View assigned bots; organisation-admin creation of bot-targeted tickets; Slack identity link | `server/src/modules/bots`, `server/src/modules/slack-bots/slackLink.routes.ts` |
| Remote workers | Host-worker provisioning/heartbeat/messages; SQUID_BOT request/state/result dialect; instance and command bookkeeping | `server/src/modules/slack-bots/botWorker.routes.ts`, `server/src/modules/squid/squidBotStore.ts` |
| AD credential delivery | Machine-key authenticated delivery; authorised user listing and reveal | `server/src/modules/ad-secrets` |
| External ticket API | OAuth client-credential token endpoint; scoped search/projects/ticket read/create/update/comments; ticket-status callback route | `server/src/modules/external-api` |
| Integration administration | Issue/revoke external API credentials; register/list/remove webhook destinations | `server/src/modules/external-api/external-admin.routes.ts` |
| Notifications | Durable per-user notifications; mark-one/all-read; Web Push public-key/subscription/unsubscription endpoints | `server/src/modules/notifications`, `server/src/modules/push` |
| Announcements | Platform announcement CRUD; organisation-facing listing | `server/src/modules/announcements`, `server/src/modules/saas-admin` |
| Platform metrics and audit | Organisation/user/ticket metrics; top clients; SLA breaches; chat analytics; activity/logins/staff directory; password-reuse review; revenue permission boundary | `server/src/modules/saas-admin`, `server/src/lib/audit.ts` |
| General UI | Role-aware navigation; dashboards/operations workspace; client directory; account/auth pages; support, legal and error pages | `client/src/app`, `client/src/components` |
| Infrastructure | Express/Prisma/PostgreSQL; Redis-backed facilities; Next.js frontend; Nginx HTTPS; native systemd and Podman deployment paths; CI checks and image builds | `server`, `client`, `deploy.sh`, `deploy/podman`, `.github/workflows/ci-cd.yml` |

Delivery-dependent features such as SMTP, push, Slack, AI provider execution and remote hosts still require correct runtime credentials and real-service verification. An `ssoEnabled` organisation setting exists, but this inspection did not establish a complete SAML/OIDC login implementation; do not advertise federated SSO from that flag alone.

## Scope update: ticket-only Squid management

The later scope change removes human-facing configuration inspection/editing, monitoring/reporting and host maintenance routes and client helpers. BanihalOrb now exposes connection management, connection status, credentials, safety pauses and approval-ticket requests/history only. The capability inventory below records internal/existing source, not the current human API. Approved-change delivery remains on machine endpoints.

## Squid capabilities present in the BanihalOrb source

| Capability | Scope and current interpretation |
| --- | --- |
| Proxy registry | Proxy listing/detail, platform provisioning, names/descriptions, registration keys and hints, lifecycle state and last contact |
| Organisation ownership | Organisation-admin proxy routes; selected client/proxy workflow for authorised platform staff |
| Access policy | Branch/rule groups; additive/exclusive modes; source assignment; whitelist/blacklist entries; safe/SSL ports; full-access rules |
| Change requests | Structured policy changes linked to client, proxy and approval ticket; state and error history |
| Agent control | Outbound polling, signed configuration bundles, result acknowledgements, telemetry and restricted ticketing configuration retrieval |
| Host bot control | Per-IP allow/deny/extend/full-net/lock-net command dialect; bot/proxy linking; command claim/result ledger; rule/state mirrors |
| Monitoring | Telemetry, sessions/log entries, host-config snapshots, activity, CSV reports and dependency-scan entry point |
| Live updates | Change-request SSE route and broadcast support |
| Lifecycle restrictions | Separate operational lock/disable/subscription behavior; automation pause must not be confused with a network lock |

Some branch/port/full-access management is API-backed without a restored detailed UI. The new `/squid` page covers selection, structured policy tickets, provisioning, certificate enrollment, pauses and request history; it is not a replacement UI for every existing endpoint.

## Updates in the current working tree

### Secure outbound communication

- Standard HTTPS/TLS over TCP 443; customer hosts initiate polling rather than accepting platform push connections.
- Versioned v2 HMAC messages bind actor identity, timestamp, nonce, method, original path/query and exact body hash.
- Redis atomic nonce reservations reject replay; replay-store failure rejects machine work with a retryable error.
- Enrolled identities bind a machine to the SHA-256 fingerprint of its verified client certificate. Agent and worker certificates enroll separately.
- Production requires enrollment/v2. Legacy v1 remains only for unenrolled development compatibility.
- Agent secret/hash cross-check; invalid signatures cannot disable an identified production proxy merely by naming it.
- Dedicated mTLS Nginx template; human listeners reject machine paths and strip asserted certificate headers.
- Backend loopback bind by default; private-container bind retained for Podman.
- Production Redis/signing configuration requirements; dedicated Ed25519 bundle key; v2 bundle signatures bind the target proxy.
- External ticketing credentials restricted to the proxy's organisation and audited when retrieved.

Sources: `server/src/lib/machineAuth.ts`, `machineProtocol.ts`, `server/src/modules/squid/squid-agent.routes.ts`, `bundleSigning.ts`, `deploy/nginx`.

### Proxy tickets and staff/client management

- New `/squid` workspace and links from client management.
- Organisation admins select owned proxies; platform staff select client then proxy.
- Existing staff accounts/roles reused, with explicit Squid and ticket permissions.
- Normal task tickets link to the Squid change ledger; unsupported prototype-specific ticket enums were removed from active use.
- Retry keys preserve a request/ticket receipt and detect reuse with a different payload.
- Ticket creation failures remain visible and do not authorize approval-less execution.
- Explicit approval hook dispatches through the real change-request workflow rather than the old success-logging prototype.
- New proxy provisioning and one-time registration-key display; agent-certificate enrollment UI.
- Cross-client proxy identity transfer now rejects; a receiving client gets a fresh identity.

Sources: `client/src/app/squid/page.tsx`, `client/src/app/clients/page.tsx`, `server/src/modules/squid/squidControl.routes.ts`, `squid.service.ts`, `squidBot.service.ts`, `server/src/modules/ticketing/ticketing.service.ts`.

### Pause, overload and execution safeguards

- Persistent global, client and proxy automation pauses; parent pauses take precedence.
- Separate `squid.pause.global` permission for fleet-wide control.
- Paused submissions/dispatch stop while bounded health and result reporting can continue.
- Distributed per-proxy leases with renewal and token-safe release; client submission and proxy outstanding-request bounds.
- One bot command delivered at a time; paused time excluded from normal receipt timeout on resume.
- Platform pressure monitor and host-local overload latch; manual recovery rather than silently resuming dispatch.
- Configuration mutation, revision bump and request dispatch stored together in a transaction.
- Included full-state requests map to the actually delivered revision; acknowledgements advance monotonically and complete matching requests.
- Host apply failure pauses further automation for investigation.
- Approval/HTTP acceptance is distinct from host-confirmed APPLIED.

Sources: `server/src/modules/squid/squidAutomation.ts`, `squid.service.ts`, `squidBotStore.ts`, `squidBot.service.ts`, `server/src/server.ts`.

### Host package and related WebUI integration

- Verified TLS client with no credential-carrying redirects or inherited HTTP proxy.
- Outbound polling agent with retry jitter/backoff, private state/configuration checks, single-instance lock and durable pending result.
- Shared managed-file writer: Ed25519 verification, proxy/revision/path/size checks, lock, journaling, uid/gid/mode preservation, parse/reconfigure/health checks, rollback and duplicate handling.
- Existing worker integration adapter with shared lock, durable command receipts and explicit interrupted-operation reconciliation.
- Opt-in WebUI managed mode blocks competing local writes, regeneration/healing and background scheduler activity; authentication/read-only use remains.
- Systemd example, source integration patch, host self-tests and production runbook.

The related `/home/ameen/Desktop/BT-Projects/squid-webgui` checkout also has source edits in `app.py`, `config.py`, `managed_mode.py` and `platform_writer.py`. **Those files are outside this B2B Git repository and will not be included by pushing B2B-Site.** The integration patch and shared modules are included in `deploy/squid/` for coordinated delivery.

### Product versioning

- `VERSION` is the product source of truth; current value `2.0.0-dev.0`.
- Synchronization/check script updates frontend/API manifests, lockfile root versions and API build-version JSON without changing dependencies.
- Build-time sidebar version, public `/api/version`, and version in `/health`.
- CI checks consistency and matching `v*` tags; deployment scripts run consistency checks. Podman runs its check in a Node container, without requiring host Node.
- Changelog and documented immutable Git-tag release procedure; no tag, release or push created by this work.

Sources: `scripts/version.mjs`, `VERSION`, `server/src/product-version.json`, `docs/versioning.md`, `CHANGELOG.md`, `.github/workflows/ci-cd.yml`.

## Breaking changes and compatibility

1. Production machine clients need enrolled mTLS certificates and signed v2 requests; old installed clients must be upgraded before enforcement.
2. `/api/orb` and `/api/squid-web` return 410. Their old callers must use the scoped change-request and polling workflows.
3. Unfinished Orb source and earlier ticket-schema/service snapshots are preserved as `.disabled` files in `server/legacy/orb`; they are not mounted APIs.
4. Proxy identity reassignment returns a conflict; provision a new identity instead.
5. An additive SQL migration adds machine identities, pause controls, target revisions and idempotency keys. It must be applied through the reviewed deployment workflow before the new runtime uses it.
6. Native backend bind defaults to loopback; container deployments explicitly retain private-network binding.
7. WebUI managed mode is opt-in. When enabled, local policy writes and local scheduler activity change behavior. Review existing policy import and replacement backup scheduling first.

## Incomplete or limited features: do not advertise as complete

| Area | Source evidence / limitation |
| --- | --- |
| Squid certificate CA/import/CSR operations | Existing service methods bump revision and audit an intent; the new bundle agent does not implement these special host commands. Certificate expiry fields are not fully parsed. These are distinct from the implemented mTLS fingerprint enrollment. |
| Squid backups/restore | `listBackups` returns an empty placeholder. Create/restore handlers bump a revision or report an action without a completed backup-storage/execution contract. |
| Restart/rescan | Existing handlers largely bump a revision. The new bundle agent reconfigures; it does not implement a distinct service restart or ACL-discovery/rescan command. |
| Bandwidth charts | Existing RX/TX figures estimate bytes from URL length; they are not measured interface bandwidth. |
| Package updates | Package status reads reported telemetry; update-availability is hard-coded false rather than checked against a package repository. |
| Automatic certificate lifecycle | No automatic issuance, renewal or overlapping old/new fingerprint enrollment. Operator-controlled replacement is documented. |
| Installed SQUID_BOT runtime | Its source is not in this checkout. Transport/executor adapters are supplied; the installed worker still requires integration and real-host testing. |
| Older external approval callback | The existing ticket-status webhook separately resets approval state and marks dispatch errors FAILED. Full duplicate-callback and pause/retry compatibility across that older path is not established by the focused new tests; review it before claiming every approval path is safe. |
| Detailed Squid navigation | The only current Squid page is `/squid`. Existing sidebar links still include `/saas-admin/squid` and `/squid/:id/dashboard`, `branches`, `ports`, `history`, `settings`, without corresponding current pages. Review these links before release. |
| Deleted Squid pages | `client/src/app/squid/[id]/requests/page.tsx`, `rules/page.tsx`, and `status/page.tsx` were already deleted in the starting working tree. Their deletion remains part of a prospective push. |
| Production release tracking | Source versions/tags are checked, but there is no new stable-only production gate or automatic deployment-history registry. |
| Old Orb environment requirements | Production env validation still requires `ORB_TOKEN_SECRET` although the Orb API is retired. Review this leftover requirement and unused prototype settings before release. |
| Older summary documents | `PHASE1-IMPLEMENTATION-SUMMARY.md` claims a completed two-key Orb API, scrypt/SQLite auditing and unsupported ticket types. It contradicts the active implementation and must not be treated as current release evidence. |

Factory reset is a real destructive platform-policy operation in the existing source: it removes branches and resets policy data. It is not the overload pause and should not be described as a safe pause action.

## Verification and pre-push status

Previously completed checks in this session: **77 focused database-free TypeScript tests, 9 host Python tests, 4 version-tool tests; both application typechecks; deployment-script syntax; version/tag consistency; temporary-certificate Nginx template validation; source parse/digest checks for related WebUI integration.** They were not all rerun for this documentation-only inventory.

The last full frontend production build stopped on a Google Fonts download timeout. No successful full client build, browser acceptance, real Squid-host apply, production mTLS/firewall check, production database migration or live end-to-end ticket/worker certification is claimed.

Before this inventory was added, `git status --porcelain=v1 -uall` reported **86 entries: 39 modified tracked files, 3 deleted tracked pages, and 44 untracked files**. Later inventory-document additions will increase the count. Normal `git diff --stat` excludes untracked files, so it does not represent the full proposed push.

Before staging/pushing:

- Review the incomplete features and stale links above; decide which are fixed, explicitly deferred or removed from release claims.
- Review every untracked file, including `server/.env.example.new`, prototype summaries, design/task documents, archived source, and `.impeccable` tooling configuration. Do not stage real environment files, credentials, generated state or database contents.
- Review the three page deletions and their navigation impact.
- Deliver the separate WebUI repository changes or the matching integration patch together with the compatible host package.
- Apply no production migration or rollout merely because source is pushed; use the [production guide](../squid-outbound-production.md) and [version/release guide](../versioning.md).
- Commit the reviewed source before creating immutable release tags. Current code remains a development version.

No commit, push, tag, deployment or production mutation was performed while preparing this inventory.

See [API route index](2026-11-06-api-routes.md) for the source-discovered endpoint list and [working-tree snapshot](2026-11-06-working-tree.md) for file status.
