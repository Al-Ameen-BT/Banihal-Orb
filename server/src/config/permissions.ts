// ─── Platform permission registry ────────────────────────────────────────────
// The keys that exist are CODE (this file). Which keys a role holds is DATA
// (PlatformRole.permissions), editable from the roles matrix at runtime.
//
// These govern the VENDOR'S OWN STAFF only. A customer role (USER / ORG_ADMIN)
// can never hold one — `can()` in middleware/rbac.middleware.ts returns false for
// them before it looks at anything else, so customer authorization stays exactly
// where it was: requireRole().
//
// Adding a key: add it here, then decide which seeded roles get it in
// db/b2b.sql. `administration` needs no edit — it is computed as "everything", so
// a new key is automatically held by administrators and can never lock them out.

export const PERMISSIONS = [
  // Platform surfaces — the vendor's cross-tenant control surfaces.
  { key: 'nav.control_plane',        group: 'Platform',    label: 'Control Plane' },
  { key: 'catalog.manage',           group: 'Platform',    label: 'Service Catalog' },
  { key: 'customer_services.manage', group: 'Platform',    label: 'Customer Services' },
  { key: 'orgs.manage',              group: 'Platform',    label: 'Organizations, flags & impersonation' },
  // Deliberately NOT part of orgs.manage. Renaming an organization and destroying
  // it — every user, ticket, attachment and chat session across four databases,
  // irreversibly — are different decisions, and in an editable matrix they must be
  // togglable independently. Seeded to Administration (computed) and HR Admin only.
  { key: 'orgs.delete',              group: 'Platform',    label: 'Delete an organization' },
  // Admitting a newly self-registered organization to the platform. Holders receive
  // the approval code by email and decide, off-platform, whether to pass it on — so
  // this key is the entire admission control for the product. Separate from
  // orgs.manage for the same reason orgs.delete is: letting someone edit an existing
  // customer is a different decision from letting them create new ones.
  //
  // Seeded to Administration (computed) and HR Admin.
  { key: 'orgs.approve',             group: 'Platform',    label: 'Approve new organizations' },
  { key: 'platform_audit.view',      group: 'Platform',    label: 'Audit log, logins & staff directory' },
  // The System Activity workspace: the cross-tenant audit trail of every action
  // on the platform. Split from platform_audit.view so it can be held ALONE —
  // that key also opens the staff directory and the Sadmin feed on the Users
  // page, so gating the workspace on it would have handed the full audit trail
  // to every role that merely needs to see who the staff are.
  //
  // No seed edit grants this: `administration` is computed as every key, and no
  // other seeded role lists it — so today it is Administration-only, and the
  // roles API can widen that later without a deploy.
  { key: 'system_activity.view',     group: 'Platform',    label: 'System activity workspace' },
  // Financial figures (platform MRR). Deliberately its OWN key rather than
  // riding on nav.control_plane: revenue visibility is a separate decision from
  // control-plane access, and in an editable matrix the two must be togglable
  // independently — otherwise granting someone the control plane silently hands
  // them the finances too.
  { key: 'revenue.view',             group: 'Platform',    label: 'Revenue figures' },

  // Identity.
  { key: 'users.manage',             group: 'Identity',    label: 'Users' },
  { key: 'staff.invite',             group: 'Identity',    label: 'Invite platform staff' },
  { key: 'roles.manage',             group: 'Identity',    label: 'Roles & permissions' },

  // Workspace.
  { key: 'services.view',            group: 'Workspace',   label: 'Services' },
  { key: 'nav.chat',                 group: 'Workspace',   label: 'Assistant' },

  // Ticketing. The view/write split is what makes an Intern read-only.
  { key: 'tickets.view',             group: 'Ticketing',   label: 'View, create and comment on tickets' },
  { key: 'tickets.write',            group: 'Ticketing',   label: 'Change status / assignee, manage projects & SLAs' },
  // Administration-level ticketing override. `tickets.write` alone keeps the
  // OWNER-BASED edit lock (staff may only edit tickets they created or are
  // assigned); holding `tickets.manage` additionally allows editing ANY ticket
  // the caller's store scope reaches, and deletes empty projects. Seeded roles
  // do NOT list it — `administration` is computed as every key, so the
  // Administrator role holds it automatically, and any custom platform role can
  // be granted it from the roles matrix without a deploy.
  { key: 'tickets.manage',           group: 'Ticketing',   label: 'Edit all tickets; delete empty projects' },
  // ⚠ SECURITY BOUNDARY, not a feature toggle. This decides which DATABASE a
  // ticketing request reads (b2b_ticketing_admin vs the shared b2b_ticket), and
  // therefore whether access.ts applies a per-row owner filter. It is consulted
  // by the router-level can() in modules/ticketing/ticketing.routes.ts — read
  // that and access.ts before changing it.
  //
  // can() refuses every customer role outright, so USER / ORG_ADMIN are pinned to
  // the shared store no matter what the database says about their platform role.
  { key: 'ticket.store.admin',       group: 'Ticketing',   label: 'Internal (platform) ticket queue' },

  { key: 'credentials.view',         group: 'Credentials', label: 'Credential deliveries' },
  { key: 'credentials.reveal',       group: 'Credentials', label: 'Reveal a credential secret' },

  { key: 'bots.view',                group: 'Slack Bots',  label: 'View Slack bots' },
  { key: 'bots.manage',              group: 'Slack Bots',  label: 'Connect, disconnect & generate keys' },

  // Squid proxy control. `squid.view` reads any organization's proxy config &
  // status; `squid.manage` edits rules, reloads squid and rotates agent keys for
  // any org (cross-tenant, via /api/saas-admin/squid). Neither is seeded — the
  // Administration role computes as ALL keys automatically, so Administrators
  // hold both, and the roles matrix decides which employee/intern-tier staff do.
  { key: 'squid.view',               group: 'Squid Proxy', label: 'View all organizations’ squid proxies' },
  { key: 'squid.manage',             group: 'Squid Proxy', label: 'Edit rules, reload & rotate agent keys (any org)' },
  { key: 'squid.pause.global',       group: 'Squid Proxy', label: 'Pause or resume proxy automation for all clients' },

  // External ticketing API — machine credentials consumers use to reach the
  // /api/external surface. Issuing a key prints a raw secret exactly once, and
  // revoking one cuts off every integration holding it, so write access is a
  // separate decision from merely seeing the registry. Seeded roles do NOT list
  // it — `administration` is computed as every key, and any custom platform role
  // can be granted it from the roles matrix without a deploy.
  { key: 'external_api.view',        group: 'External API', label: 'View API keys & webhooks' },
  { key: 'external_api.manage',      group: 'External API', label: 'Create, revoke keys & manage webhooks' },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.map((p) => p.key);

const KEY_SET = new Set<string>(ALL_PERMISSION_KEYS);
export const isPermissionKey = (k: string): k is PermissionKey => KEY_SET.has(k);

/** The role key whose holders implicitly hold every permission. */
export const ADMINISTRATION_ROLE_KEY = 'administration';

// My Profile deliberately has NO key. A permission that is always true is dead
// config, and revoking it would break password change and the MFA toggle.
