> Historical source snapshot from before the ticket-only scope reduction. Removed human configuration/maintenance routes in this snapshot are no longer mounted. See `../squid-webui-api-architecture.md` for the current integration boundary.

# BanihalOrb API route index

Source snapshot: 6 November 2026; product 2.0.0-dev.0. This index lists mounted route declarations, not successful runtime tests. Authentication, permissions and tenant scope are determined by the router and service implementations. Retired prototype routes are excluded.

## App-level endpoints

| Method | Path |
| --- | --- |
| GET | `/api/version` |
| GET | `/health` |

## /api/auth

Source: `server/src/modules/auth/auth.routes.ts`.

| Method | Path |
| --- | --- |
| POST | `/api/auth/register` |
| POST | `/api/auth/register-user` |
| POST | `/api/auth/login` |
| POST | `/api/auth/mfa/verify` |
| POST | `/api/auth/mfa/resend` |
| POST | `/api/auth/refresh` |
| POST | `/api/auth/logout` |
| POST | `/api/auth/verify-email` |
| POST | `/api/auth/resend-verification` |
| POST | `/api/auth/org-approval/verify` |
| POST | `/api/auth/org-approval/resend` |
| POST | `/api/auth/forgot-password` |
| POST | `/api/auth/reset-password` |

## /api/users

Source: `server/src/modules/users/users.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/users/me` |
| PATCH | `/api/users/me` |
| PATCH | `/api/users/me/password` |
| GET | `/api/users` |
| POST | `/api/users/invite` |
| PATCH | `/api/users/:id/role` |
| DELETE | `/api/users/:id` |

## /api/organizations

Source: `server/src/modules/organizations/organizations.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/organizations/me` |
| PATCH | `/api/organizations/me` |
| PATCH | `/api/organizations/me/security` |
| GET | `/api/organizations/me/services` |

## /api/chat

Source: `server/src/modules/chat/chat.routes.ts`.

| Method | Path |
| --- | --- |
| POST | `/api/chat` |
| GET | `/api/chat/sessions` |
| GET | `/api/chat/sessions/:id` |
| DELETE | `/api/chat/sessions/:id` |

## /api/agent

Source: `server/src/modules/agent/agent.routes.ts`.

| Method | Path |
| --- | --- |
| POST | `/api/agent/chat` |
| GET | `/api/agent/top-complaints` |

## /api/requests

Source: `server/src/modules/requests/requests.routes.ts`.

| Method | Path |
| --- | --- |
| POST | `/api/requests` |
| GET | `/api/requests` |
| GET | `/api/requests/org` |
| GET | `/api/requests/:id` |
| PATCH | `/api/requests/:id/close` |

## /api/announcements

Source: `server/src/modules/announcements/announcements.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/announcements` |

## /api/ticketing

Source: `server/src/modules/ticketing/ticketing.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/ticketing/tickets` |
| POST | `/api/ticketing/tickets` |
| GET | `/api/ticketing/tickets/:id` |
| GET | `/api/ticketing/projects` |
| GET | `/api/ticketing/assignees` |
| GET | `/api/ticketing/mention-candidates` |
| GET | `/api/ticketing/tickets/:id/comments` |
| POST | `/api/ticketing/tickets/:id/comments` |
| GET | `/api/ticketing/tickets/:id/activity` |
| GET | `/api/ticketing/tickets/:id/attachments` |
| POST | `/api/ticketing/tickets/:id/attachments` |
| GET | `/api/ticketing/attachments/:id/download` |
| GET | `/api/ticketing/tickets/:id/watchers` |
| POST | `/api/ticketing/tickets/:id/watch` |
| DELETE | `/api/ticketing/tickets/:id/watch` |
| GET | `/api/ticketing/my-updates` |
| POST | `/api/ticketing/tickets/:id/escalate` |
| GET | `/api/ticketing/customers` |
| GET | `/api/ticketing/admin/escalation-alerts` |
| POST | `/api/ticketing/admin/tickets/:id/claim` |
| POST | `/api/ticketing/tickets/:id/approve` |
| POST | `/api/ticketing/tickets/:id/decline` |
| PATCH | `/api/ticketing/tickets/:id` |
| POST | `/api/ticketing/projects` |
| PATCH | `/api/ticketing/projects/:id` |
| DELETE | `/api/ticketing/projects/:id` |
| GET | `/api/ticketing/activity` |
| GET | `/api/ticketing/slas` |
| POST | `/api/ticketing/slas` |
| PATCH | `/api/ticketing/slas/:id` |
| DELETE | `/api/ticketing/slas/:id` |
| GET | `/api/ticketing/dashboard` |
| GET | `/api/ticketing/stats` |
| GET | `/api/ticketing/analytics` |
| GET | `/api/ticketing/reports` |
| GET | `/api/ticketing/alerts` |

## /api/slack-bots

Source: `server/src/modules/slack-bots/slackBots.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/slack-bots` |
| GET | `/api/slack-bots/customers` |
| POST | `/api/slack-bots` |
| GET | `/api/slack-bots/:id` |
| PATCH | `/api/slack-bots/:id` |
| DELETE | `/api/slack-bots/:id` |
| POST | `/api/slack-bots/:id/connect` |
| POST | `/api/slack-bots/:id/disconnect` |
| POST | `/api/slack-bots/:id/api-key` |
| POST | `/api/slack-bots/:id/worker-key` |
| DELETE | `/api/slack-bots/:id/worker-key` |
| GET | `/api/slack-bots/:id/fields` |
| POST | `/api/slack-bots/:id/fields` |
| PATCH | `/api/slack-bots/:id/fields/:fieldId` |
| DELETE | `/api/slack-bots/:id/fields/:fieldId` |
| GET | `/api/slack-bots/:id/orgs` |
| POST | `/api/slack-bots/:id/orgs` |
| DELETE | `/api/slack-bots/:id/orgs/:customerId` |
| PATCH | `/api/slack-bots/:id/orgs/:customerId/approval-channel` |

## /api/bot-worker

Source: `server/src/modules/slack-bots/botWorker.routes.ts`.

| Method | Path |
| --- | --- |
| POST | `/api/bot-worker/:botId/provision` |
| POST | `/api/bot-worker/:botId/heartbeat` |
| POST | `/api/bot-worker/:botId/message` |
| GET | `/api/bot-worker/:botId/status` |
| POST | `/api/bot-worker/:botId/request` |
| POST | `/api/bot-worker/:botId/state` |
| POST | `/api/bot-worker/:botId/command-result` |

## /api/slack/link

Source: `server/src/modules/slack-bots/slackLink.routes.ts`.

| Method | Path |
| --- | --- |
| POST | `/api/slack/link` |

## /api/bots

Source: `server/src/modules/bots/bots.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/bots` |
| POST | `/api/bots/:id/tickets` |

## /api/ad-ingest

Source: `server/src/modules/ad-secrets/adIngest.routes.ts`.

| Method | Path |
| --- | --- |
| POST | `/api/ad-ingest/deliver` |

## /api/ad-secrets

Source: `server/src/modules/ad-secrets/adSecrets.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/ad-secrets` |
| POST | `/api/ad-secrets/:id/reveal` |

## /api/external

Source: `server/src/modules/external-api/external.routes.ts`.

| Method | Path |
| --- | --- |
| POST | `/api/external/token` |
| POST | `/api/external/webhooks/ticket-status` |
| GET | `/api/external/search` |
| GET | `/api/external/projects` |
| GET | `/api/external/tickets` |
| POST | `/api/external/tickets` |
| GET | `/api/external/tickets/:id` |
| PATCH | `/api/external/tickets/:id` |
| GET | `/api/external/tickets/:id/comments` |
| POST | `/api/external/tickets/:id/comments` |

## /api/external-admin

Source: `server/src/modules/external-api/external-admin.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/external-admin` |
| POST | `/api/external-admin` |
| POST | `/api/external-admin/:clientId/revoke` |
| GET | `/api/external-admin/:clientId/webhooks` |
| POST | `/api/external-admin/:clientId/webhooks` |
| DELETE | `/api/external-admin/webhooks/:id` |

## /api/push

Source: `server/src/modules/push/push.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/push/vapid-public-key` |
| POST | `/api/push/subscribe` |
| POST | `/api/push/unsubscribe` |

## /api/notifications

Source: `server/src/modules/notifications/notifications.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/notifications` |
| POST | `/api/notifications/read-all` |
| POST | `/api/notifications/:id/read` |

## /api/squid

Source: `server/src/modules/squid/squid.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/squid` |
| GET | `/api/squid/bundle-key` |
| GET | `/api/squid/:proxyId` |
| GET | `/api/squid/:proxyId/change-requests` |
| POST | `/api/squid/:proxyId/change-requests` |
| GET | `/api/squid/:proxyId/status` |
| GET | `/api/squid/:proxyId/change-requests/stream` |
| GET | `/api/squid/:proxyId/telemetry` |
| GET | `/api/squid/:proxyId/host-config` |
| GET | `/api/squid/:proxyId/activity` |
| GET | `/api/squid/:proxyId/report.csv` |
| POST | `/api/squid/:proxyId/dependency-scan` |
| POST | `/api/squid` |
| PATCH | `/api/squid/:proxyId` |
| DELETE | `/api/squid/:proxyId` |
| POST | `/api/squid/:proxyId/rotate-key` |
| POST | `/api/squid/:proxyId/verify-token` |
| GET | `/api/squid/:proxyId/branches` |
| POST | `/api/squid/:proxyId/branches` |
| PATCH | `/api/squid/:proxyId/branches/:branchId` |
| DELETE | `/api/squid/:proxyId/branches/:branchId` |
| PUT | `/api/squid/:proxyId/branches/:branchId/lists` |
| PUT | `/api/squid/:proxyId/ports` |
| PUT | `/api/squid/:proxyId/full-access` |
| POST | `/api/squid/:proxyId/external-api-key` |
| DELETE | `/api/squid/:proxyId/external-api-key` |
| POST | `/api/squid/:proxyId/reload` |
| POST | `/api/squid/:proxyId/restart` |
| POST | `/api/squid/:proxyId/rescan` |
| GET | `/api/squid/:proxyId/bandwidth` |
| GET | `/api/squid/:proxyId/certificates` |
| POST | `/api/squid/:proxyId/certificates/ca` |
| POST | `/api/squid/:proxyId/certificates/import` |
| POST | `/api/squid/:proxyId/certificates/csr` |
| POST | `/api/squid/:proxyId/backups` |
| GET | `/api/squid/:proxyId/backups` |
| POST | `/api/squid/:proxyId/backups/:backupId/restore` |
| POST | `/api/squid/:proxyId/factory-reset` |
| GET | `/api/squid/:proxyId/package-status` |

## /api/saas-admin/squid

Source: `server/src/modules/squid/squid-admin.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/saas-admin/squid` |
| GET | `/api/saas-admin/squid/:proxyId` |
| GET | `/api/saas-admin/squid/:proxyId/host-config` |
| GET | `/api/saas-admin/squid/:proxyId/telemetry` |
| GET | `/api/saas-admin/squid/:proxyId/change-requests` |
| POST | `/api/saas-admin/squid/:proxyId/rotate-key` |
| POST | `/api/saas-admin/squid/:proxyId/lock` |
| POST | `/api/saas-admin/squid/:proxyId/enable` |
| POST | `/api/saas-admin/squid/provision` |
| POST | `/api/saas-admin/squid/:proxyId/reassign` |
| POST | `/api/saas-admin/squid/:proxyId/disable` |
| DELETE | `/api/saas-admin/squid/:proxyId` |
| POST | `/api/saas-admin/squid/:proxyId/reload` |
| POST | `/api/saas-admin/squid/:proxyId/restart` |
| POST | `/api/saas-admin/squid/:proxyId/rescan` |
| GET | `/api/saas-admin/squid/:proxyId/bandwidth` |
| GET | `/api/saas-admin/squid/:proxyId/certificates` |
| POST | `/api/saas-admin/squid/:proxyId/certificates/ca` |
| POST | `/api/saas-admin/squid/:proxyId/certificates/import` |
| POST | `/api/saas-admin/squid/:proxyId/certificates/csr` |
| POST | `/api/saas-admin/squid/:proxyId/backups` |
| GET | `/api/saas-admin/squid/:proxyId/backups` |
| POST | `/api/saas-admin/squid/:proxyId/backups/:backupId/restore` |
| POST | `/api/saas-admin/squid/:proxyId/factory-reset` |
| GET | `/api/saas-admin/squid/:proxyId/package-status` |

## /api/proxy-agent

Source: `server/src/modules/squid/squid-agent.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/proxy-agent/public-key` |
| GET | `/api/proxy-agent/poll` |
| POST | `/api/proxy-agent/result` |
| POST | `/api/proxy-agent/telemetry` |
| GET | `/api/proxy-agent/ticketing-config` |

## /api/saas-admin

Source: `server/src/modules/saas-admin/saas-admin.routes.ts`.

| Method | Path |
| --- | --- |
| GET | `/api/saas-admin/roles` |
| GET | `/api/saas-admin/roles/catalog` |
| POST | `/api/saas-admin/roles` |
| PATCH | `/api/saas-admin/roles/:id` |
| DELETE | `/api/saas-admin/roles/:id` |
| GET | `/api/saas-admin/orgs` |
| GET | `/api/saas-admin/orgs/overview` |
| GET | `/api/saas-admin/orgs/pending` |
| POST | `/api/saas-admin/orgs/:id/reissue-approval` |
| PATCH | `/api/saas-admin/orgs/:id` |
| DELETE | `/api/saas-admin/orgs/:id` |
| GET | `/api/saas-admin/orgs/:id/detail` |
| GET | `/api/saas-admin/admins` |
| GET | `/api/saas-admin/all-users` |
| POST | `/api/saas-admin/impersonate/:userId` |
| POST | `/api/saas-admin/impersonate` |
| PATCH | `/api/saas-admin/users/:id` |
| DELETE | `/api/saas-admin/users/:id` |
| POST | `/api/saas-admin/users/:id/reset-password` |
| GET | `/api/saas-admin/metrics` |
| GET | `/api/saas-admin/top-clients` |
| GET | `/api/saas-admin/sla-breaches` |
| GET | `/api/saas-admin/chat-analytics` |
| GET | `/api/saas-admin/escalations` |
| PATCH | `/api/saas-admin/escalations/:id` |
| GET | `/api/saas-admin/announcements` |
| POST | `/api/saas-admin/announcements` |
| PATCH | `/api/saas-admin/announcements/:id` |
| DELETE | `/api/saas-admin/announcements/:id` |
| GET | `/api/saas-admin/requests` |
| PATCH | `/api/saas-admin/requests/:id` |
| GET | `/api/saas-admin/services` |
| POST | `/api/saas-admin/customers/:customerId/services` |
| PATCH | `/api/saas-admin/services/:id` |
| POST | `/api/saas-admin/services/:id/renew` |
| DELETE | `/api/saas-admin/services/:id` |
| GET | `/api/saas-admin/catalog` |
| POST | `/api/saas-admin/catalog` |
| PATCH | `/api/saas-admin/catalog/:id` |
| DELETE | `/api/saas-admin/catalog/:id` |
| GET | `/api/saas-admin/flags` |
| PATCH | `/api/saas-admin/flags/:key` |
| GET | `/api/saas-admin/ticket-number-format` |
| PUT | `/api/saas-admin/ticket-number-format` |
| GET | `/api/saas-admin/activity` |
| GET | `/api/saas-admin/system-activity` |
| GET | `/api/saas-admin/logins-by-org` |
| GET | `/api/saas-admin/sadmins` |
| POST | `/api/saas-admin/staff` |
| PATCH | `/api/saas-admin/sadmins/:id` |
| DELETE | `/api/saas-admin/sadmins/:id` |
| POST | `/api/saas-admin/sadmins/:id/reset-password` |
| GET | `/api/saas-admin/password-reuse` |

## Additional Squid control routes

Source: `server/src/modules/squid/squidControl.routes.ts`. Platform-only declarations are included only on the platform mount.

| Method | Path |
| --- | --- |
| GET | `/api/saas-admin/squid/clients` |
| POST | `/api/saas-admin/squid/automation/global` |
| POST | `/api/saas-admin/squid/clients/:customerId/automation` |
| POST | `/api/saas-admin/squid/:proxyId/machine-identity` |
| POST | `/api/saas-admin/squid/:proxyId/workers/:botId/machine-identity` |
| POST | `/api/saas-admin/squid/:proxyId/change-requests` |
| GET | `/api/saas-admin/squid/:proxyId/automation` |
| POST | `/api/saas-admin/squid/:proxyId/automation` |
| GET | `/api/squid/:proxyId/automation` |
| POST | `/api/squid/:proxyId/automation` |

## Retired paths

Authenticated requests to `/api/orb` and `/api/squid-web` reach a 410 retirement response. They are not supported machine control APIs. The unused `squid-web.routes.ts` source file is not mounted.

Index contains 260 method/path declarations, including the two app-level reads. Routes with host-operation placeholders remain listed for transparency; see the feature inventory for their limitations.
