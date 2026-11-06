# Working-tree snapshot before push

Date: 6 November 2026. Baseline HEAD: `f8cfb5e710fafcfcbf48d651b037297b488381ee`. No staging, commit or push was performed. Snapshot includes inventory files.

Status counts: ` D`: 3, ` M`: 39, `??`: 47.

` M` = modified tracked; ` D` = deleted tracked; `??` = untracked. Untracked files are not included in ordinary `git diff --stat`.

```text
 M .github/workflows/ci-cd.yml
 M .gitignore
 M README.md
 M client/next.config.js
 M client/package-lock.json
 M client/package.json
 M client/src/app/clients/page.tsx
 D client/src/app/squid/[id]/requests/page.tsx
 D client/src/app/squid/[id]/rules/page.tsx
 D client/src/app/squid/[id]/status/page.tsx
 M client/src/components/ui/Sidebar.tsx
 M client/src/lib/api.ts
 M deploy.sh
 M deploy/nginx/b2b-site.conf
 M deploy/nginx/b2b-site.container.conf
 M deploy/podman/b2b-api.container
 M deploy/podman/build.sh
 M server/.env.example
 M server/db/provision.sh
 M server/package-lock.json
 M server/package.json
 M server/prisma/schema.prisma
 M server/src/app.ts
 M server/src/config/database.ts
 M server/src/config/env.ts
 M server/src/config/permissions.ts
 M server/src/lib/machineAuth.ts
 M server/src/modules/slack-bots/botWorker.routes.ts
 M server/src/modules/slack-bots/botWorker.schema.ts
 M server/src/modules/squid/bundleSigning.ts
 M server/src/modules/squid/squid-admin.routes.ts
 M server/src/modules/squid/squid-agent.routes.ts
 M server/src/modules/squid/squid.controller.ts
 M server/src/modules/squid/squid.routes.ts
 M server/src/modules/squid/squid.schema.ts
 M server/src/modules/squid/squid.service.ts
 M server/src/modules/squid/squidBot.service.ts
 M server/src/modules/squid/squidBotStore.ts
 M server/src/modules/ticketing/ticketing.schema.ts
 M server/src/modules/ticketing/ticketing.service.ts
 M server/src/server.ts
 M server/tests/machineAuth.test.ts
?? .impeccable/config.json
?? CHANGELOG.md
?? PHASE1-IMPLEMENTATION-SUMMARY.md
?? VERSION
?? client/src/app/squid/page.tsx
?? deploy/nginx/squid-machines.conf.example
?? deploy/squid/agent.py
?? deploy/squid/machine_client.py
?? deploy/squid/managed_mode.py
?? deploy/squid/platform_writer.py
?? deploy/squid/squid-agent.service
?? deploy/squid/test_machine_client.py
?? deploy/squid/test_managed_mode.py
?? deploy/squid/test_platform_writer.py
?? deploy/squid/test_worker_executor.py
?? deploy/squid/webui-managed.patch
?? deploy/squid/worker_executor.py
?? design-requirements.md
?? docs/decisions/ADR-003-squid-host-api-consolidation.md
?? docs/pre-push/2026-11-06-api-routes.md
?? docs/pre-push/2026-11-06-feature-inventory.md
?? docs/pre-push/2026-11-06-working-tree.md
?? docs/squid-outbound-production.md
?? docs/superpowers/plans/2026-11-06-squid-outbound-guardrails.md
?? docs/versioning.md
?? scripts/version.mjs
?? scripts/version.test.mjs
?? server/.env.example.new
?? server/db/2026-11-06-squid-guardrails.sql
?? server/legacy/orb/README.md
?? server/legacy/orb/orb.routes.ts.disabled
?? server/legacy/orb/orbCrypto.ts.disabled
?? server/legacy/orb/orbKeyValidator.ts.disabled
?? server/legacy/orb/ticketing.schema.before-guardrails.ts.disabled
?? server/legacy/orb/ticketing.service.before-guardrails.ts.disabled
?? server/src/lib/machineProtocol.ts
?? server/src/modules/squid/slackWebhook.ts
?? server/src/modules/squid/squid-web.routes.ts
?? server/src/modules/squid/squidAutomation.ts
?? server/src/modules/squid/squidControl.routes.ts
?? server/src/product-version.json
?? server/tests/machine-protocol-v2.test.ts
?? server/tests/squid-automation.test.ts
?? server/tests/squid-control-routes.test.ts
?? server/tests/squid-dispatch-safety.test.ts
?? tasks/plan-squid-api-communications.md
?? tasks/plan-squid-host-api-consolidation.md
```
