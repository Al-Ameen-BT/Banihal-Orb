import { runWithTicketDb, getTicketDb, getTicketDbScope, type TicketDbScope } from '../../../config/ticketDatabase';
import { prisma } from '../../../config/database';
import * as db from '../ticketing.client';
import { resolveTicketActor, resolveB2bIdentity } from '../identity';

// ─── Escalation mirror: keep an escalated ticket and its admin copy in step ────
// escalateTicket COPIES a ticket from the shared store (b2b_ticket) into the
// administrators' store (b2b_ticketing_admin) — two separate databases that cannot
// join. Without this module the copy is a one-way snapshot: the requester's later
// comments never reach the administrator, and the administrator's resolution /
// reason-for-delay never reaches the requester.
//
// The link needs no schema change and no new label: escalation already writes
// `src:<sourceTicketNumber>` onto the copy, and `escalated` onto the source. So a
// copy finds its source by that number, and a source finds its copy by searching
// for the label naming it. Tickets escalated BEFORE this module shipped resolve too.
//
// Every mirror write goes straight to ticketing.client, never back through the
// service layer, so a mirrored comment can never re-trigger a mirror.

const SRC_PREFIX = 'src:';

interface Link { scope: TicketDbScope; ticketId: string; reporterId: string }

// Resolve the counterpart of `ticketId` (read in the CURRENT scope), or null when
// the ticket is not part of an escalation pair.
async function findLink(ticketId: string): Promise<Link | null> {
  const me = await getTicketDb().tickets.findUnique({
    where: { id: ticketId },
    select: { ticketNumber: true, labels: true },
  });
  if (!me) return null;

  const srcLabel = me.labels.find((l) => l.startsWith(SRC_PREFIX));
  if (srcLabel) {
    // This IS the admin copy → its source lives in the shared store.
    const sourceNumber = srcLabel.slice(SRC_PREFIX.length);
    const row = await runWithTicketDb('default', () =>
      getTicketDb().tickets.findUnique({ where: { ticketNumber: sourceNumber }, select: { id: true, reporterId: true } }));
    return row ? { scope: 'default', ticketId: row.id, reporterId: row.reporterId } : null;
  }

  if (me.labels.includes('escalated')) {
    // This is the source → its copy carries `src:<my number>` in the admin store.
    const row = await runWithTicketDb('admin', () =>
      getTicketDb().tickets.findFirst({
        where: { labels: { has: `${SRC_PREFIX}${me.ticketNumber}` } },
        select: { id: true, reporterId: true },
        orderBy: { createdAt: 'desc' },
      }));
    return row ? { scope: 'admin', ticketId: row.id, reporterId: row.reporterId } : null;
  }

  return null;
}

// Same email, different Users.id per store — re-bridge the author into the target
// store so a mirrored comment keeps its real author.
//   1. Through their B2B account (the normal path, and the one that keeps roles in sync).
//   2. Failing that, by copying the ticket-store row across by email — staff created
//      natively in the ticketing tool have no B2B account but are still real people.
//   3. Only if they have no email at all does the counterpart's reporter stand in;
//      attributing someone else's words to the requester is the worst option, not the
//      first one.
async function bridgeAuthor(authorId: string, from: TicketDbScope, to: TicketDbScope, fallbackId: string): Promise<string> {
  const b2b = await runWithTicketDb(from, () => resolveB2bIdentity(authorId)).catch(() => null);
  if (b2b) {
    const role = (await prisma.user.findUnique({ where: { id: b2b.userId }, select: { role: true } }).catch(() => null))?.role;
    if (role) return runWithTicketDb(to, async () => (await resolveTicketActor(b2b.userId, role)).id);
  }

  const author = await runWithTicketDb(from, () =>
    getTicketDb().users.findUnique({ where: { id: authorId }, select: { email: true, firstName: true, lastName: true, role: true } }));
  if (!author?.email) return fallbackId;
  return runWithTicketDb(to, () => db.getOrCreateUserByEmail(author));
}

type UploadedFile = { filename: string; originalname: string; mimetype: string; size: number; path: string };

// Copy a comment (and its attachments) onto the counterpart ticket. Attachments
// re-register the SAME on-disk path — one server, one uploads dir, no file copying.
export async function mirrorComment(ticketId: string, authorId: string, content: string, files: UploadedFile[] = []): Promise<void> {
  const from = getTicketDbScope();
  const link = await findLink(ticketId);
  if (!link) return;

  const author = await bridgeAuthor(authorId, from, link.scope, link.reporterId);
  await runWithTicketDb(link.scope, async () => {
    const commentId = await db.createComment(link.ticketId, author, content);
    for (const f of files) await db.addCommentAttachment(commentId, f, author);
    await db.writeActivity({ type: 'commented', ticketId: link.ticketId, userId: author, description: content.slice(0, 140) });
  });
}

// Propagate the resolution notes both ways. Deliberately notes only — status and
// priority stay independent so an administrator's triage state does not overwrite
// the requester's view of their own ticket.
export async function mirrorFields(ticketId: string, fields: { resolvedMethods?: string | null; reasonForDelay?: string | null }): Promise<void> {
  const data = {
    ...(fields.resolvedMethods !== undefined ? { resolvedMethods: fields.resolvedMethods } : {}),
    ...(fields.reasonForDelay !== undefined ? { reasonForDelay: fields.reasonForDelay } : {}),
  };
  if (Object.keys(data).length === 0) return;

  const link = await findLink(ticketId);
  if (!link) return;
  await runWithTicketDb(link.scope, () => db.updateTicketRow(link.ticketId, data));
}

// Mirroring must never fail the user's own action — it is a best-effort side effect.
export function mirrorInBackground(run: () => Promise<void>): void {
  void run().catch((err) => console.error('[escalationMirror] mirror failed:', err));
}
