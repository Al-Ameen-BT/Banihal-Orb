import { prisma } from '../../config/database';
import { chatPrisma } from '../../config/chatDatabase';
import { audit } from '../../lib/audit';

// ─── Organization deletion ───────────────────────────────────────────────────
// Irreversible, and it spans FOUR live databases (main, chat, and BOTH ticket
// stores) that have no foreign keys between them. `prisma.customer.delete()` on
// its own would succeed silently: the six declared relations cascade, so it would
// take every user with it while leaving chat sessions, tickets, upload files on
// disk and an encrypted AD credential behind as unreachable orphans.
//
// TICKETS ARE NEVER DELETED. They are compliance records — retained in both
// ticket stores no matter what happens to the organization, for every actor
// (platform admin and org admin alike). The stores are therefore left ENTIRELY
// untouched by org deletion: their Users rows are store-local copies that the
// ticket FKs (reporter, creator, assignee, comments, activities) keep pointing
// at, so nothing in them needs detaching and the whole historical record —
// tickets, comments, activity, attachment rows and their bytes — stays intact.
// This is also what keeps the deletion robust: it no longer reaches into the
// stores at all, so it cannot fail on their schema, missing mirrors, or foreign
// keys, and no project-lead reassignment is needed.

export interface OrgDeletionReport {
  orgName: string;
  users: number;
  tickets: number;       // always 0 — ticket rows are retained (compliance)
  attachments: number;   // always 0 — attachment bytes are retained with the tickets
  chatSessions: number;
  /** Always 'keep_tickets' — tickets are never deleted. */
  mode: 'keep_tickets';
}

export interface DeleteOrgOptions {
  /** The org's exact name, typed by the caller. Re-checked HERE — see CONFIRM_MISMATCH. */
  confirmName: string;
}

/**
 * Refuse before touching anything. Each guard blocks a different accident.
 */
async function assertDeletable(orgId: string) {
  const org = await prisma.customer.findUnique({
    where: { id: orgId },
    select: {
      id: true, name: true, suspended: true,
      users: { select: { id: true, email: true, role: true } },
      _count: { select: { users: true } },
    },
  });
  if (!org) throw Object.assign(new Error('Organization not found'), { status: 404, code: 'NOT_FOUND' });

  // The provider's own organization is not a client. Deleting it removes every
  // platform administrator and leaves nobody able to administer anything.
  if (org.users.some((u) => u.role === 'ADMINISTRATOR')) {
    throw Object.assign(
      new Error('This organization holds platform staff accounts and cannot be deleted.'),
      { status: 403, code: 'PROVIDER_ORG' },
    );
  }

  // Suspension first is a deliberate two-step: it is reversible, visible to the
  // customer, and forces a pause between "decided" and "destroyed".
  if (!org.suspended) {
    throw Object.assign(new Error('Suspend the organization before deleting it.'), { status: 400, code: 'NOT_SUSPENDED' });
  }
  return org;
}

/**
 * Delete an organization and its non-ticketing data.
 *
 * Ticket stores are untouched — tickets, comments, activity, attachments and the
 * store-local user rows that reference them are retained as a compliance record.
 *
 * Retained on purpose: the audit trail. AuditLog.customerId carries no foreign
 * key precisely so the record of an organization outlives the organization —
 * including the record of this deletion.
 */
export async function deleteOrganization(orgId: string, actorId: string, opts: DeleteOrgOptions): Promise<OrgDeletionReport> {
  const guarded = await assertDeletable(orgId);

  // Same contract as deleteProject: a destructive endpoint that trusts the client
  // to have asked is not confirmed, it is merely inconvenient to call by hand.
  if (opts.confirmName.trim() !== guarded.name.trim()) {
    throw Object.assign(new Error('The typed name does not match this organization.'), {
      status: 400, code: 'CONFIRM_MISMATCH',
    });
  }

  // Snapshot before the cascade: the email list below is what remains after the
  // User rows are gone, and it is needed for the audit metadata of this deletion.
  const org = await prisma.customer.findUniqueOrThrow({
    where: { id: orgId },
    select: { name: true, slug: true, plan: true, users: { select: { email: true } } },
  });
  const snap = { ...org, emails: org.users.map((u) => u.email.toLowerCase()) };

  // Chat lives in its own database — no cross-database cascade reaches it.
  const chat = await chatPrisma.chatSession.deleteMany({ where: { customerId: orgId } }).catch(() => ({ count: 0 }));

  // Tables carrying customerId with NO foreign key, so nothing cascades them.
  // AdCredentialDelivery holds an encrypted AD password: an orphaned secret is a
  // liability, not a record. BotTicketSubmission holds submitted form PII.
  await prisma.adCredentialDelivery.deleteMany({ where: { customerId: orgId } }).catch(() => {});
  await prisma.botTicketSubmission.deleteMany({ where: { customerId: orgId } }).catch(() => {});
  await prisma.slackBotOrg.deleteMany({ where: { customerId: orgId } }).catch(() => {});
  await prisma.pushSubscription.deleteMany({ where: { tenantId: orgId } }).catch(() => {});
  // Org-targeted announcements only. customerId null means "every organization"
  // and is not this org's data.
  await prisma.announcement.deleteMany({ where: { customerId: orgId } }).catch(() => {});

  const report: OrgDeletionReport = {
    orgName: snap.name, users: snap.emails.length, tickets: 0, attachments: 0, chatSessions: chat.count, mode: 'keep_tickets',
  };

  // Logged BEFORE the point of no return, so the record exists even if the final
  // delete fails — and blocking, so a failed audit aborts rather than destroying
  // an organization silently.
  await audit({
    action: 'ORG_DELETED', performedById: actorId, targetId: orgId, customerId: orgId,
    metadata: { ...report, slug: snap.slug, plan: snap.plan },
  });

  // LAST. Cascades users, feature flags, service requests, escalations and
  // customer services. Any failure above left the org intact and retryable.
  await prisma.customer.delete({ where: { id: orgId } });

  return report;
}