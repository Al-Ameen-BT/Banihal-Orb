import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../../config/database';
import { chatPrisma } from '../../config/chatDatabase';
import { runWithTicketDb, getTicketDb, type TicketDbScope } from '../../config/ticketDatabase';
import { UPLOAD_DIR } from '../ticketing/uploads';
import { audit } from '../../lib/audit';

// ─── Organization deletion ───────────────────────────────────────────────────
// Irreversible, and it spans FOUR live databases (main, chat, and BOTH ticket
// stores) that have no foreign keys between them. `prisma.customer.delete()` on
// its own would succeed silently: the six declared relations cascade, so it would
// take every user with it while leaving chat sessions, tickets, upload files on
// disk and an encrypted AD credential behind as unreachable orphans.
//
// TWO ordering constraints drive the sequence below, and getting either wrong is
// unrecoverable:
//
//  1. SNAPSHOT MEMBER EMAILS FIRST. The ticket stores link back to a B2B org only
//     through bridged user emails and the organization NAME. Once the User rows
//     cascade away, those tickets can never be attributed to anyone.
//  2. UNLINK FILES BEFORE DELETING TICKETS. Attachments are random filenames in a
//     flat directory; the only pointer is the attachment row, which the ticket
//     delete cascades away. Delete tickets first and the bytes are unreachable
//     forever.
//
// `customer.delete()` runs LAST, so a failure at any earlier phase leaves the
// organization present and the whole operation safely re-runnable.

export interface OrgDeletionReport {
  orgName: string;
  users: number;
  tickets: number;       // ticket-store rows destroyed; 0 in keep-tickets mode
  attachments: number;   // attachment files destroyed; 0 in keep-tickets mode
  chatSessions: number;
  /** 'wipe' purged both ticket stores; 'keep_tickets' retained them. */
  mode: 'wipe' | 'keep_tickets';
}

export interface DeleteOrgOptions {
  /** The org's exact name, typed by the caller. Re-checked HERE — see CONFIRM_MISMATCH. */
  confirmName: string;
  /**
   * true → keep both ticket stores (shared + internal admin) and their upload
   * files; everything else (users, chat, escalations, amenities) still goes.
   * false / omitted → purge both ticket stores (the full wipe).
   */
  keepTickets?: boolean;
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
 * Tear down one ticket store. Both are swept: escalated copies live in the admin
 * store, so cleaning only the shared one leaves the org's data behind.
 */
async function purgeTicketStore(scope: TicketDbScope, orgName: string, emails: string[]): Promise<{ tickets: number; attachments: number }> {
  return runWithTicketDb(scope, async () => {
    const db = getTicketDb();

    // The bridge is by email — see modules/ticketing/identity.ts.
    const users = emails.length
      ? await db.users.findMany({ where: { email: { in: emails } }, select: { id: true } })
      : [];
    const userIds = users.map((u) => u.id);
    const customer = await db.customers.findFirst({ where: { name: orgName }, select: { id: true } });

    const ticketWhere = {
      OR: [
        ...(userIds.length ? [{ reporterId: { in: userIds } }, { createdBy: { in: userIds } }] : []),
        ...(customer ? [{ customerId: customer.id }] : []),
      ],
    };
    if (!ticketWhere.OR.length) return { tickets: 0, attachments: 0 };

    const tickets = await db.tickets.findMany({ where: ticketWhere, select: { id: true } });
    const ticketIds = tickets.map((t) => t.id);
    // No early return on an empty sweep: an org can hold bridged Users in a store
    // without owning a single ticket there, and returning here left those user
    // rows behind — a "full wipe" that quietly kept the departing members. Each
    // block below guards its own precondition instead.

    // ── Files BEFORE rows. Once the attachment row is gone the filename is lost.
    let attachments = 0;
    if (ticketIds.length) {
      const files = [
        ...(await db.ticketAttachments.findMany({ where: { ticketId: { in: ticketIds } }, select: { filename: true } })),
        ...(await db.commentAttachments.findMany({ where: { Comments: { ticketId: { in: ticketIds } } }, select: { filename: true } })),
      ];
      const names = files.map((f) => f.filename).filter((n): n is string => !!n);
      attachments = names.length;
      await Promise.all(names.map((name) =>
        // Best-effort per file: a missing file must not abort the teardown, and
        // basename() keeps a crafted stored name from escaping UPLOAD_DIR.
        fs.unlink(path.join(UPLOAD_DIR, path.basename(name))).catch(() => {})));

      await db.tickets.deleteMany({ where: { id: { in: ticketIds } } });
    }

    // Projects are SHARED across organizations and have no owner column, so they
    // are never deleted — only a lead pointing at a departing user is re-pointed.
    if (userIds.length) {
      const orphanedProjects = await db.projects.findMany({ where: { leadId: { in: userIds } }, select: { id: true } });
      if (orphanedProjects.length) {
        const survivor = await db.users.findFirst({ where: { id: { notIn: userIds }, role: 'admin' }, select: { id: true } });
        if (!survivor) throw Object.assign(new Error('Cannot reassign shared projects: no other admin exists in the ticket store.'), { status: 400, code: 'NO_PROJECT_LEAD' });
        await db.projects.updateMany({ where: { id: { in: orphanedProjects.map((p) => p.id) } }, data: { leadId: survivor.id } });
      }

      // ── Detach from tickets that SURVIVE the sweep above.
      //
      // The sweep only claims tickets this org reported, created, or owns through
      // its Customers row. Every OTHER pointer at these users is ON DELETE NO
      // ACTION (verified in both stores), so one leftover row — a ticket in
      // another organization assigned to a departing user, their comment on it,
      // the activity line their escalation wrote — makes users.deleteMany fail
      // with P2003 and dead-ends the whole deletion, permanently: the retry hits
      // the same row. This is what "foreign key constraint" in the delete dialog
      // was; the tickets and their files were already destroyed by then.
      //
      // Nullable pointers are cleared. Comments.userId and Activities.userId are
      // NOT NULL — there is no unattributed state to leave them in — so those
      // rows leave with their author, which is also what a full wipe means.
      const strandedFiles = await db.commentAttachments.findMany({
        where: { Comments: { userId: { in: userIds } } }, select: { filename: true },
      });
      const strandedNames = strandedFiles.map((f) => f.filename).filter((n): n is string => !!n);
      // Same rule as above: unlink BEFORE the row that names the file is gone.
      await Promise.all(strandedNames.map((name) =>
        fs.unlink(path.join(UPLOAD_DIR, path.basename(name))).catch(() => {})));
      attachments += strandedNames.length;

      await db.tickets.updateMany({ where: { assigneeId: { in: userIds } }, data: { assigneeId: null } });
      await db.ticketAttachments.updateMany({ where: { uploadedBy: { in: userIds } }, data: { uploadedBy: null } });
      await db.commentAttachments.updateMany({ where: { uploadedBy: { in: userIds } }, data: { uploadedBy: null } });
      await db.comments.deleteMany({ where: { userId: { in: userIds } } });
      await db.activities.deleteMany({ where: { userId: { in: userIds } } });

      await db.users.deleteMany({ where: { id: { in: userIds } } });
    }
    if (customer) await db.customers.deleteMany({ where: { id: customer.id } });

    return { tickets: ticketIds.length, attachments };
  });
}

/**
 * Delete an organization and everything it owns.
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

  const keepTickets = opts.keepTickets === true;
  const mode: OrgDeletionReport['mode'] = keepTickets ? 'keep_tickets' : 'wipe';

  // Captured while it still exists — see constraint 1 above.
  const org = await prisma.customer.findUniqueOrThrow({
    where: { id: orgId },
    select: { name: true, slug: true, plan: true, users: { select: { email: true } } },
  });
  const snap = { ...org, emails: org.users.map((u) => u.email.toLowerCase()) };

  // Both stores. Escalated tickets live in the admin one. In keep-tickets mode the
  // stores are left whole on purpose — the org is leaving the platform, but its
  // ticket history (and the attachment bytes it points at) stays as a record.
  let tickets = 0;
  let attachments = 0;
  if (!keepTickets) {
    for (const scope of ['default', 'admin'] as const) {
      try {
        const r = await purgeTicketStore(scope, snap.name, snap.emails);
        tickets += r.tickets;
        attachments += r.attachments;
      } catch (err) {
        // The stores are separate databases, so no transaction spans them: by the
        // time the second one fails the first is already emptied and its
        // attachment bytes unlinked from disk. The ORG_DELETED entry below never
        // runs in that case, which left real destruction with NO record at all.
        // Best-effort, and never masks the original failure.
        await audit({
          action: 'ORG_DELETE_FAILED', performedById: actorId, targetId: orgId, customerId: orgId,
          metadata: {
            orgName: snap.name, failedStore: scope,
            ticketsDestroyedBefore: tickets, attachmentsDestroyedBefore: attachments,
            reason: err instanceof Error ? err.message : String(err),
            code: (err as { code?: string })?.code ?? null,
          },
        }).catch(() => {});
        throw err;
      }
    }
  }

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
    orgName: snap.name, users: snap.emails.length, tickets, attachments, chatSessions: chat.count, mode,
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
