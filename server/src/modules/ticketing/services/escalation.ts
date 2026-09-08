import type { Role } from '@prisma/client';
import * as db from '../ticketing.client';
import { runWithTicketDb, getTicketDb } from '../../../config/ticketDatabase';
import { resolveTicketActor, resolveB2bIdentity } from '../identity';
import { nextTicketNumber } from '../utils/ticketNumber';
import { getTicketNumberFormat } from './numberFormat';
import { prisma } from '../../../config/database';
import { notify } from '../../notifications/notifications.service';

// ─── Escalation: client (b2b_ticket) → administrators (b2b_ticketing_admin) ────
// Both stores share the SAME 14-table schema. An ORG_ADMIN escalates an UNCLOSED ticket
// to the platform ADMINISTRATORS as a group. We COPY it into the admin store as a fresh
// ticket — new number, "Escalations" project, reported by the bridged actor, ASSIGNED to
// the first active platform ADMINISTRATOR ("Banihal Support") — and flag the source with
// an `escalated` label + activity. Cross-store reads/writes are wrapped in the matching
// runWithTicketDb scope. Additive only: nothing is deleted/altered.

const notFound = (w: string) => Object.assign(new Error(`${w} not found`), { status: 404, code: 'NOT_FOUND' });

export async function escalateTicket(
  b2bUserId: string,
  platformRole: Role,
  sourceTicketId: string,
): Promise<{ escalated: true; ticketNumber: string }> {
  // Source lives in the shared (default) store.
  const source = await runWithTicketDb('default', () => db.getTicketById(sourceTicketId));
  if (!source) throw notFound('Ticket');
  if (source.status === 'completed') {
    throw Object.assign(new Error('Closed tickets cannot be escalated.'), { status: 409, code: 'TICKET_CLOSED' });
  }
  if (source.labels.includes('escalated')) {
    throw Object.assign(new Error('This ticket has already been escalated.'), { status: 409, code: 'ALREADY_ESCALATED' });
  }

  // Preserve the ORIGINAL requester + their organization on the escalated copy.
  // Org-created tickets don't link a ticket-store Customers row (source.customer is
  // usually null), so without this we'd fall back to the PROJECT name as the client
  // and drop the requester's identity entirely. The escalating org-admin belongs to
  // the same B2B org as the ticket, so we resolve the real org from their account.
  const requester = source.reporter; // original requester: { id, name, email }
  const b2bOrg = await prisma.user.findUnique({
    where: { id: b2bUserId },
    select: { customer: { select: { name: true, mailId: true, contactPerson: true, orgCode: true } } },
  }).catch(() => null);
  const orgName = source.customer?.name ?? b2bOrg?.customer?.name ?? source.projectName ?? 'Unknown organization';
  const orgEmail = source.customer?.email ?? b2bOrg?.customer?.mailId ?? requester?.email ?? null;
  // The Customers row represents the ORGANIZATION, so its contact is the org's contact —
  // NOT whoever happened to escalate. (Using the requester here made the shared org row show
  // the first escalation's requester forever.) The per-ticket requester is carried in the
  // description below, which is accurate for every escalation.
  const orgContact = source.customer?.contactPerson ?? b2bOrg?.customer?.contactPerson ?? null;
  const orgCode = b2bOrg?.customer?.orgCode ?? null;
  const requestedByLine = `Requested by ${requester?.name ?? 'Unknown user'}${requester?.email ? ` <${requester.email}>` : ''}.`;

  // Copy into the ADMIN store (14-table). Reporter + project + customer are resolved in
  // that store; the ticket number is allocated from the admin store's sequence; the copy
  // is assigned to the first active platform ADMINISTRATOR ("Banihal Support").
  // The escalated copy must be REPORTED BY the original requester, not by whoever
  // escalated it — administrators triage by requester. The requester exists only in
  // the source store, so bridge across: ticket user → B2B account → ticket user in
  // the admin store (resolveTicketActor upserts by email, scoped to the active DB).
  const requesterB2b = requester
    ? await runWithTicketDb('default', () => resolveB2bIdentity(requester.id)).catch(() => null)
    : null;
  const requesterRole = requesterB2b
    ? (await prisma.user.findUnique({ where: { id: requesterB2b.userId }, select: { role: true } }).catch(() => null))?.role ?? 'USER'
    : null;

  await runWithTicketDb('admin', async () => {
    const actor = await resolveTicketActor(b2bUserId, platformRole);
    // Falls back to the escalator when the requester has no B2B account behind them
    // (staff created natively in the ticketing system).
    const reporterId = requesterB2b && requesterRole
      ? (await resolveTicketActor(requesterB2b.userId, requesterRole)).id
      : actor.id;
    const projectId = await db.getOrCreateEscalationProject(actor.id);
    const customerId = await db.getOrCreateCustomerByName({
      name: orgName,
      email: orgEmail,
      contactPerson: orgContact,
    });
    const fmt = await getTicketNumberFormat();

    // "Banihal Support" = the platform's support team. A Tickets row needs a single
    // concrete assignee, so the escalated copy goes to the FIRST ACTIVE platform
    // ADMINISTRATOR (same name-order the admin assignee dropdown uses). If the whole
    // admin roster has been deactivated, the copy stays unassigned and the
    // escalation-alerts queue keeps surfacing it to every administrator.
    let assigneeTicketUserId: string | null = null;
    let assigneeB2bId: string | null = null;
    let assigneeTenant: string | null = null;
    const adminAccounts = await prisma.user.findMany({
      where: { role: 'ADMINISTRATOR' },
      select: { id: true, customerId: true },
      orderBy: { name: 'asc' },
    });
    for (const a of adminAccounts) {
      const bridged = await resolveTicketActor(a.id, 'ADMINISTRATOR'); // upserts into this (admin) store
      const active = await getTicketDb().users.findUnique({ where: { id: bridged.id }, select: { isActive: true } });
      if (active?.isActive !== false) { assigneeTicketUserId = bridged.id; assigneeB2bId = a.id; assigneeTenant = a.customerId; break; }
    }

    let created = false;
    let createdTicketId = '';
    let ticketNumber = '';
    for (let attempt = 0; attempt < 10 && !created; attempt++) {
      ticketNumber = await nextTicketNumber(fmt, orgCode);
      try {
        createdTicketId = await db.createTicketRow({
          ticketNumber,
          title: source.title,
          description: `Escalated from ${source.ticketNumber} (${orgName}).\n${requestedByLine}\n\n${source.description}`,
          type: source.type,
          priority: source.priority,
          status: 'todo',
          projectId,
          reporterId,
          createdBy: actor.id,
          assigneeId: assigneeTicketUserId,
          customerId,
          labels: ['escalated', `src:${source.ticketNumber}`, `org:${orgName}`],
          branch: source.branch,
          onSiteSupportRequired: source.onSiteSupportRequired,
        });
        created = true;
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') continue; // number collision → retry
        throw err;
      }
    }
    if (!created) throw Object.assign(new Error('Could not allocate an escalation ticket number'), { status: 500, code: 'TICKET_NUMBER_RACE' });

    // The assigned administrator is told directly (in-app + push); the rest of the
    // team still sees it through the escalation-alerts feed.
    if (assigneeB2bId && assigneeTenant) {
      await notify({
        userId: assigneeB2bId,
        customerId: assigneeTenant, // the RECIPIENT's org — see notifications.service
        kind: 'ticket_assigned',
        title: `${ticketNumber} assigned to you`,
        body: `${source.title}${orgName ? ` · ${orgName}` : ''}`,
        url: `/ticketing?ticket=${createdTicketId}`,
        actorId: b2bUserId,
        entityId: createdTicketId,
      });
    }
  });

  // Flag + log the source in the shared store.
  await runWithTicketDb('default', async () => {
    const actor = await resolveTicketActor(b2bUserId, platformRole);
    await db.updateTicketRow(sourceTicketId, { labels: [...source.labels, 'escalated'] });
    await db.writeActivity({ type: 'updated', ticketId: sourceTicketId, userId: actor.id, field: 'escalated', newValue: true, description: 'Escalated to platform administrators' });
  });

  return { escalated: true, ticketNumber: source.ticketNumber };
}
