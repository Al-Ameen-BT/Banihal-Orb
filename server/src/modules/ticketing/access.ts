import type { Role } from '@prisma/client';
import { prisma } from '../../config/database';
import { getTicketDb } from '../../config/ticketDatabase';
import { resolveTicketActor } from './identity';

// ─── Ticket-store tenant scoping ─────────────────────────────────────────────
// The ticket store (b2b_ticket) is NOT covered by the main app's tenant Prisma
// extension, and tickets carry no reliable b2b org id — the trustworthy ownership
// signal is the bridged reporter/assignee. These helpers restrict every ticket
// read/collab surface to what the caller may see, closing the cross-org IDOR.

const ticketNotFound = () => Object.assign(new Error('Ticket not found'), { status: 404, code: 'NOT_FOUND' });

export interface Caller { userId: string; role: Role; customerId: string }

// The ticket-store user ids whose tickets the caller may access:
//   ADMINISTRATOR → null  (full access; the admin store is already isolated per
//                          request scope, so no per-row filter is needed)
//   ORG_ADMIN     → every bridged ticket user belonging to the caller's org
//   USER          → only themselves (own reported/assigned tickets)
export async function ticketAccessScope(user: Caller): Promise<string[] | null> {
  if (user.role === 'ADMINISTRATOR') return null;
  const me = await resolveTicketActor(user.userId, user.role);
  if (user.role !== 'ORG_ADMIN') return [me.id];

  // Whole organization: map every org member's email to its bridged ticket-store
  // user id. Members without a bridged row have no tickets, so omitting them is safe.
  const orgUsers = await prisma.user.findMany({ where: { customerId: user.customerId }, select: { email: true } });
  const emails = orgUsers.map((u) => u.email.toLowerCase());
  const bridged = emails.length
    ? await getTicketDb().users.findMany({ where: { email: { in: emails } }, select: { id: true } })
    : [];
  const ids = new Set(bridged.map((b) => b.id));
  ids.add(me.id);
  return [...ids];
}

function ownedBy(scope: string[], owners: { reporterId: string; assigneeId: string | null } | null): boolean {
  if (!owners) return false;
  return scope.includes(owners.reporterId) || (owners.assigneeId != null && scope.includes(owners.assigneeId));
}

// Throw 404 (not 403 — don't confirm the id exists) unless the caller may access
// this ticket in the current store. Null scope = ADMINISTRATOR = always allowed.
export async function assertTicketAccess(scope: string[] | null, ticketId: string): Promise<void> {
  if (scope === null) return;
  const owners = await getTicketDb().tickets.findUnique({
    where: { id: ticketId },
    select: { reporterId: true, assigneeId: true },
  });
  if (!ownedBy(scope, owners)) throw ticketNotFound();
}

// Same guard, resolving an attachment id (ticket- or comment-attachment) to its
// ticket first, so attachment downloads can't cross organizations.
export async function assertAttachmentAccess(scope: string[] | null, attachmentId: string): Promise<void> {
  if (scope === null) return;
  const ta = await getTicketDb().ticketAttachments.findUnique({ where: { id: attachmentId }, select: { ticketId: true } });
  let ticketId = ta?.ticketId ?? null;
  if (!ticketId) {
    const ca = await getTicketDb().commentAttachments.findUnique({
      where: { id: attachmentId },
      select: { Comments: { select: { ticketId: true } } },
    });
    ticketId = ca?.Comments?.ticketId ?? null;
  }
  if (!ticketId) throw Object.assign(new Error('Attachment not found'), { status: 404, code: 'NOT_FOUND' });
  await assertTicketAccess(scope, ticketId);
}
