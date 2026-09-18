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
  { key: 'CUSTOMER_CREATED',                                                            defaultScope: true,  sadminFeed: false },
  { key: 'ORG_DELETED',                                                                 defaultScope: true,  sadminFeed: true  },
  { key: 'ORG_DELETE_FAILED',                                                           defaultScope: true,  sadminFeed: true  },
  { key: 'ORG_UPDATED',                                                                 defaultScope: true,  sadminFeed: true  },
  // ── Platform admission. sadminFeed on all four: admitting an organization is a
  //    staff decision made off-platform, so the audit trail is the only record
  //    that it happened and who was in a position to make it.
  { key: 'ORG_APPROVAL_REQUESTED',                                                      defaultScope: true,  sadminFeed: true  },
  { key: 'ORG_APPROVED',                                                                defaultScope: true,  sadminFeed: true  },
  { key: 'ORG_APPROVAL_FAILED',                                                         defaultScope: true,  sadminFeed: true  },
  // Fires when NO staff member holds `orgs.approve`, which means no one can admit
  // the org and the signup is stranded. Surfaced in the feed rather than only in
  // logs, because nothing else would reveal it until a customer complained.
  { key: 'ORG_APPROVAL_NO_RECIPIENTS',                                                  defaultScope: true,  sadminFeed: true  },
  { key: 'USER_REGISTERED',                                                             defaultScope: true,  sadminFeed: false },
  { key: 'USER_INVITED',                                                                defaultScope: true,  sadminFeed: false },
  { key: 'USER_REMOVED',                                                                defaultScope: true,  sadminFeed: false },
  { key: 'USER_ROLE_CHANGED',                                                           defaultScope: true,  sadminFeed: false },
  { key: 'USER_PROFILE_UPDATED',                                                        defaultScope: false, sadminFeed: false },
  { key: 'ADMIN_USER_UPDATE',                                                           defaultScope: true,  sadminFeed: true  },
  { key: 'ADMIN_USER_REMOVE',                                                           defaultScope: true,  sadminFeed: true  },
  { key: 'ADMINISTRATOR_STAFF_INVITED',                                                 defaultScope: true,  sadminFeed: true  },
  { key: 'ADMINISTRATOR_SADMIN_UPDATE',                                                 defaultScope: true,  sadminFeed: true  },
  { key: 'ADMINISTRATOR_SADMIN_REMOVE',                                                 defaultScope: true,  sadminFeed: true  },

  // ── Session & credentials.
  { key: 'LOGIN',                                                                       defaultScope: true,  sadminFeed: true  },
  { key: 'LOGOUT',                                                                      defaultScope: true,  sadminFeed: true  },
  { key: 'LOGIN_TRUSTED_DEVICE',                                                        defaultScope: true,  sadminFeed: true  },
  { key: 'LOGIN_BLOCKED_ACTIVE_SESSION',                                                defaultScope: true,  sadminFeed: true  },
  { key: 'MFA_CHALLENGE_SENT',                                                          defaultScope: false, sadminFeed: false },
  { key: 'EMAIL_VERIFIED',                                                              defaultScope: true,  sadminFeed: false },
  { key: 'PASSWORD_RESET',                                                              defaultScope: true,  sadminFeed: false },
  { key: 'PASSWORD_CHANGED',                                                            defaultScope: true,  sadminFeed: false },
  { key: 'ADMIN_PASSWORD_RESET',                                                        defaultScope: true,  sadminFeed: true  },
  { key: 'ADMINISTRATOR_SADMIN_PASSWORD_RESET',                                         defaultScope: true,  sadminFeed: true  },
  // The single most sensitive thing staff can do — it was missing from the feed
  // that exists to show what staff do.
  { key: 'IMPERSONATE',                                                                 defaultScope: true,  sadminFeed: true  },
  { key: 'IMPERSONATE_REDEEM',                                                          defaultScope: true,  sadminFeed: true  },

  // ── Permissions. Mutating the IAM matrix decides who holds users.manage and
  //    credentials.reveal; it was entirely unlogged before.
  { key: 'ROLE_CREATED',                                                                defaultScope: true,  sadminFeed: true  },
  { key: 'ROLE_UPDATED',                                                                defaultScope: true,  sadminFeed: true  },
  { key: 'ROLE_DELETED',                                                                defaultScope: true,  sadminFeed: true  },

  // ── Credentials.
  { key: 'AD_SECRET_DELIVERED',                                                         defaultScope: false, sadminFeed: false },
  { key: 'AD_SECRET_VIEWED',                                                            defaultScope: true,  sadminFeed: true  },
  { key: 'BOT_API_KEY_GENERATED',                                                       defaultScope: true,  sadminFeed: true  },

  // ── Services & catalog.
  { key: 'SERVICE_ASSIGNED',                                                            defaultScope: false, sadminFeed: false },
  { key: 'SERVICE_RENEWED',                                                             defaultScope: false, sadminFeed: false },
  { key: 'SERVICE_REMOVED',                                                             defaultScope: false, sadminFeed: false },
  { key: 'CUSTOMER_SERVICE_UPDATED',                                                    defaultScope: false, sadminFeed: false },
  { key: 'UPDATE_SERVICE_REQUEST',                                                      defaultScope: false, sadminFeed: false },
  { key: 'ESCALATION_UPDATED',                                                          defaultScope: false, sadminFeed: false },

  // ── Squid proxy control. Config changes are network-policy mutations and
  //    cross-tenant for staff (ADMINISTRATOR and squid.manage holders), so the
  //    rows are sadminFeed-worthy like every other staff credential/control
  //    action. Reload/apply are high-ish volume but each one is a live policy
  //    change — keep them in the default scope so "what changed" never needs a
  //    filter first. Locks (subscription expiry) and proxy disabling are
  //    irreversible-enough governance events: defaultScope true.
  { key: 'SQUID_SERVICE_PROVISIONED',                                                   defaultScope: true,  sadminFeed: true  },
  { key: 'SQUID_PROXY_KEY_GENERATED',                                                   defaultScope: true,  sadminFeed: true  },
  { key: 'SQUID_TOKEN_VERIFIED',                                                        defaultScope: false, sadminFeed: false },
  { key: 'SQUID_TOKEN_VERIFY_FAILED',                                                   defaultScope: false, sadminFeed: false },
  { key: 'SQUID_DEPENDENCY_SCAN',                                                       defaultScope: true,  sadminFeed: false },
  { key: 'SQUID_BRANCH_CREATED',                                                        defaultScope: true,  sadminFeed: false },
  { key: 'SQUID_BRANCH_UPDATED',                                                        defaultScope: true,  sadminFeed: false },
  { key: 'SQUID_BRANCH_DELETED',                                                        defaultScope: true,  sadminFeed: false },
  { key: 'SQUID_LIST_UPDATED',                                                          defaultScope: true,  sadminFeed: false },
  { key: 'SQUID_NETWORK_UPDATED',                                                       defaultScope: true,  sadminFeed: false },
  { key: 'SQUID_RELOAD_REQUESTED',                                                      defaultScope: true,  sadminFeed: true  },
  { key: 'SQUID_APPLY_RESULT',                                                          defaultScope: false, sadminFeed: false },
  { key: 'SQUID_CONFIG_LOCKED',                                                         defaultScope: true,  sadminFeed: true  },
  { key: 'SQUID_PROXY_DISABLED',                                                        defaultScope: true,  sadminFeed: true  },
  { key: 'SQUID_PROXY_ENABLED',                                                         defaultScope: true,  sadminFeed: true  },
  { key: 'SQUID_AGENT_AUTH_FAILED',                                                     defaultScope: false, sadminFeed: true  },

  // ── Slack identity linking (Phase C). Issuing a link code is a low-volume,
  //    user-initiated event; binding a Slack member id is a security-relevant
  //    authorization decision that needs a paper trail — both feed-worthy.
  { key: 'SLACK_LINK_CODE_ISSUED',                                                      defaultScope: true,  sadminFeed: true  },
  { key: 'SLACK_IDENTITY_LINKED',                                                       defaultScope: true,  sadminFeed: true  },
  { key: 'BOT_TOKEN_ROTATED',                                                           defaultScope: true,  sadminFeed: true  },

  // ── Ticketing. The module wrote NO audit rows at all before this: the only
  //    record of a ticket's history was the per-ticket Activities table in the
  //    ticket store, which is ON DELETE CASCADE on the ticket — so deleting a
  //    ticket destroyed its own history along with it. These rows live in the
  //    main database and survive that.
  //
  //    Create/update are defaultScope:false deliberately — they are the highest
  //    volume events on the platform and would drown System Activity's unfiltered
  //    view. Deletion and escalation are not: one is irreversible, the other moves
  //    a ticket across the org → platform boundary. (Tickets themselves are never
  //    deleted — compliance records — only a project that holds no tickets can go.)
  { key: 'TICKET_CREATED',                                                              defaultScope: false, sadminFeed: false },
  { key: 'TICKET_UPDATED',                                                              defaultScope: false, sadminFeed: false },
  { key: 'TICKET_ESCALATED',                                                            defaultScope: true,  sadminFeed: false },
  { key: 'TICKET_CLAIMED',                                                              defaultScope: false, sadminFeed: true  },
  // A project can only be deleted while it holds no tickets (tickets are compliance
  // records), so this never destroys ticket history — irreversible for the project
  // itself, and the audit row is its only surviving record.
  { key: 'PROJECT_DELETED',                                                             defaultScope: true,  sadminFeed: true  },

  // ── External ticketing API (machine credentials + approval decisions).
  //    Key/webhook issuance is a staff credential decision — feed-worthy like
  //    BOT_API_KEY_GENERATED. Approval decisions are defaultScope:false (high
  //    volume, drowns the feed) but the rows are what answer "who let this
  //    bot flow through, and when".
  { key: 'EXTERNAL_KEY_CREATED',                                                        defaultScope: true,  sadminFeed: true  },
  { key: 'EXTERNAL_KEY_REVOKED',                                                        defaultScope: true,  sadminFeed: true  },
  { key: 'EXTERNAL_WEBHOOK_CREATED',                                                    defaultScope: false, sadminFeed: false },
  { key: 'EXTERNAL_WEBHOOK_UPDATED',                                                    defaultScope: false, sadminFeed: false },
  { key: 'EXTERNAL_WEBHOOK_DELETED',                                                    defaultScope: false, sadminFeed: false },
  { key: 'TICKET_APPROVAL_REQUESTED',                                                   defaultScope: false, sadminFeed: false },
  { key: 'TICKET_APPROVED',                                                             defaultScope: false, sadminFeed: false },
  { key: 'TICKET_DECLINED',                                                             defaultScope: false, sadminFeed: false },

  // ── Configuration.
  { key: 'ANNOUNCEMENT_CREATED',                                                        defaultScope: false, sadminFeed: false },
  { key: 'ANNOUNCEMENT_DELETED',                                                        defaultScope: false, sadminFeed: false },
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number]['key'];

/** Shown when no action filter is applied — the answer to "what happened here?". */
export const DEFAULT_SCOPE_ACTIONS: AuditAction[] =
  AUDIT_ACTIONS.filter((a) => a.defaultScope).map((a) => a.key);

/** The Sadmin Activity feed: what platform staff did that others should notice. */
export const SADMIN_FEED_ACTIONS: AuditAction[] =
  AUDIT_ACTIONS.filter((a) => a.sadminFeed).map((a) => a.key);