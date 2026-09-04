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
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.map((p) => p.key);

const KEY_SET = new Set<string>(ALL_PERMISSION_KEYS);
export const isPermissionKey = (k: string): k is PermissionKey => KEY_SET.has(k);

/** The role key whose holders implicitly hold every permission. */
export const ADMINISTRATION_ROLE_KEY = 'administration';

// My Profile deliberately has NO key. A permission that is always true is dead
// config, and revoking it would break password change and the MFA toggle.
