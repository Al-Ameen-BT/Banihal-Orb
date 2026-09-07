// ─── Audit action registry ───────────────────────────────────────────────────
// The actions that exist are CODE (this file). Which rows exist is DATA
// (AuditLog.action). Same split, and the same reasoning, as config/permissions.ts.
//
// Before this file the vocabulary lived in three places that could not see each
// other: string literals at ~29 write sites, two separate literal arrays choosing
// what to READ (SYSTEM_ACTIONS / TRACKED_ACTIONS), and a query schema accepting
// any string. A typo at a write site produced rows nothing could ever find, and a
// newly-added action stayed invisible until three more lists were edited by hand.
//
// Adding an action: add it here and use it through lib/audit.ts. `defaultScope`
// decides whether it shows in System Activity / System Logs with NO filter
// applied — which is what made user deletions invisible: they were recorded
// correctly and then excluded by a four-entry default scope.
//
// `sadminFeed` marks what belongs in the "Sadmin Activity" feed on the Users
// page: things platform STAFF do that another administrator should notice.

export const AUDIT_ACTIONS = [
  // ── Accounts & identity. Every one is defaultScope: answering "what happened
  //    to this account" must never require knowing which filter to pick.
  { key: 'CUSTOMER_CREATED',                    group: 'Accounts', label: 'Org created',           defaultScope: true,  sadminFeed: false },
  { key: 'ORG_DELETED',                         group: 'Accounts', label: 'Org deleted',           defaultScope: true,  sadminFeed: true  },
  { key: 'ORG_UPDATED',                         group: 'Accounts', label: 'Org updated',           defaultScope: true,  sadminFeed: true  },
  // ── Platform admission. sadminFeed on all four: admitting an organization is a
  //    staff decision made off-platform, so the audit trail is the only record
  //    that it happened and who was in a position to make it.
  { key: 'ORG_APPROVAL_REQUESTED',              group: 'Accounts', label: 'Approval code issued',  defaultScope: true,  sadminFeed: true  },
  { key: 'ORG_APPROVED',                        group: 'Accounts', label: 'Org approved',          defaultScope: true,  sadminFeed: true  },
  { key: 'ORG_APPROVAL_FAILED',                 group: 'Accounts', label: 'Approval code rejected', defaultScope: true, sadminFeed: true  },
  // Fires when NO staff member holds `orgs.approve`, which means no one can admit
  // the org and the signup is stranded. Surfaced in the feed rather than only in
  // logs, because nothing else would reveal it until a customer complained.
  { key: 'ORG_APPROVAL_NO_RECIPIENTS',          group: 'Accounts', label: 'No approvers available', defaultScope: true, sadminFeed: true  },
  { key: 'USER_REGISTERED',                     group: 'Accounts', label: 'User registered',       defaultScope: true,  sadminFeed: false },
  { key: 'USER_INVITED',                        group: 'Accounts', label: 'User invited',          defaultScope: true,  sadminFeed: false },
  { key: 'USER_REMOVED',                        group: 'Accounts', label: 'User removed',          defaultScope: true,  sadminFeed: false },
  { key: 'USER_ROLE_CHANGED',                   group: 'Accounts', label: 'Role changed',          defaultScope: true,  sadminFeed: false },
  { key: 'USER_PROFILE_UPDATED',                group: 'Accounts', label: 'Profile updated',       defaultScope: false, sadminFeed: false },
  { key: 'ADMIN_USER_UPDATE',                   group: 'Accounts', label: 'User updated',          defaultScope: true,  sadminFeed: true  },
  { key: 'ADMIN_USER_REMOVE',                   group: 'Accounts', label: 'User removed',          defaultScope: true,  sadminFeed: true  },
  { key: 'ADMINISTRATOR_STAFF_INVITED',         group: 'Accounts', label: 'Staff invited',         defaultScope: true,  sadminFeed: true  },
  { key: 'ADMINISTRATOR_SADMIN_UPDATE',         group: 'Accounts', label: 'Staff updated',         defaultScope: true,  sadminFeed: true  },
  { key: 'ADMINISTRATOR_SADMIN_REMOVE',         group: 'Accounts', label: 'Staff removed',         defaultScope: true,  sadminFeed: true  },

  // ── Session & credentials.
  { key: 'LOGIN',                               group: 'Session',  label: 'Logged in',             defaultScope: true,  sadminFeed: true  },
  { key: 'LOGOUT',                              group: 'Session',  label: 'Signed out',            defaultScope: true,  sadminFeed: true  },
  { key: 'LOGIN_TRUSTED_DEVICE',                group: 'Session',  label: 'Logged in (trusted)',   defaultScope: true,  sadminFeed: true  },
  { key: 'LOGIN_BLOCKED_ACTIVE_SESSION',        group: 'Session',  label: 'Login blocked',         defaultScope: true,  sadminFeed: true  },
  { key: 'MFA_CHALLENGE_SENT',                  group: 'Session',  label: 'MFA code sent',         defaultScope: false, sadminFeed: false },
  { key: 'EMAIL_VERIFIED',                      group: 'Session',  label: 'Email confirmed',       defaultScope: true,  sadminFeed: false },
  { key: 'PASSWORD_RESET',                      group: 'Session',  label: 'Password reset',        defaultScope: true,  sadminFeed: false },
  { key: 'PASSWORD_CHANGED',                    group: 'Session',  label: 'Password changed',      defaultScope: true,  sadminFeed: false },
  { key: 'ADMIN_PASSWORD_RESET',                group: 'Session',  label: 'Password reset (admin)', defaultScope: true, sadminFeed: true  },
  { key: 'ADMINISTRATOR_SADMIN_PASSWORD_RESET', group: 'Session',  label: 'Staff password reset',  defaultScope: true,  sadminFeed: true  },
  // The single most sensitive thing staff can do — it was missing from the feed
  // that exists to show what staff do.
  { key: 'IMPERSONATE',                         group: 'Session',  label: 'Impersonated a user',   defaultScope: true,  sadminFeed: true  },
  { key: 'IMPERSONATE_REDEEM',                  group: 'Session',  label: 'Started an impersonated session', defaultScope: true, sadminFeed: true },

  // ── Permissions. Mutating the IAM matrix decides who holds users.manage and
  //    credentials.reveal; it was entirely unlogged before.
  { key: 'ROLE_CREATED',                        group: 'Permissions', label: 'Platform role created', defaultScope: true, sadminFeed: true },
  { key: 'ROLE_UPDATED',                        group: 'Permissions', label: 'Permissions changed',   defaultScope: true, sadminFeed: true },
  { key: 'ROLE_DELETED',                        group: 'Permissions', label: 'Platform role deleted', defaultScope: true, sadminFeed: true },

  // ── Credentials.
  { key: 'AD_SECRET_DELIVERED',                 group: 'Credentials', label: 'Credential delivered', defaultScope: false, sadminFeed: false },
  { key: 'AD_SECRET_VIEWED',                    group: 'Credentials', label: 'Credential revealed',  defaultScope: true,  sadminFeed: true  },
  { key: 'BOT_API_KEY_GENERATED',               group: 'Credentials', label: 'Bot API key issued',   defaultScope: true,  sadminFeed: true  },

  // ── Services & catalog.
  { key: 'SERVICE_ASSIGNED',                    group: 'Services', label: 'Service assigned',      defaultScope: false, sadminFeed: false },
  { key: 'SERVICE_RENEWED',                     group: 'Services', label: 'Service renewed',       defaultScope: false, sadminFeed: false },
  { key: 'SERVICE_REMOVED',                     group: 'Services', label: 'Service removed',       defaultScope: false, sadminFeed: false },
  { key: 'CUSTOMER_SERVICE_UPDATED',            group: 'Services', label: 'Service updated',       defaultScope: false, sadminFeed: false },
  { key: 'UPDATE_SERVICE_REQUEST',              group: 'Services', label: 'Request updated',       defaultScope: false, sadminFeed: false },
  { key: 'ESCALATION_UPDATED',                  group: 'Services', label: 'Escalation updated',    defaultScope: false, sadminFeed: false },

  // ── Ticketing. The module wrote NO audit rows at all before this: the only
  //    record of a ticket's history was the per-ticket Activities table in the
  //    ticket store, which is ON DELETE CASCADE on the ticket — so deleting a
  //    ticket destroyed its own history along with it. These rows live in the
  //    main database and survive that.
  //
  //    Create/update are defaultScope:false deliberately — they are the highest
  //    volume events on the platform and would drown System Activity's unfiltered
  //    view. Deletion and escalation are not: one is irreversible, the other moves
  //    a ticket across the org → platform boundary.
  { key: 'TICKET_CREATED',                      group: 'Ticketing', label: 'Ticket created',       defaultScope: false, sadminFeed: false },
  { key: 'TICKET_UPDATED',                      group: 'Ticketing', label: 'Ticket edited',        defaultScope: false, sadminFeed: false },
  { key: 'TICKET_DELETED',                      group: 'Ticketing', label: 'Ticket deleted',       defaultScope: true,  sadminFeed: true  },
  { key: 'TICKET_ESCALATED',                    group: 'Ticketing', label: 'Ticket escalated',     defaultScope: true,  sadminFeed: false },
  { key: 'TICKET_CLAIMED',                      group: 'Ticketing', label: 'Escalated ticket claimed', defaultScope: false, sadminFeed: true },
  // Deleting a project takes every ticket under it — in the admin store that spans
  // several client organizations at once. defaultScope + sadminFeed for the same
  // reason TICKET_DELETED carries both: irreversible, and previously unlogged
  // entirely, so nothing recorded that a thousand tickets had ever existed.
  { key: 'PROJECT_DELETED',                     group: 'Ticketing', label: 'Project deleted',      defaultScope: true,  sadminFeed: true  },

  // ── Configuration.
  { key: 'ANNOUNCEMENT_CREATED',                group: 'Config',   label: 'Announcement created',  defaultScope: false, sadminFeed: false },
  { key: 'ANNOUNCEMENT_DELETED',                group: 'Config',   label: 'Announcement deleted',  defaultScope: false, sadminFeed: false },
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number]['key'];

/** Shown when no action filter is applied — the answer to "what happened here?". */
export const DEFAULT_SCOPE_ACTIONS: AuditAction[] =
  AUDIT_ACTIONS.filter((a) => a.defaultScope).map((a) => a.key);

/** The Sadmin Activity feed: what platform staff did that others should notice. */
export const SADMIN_FEED_ACTIONS: AuditAction[] =
  AUDIT_ACTIONS.filter((a) => a.sadminFeed).map((a) => a.key);
