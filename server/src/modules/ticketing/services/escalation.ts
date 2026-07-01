import type { Role } from '@prisma/client';
import * as db from '../ticketing.client';
import { runWithTicketDb } from '../../../config/ticketDatabase';
import { resolveTicketActor } from '../identity';
import { nextTicketNumber } from '../utils/ticketNumber';
import { getTicketNumberFormat } from './numberFormat';

// ─── Escalation: client (b2b_ticket) → administrators (b2b_ticketing_admin) ───
// Both stores share the SAME 14-table schema. An ORG_ADMIN/ADMINISTRATOR escalates
// a ticket: we COPY it into the admin store as a fresh ticket (new number, in the
// admin store's "Escalations" project, reported by the bridged actor) and flag the
// source with an `escalated` label + activity so the org-admin side reflects it.
// Cross-store reads/writes are wrapped in the matching runWithTicketDb scope.

const notFound = (w: string) => Object.assign(new Error(`${w} not found`), { status: 404, code: 'NOT_FOUND' });

export async function escalateTicket(b2bUserId: string, platformRole: Role, sourceTicketId: string): Promise<{ escalated: true; ticketNumber: string }> {
  // Source lives in the shared (default) store.
  const source = await runWithTicketDb('default', () => db.getTicketById(sourceTicketId));
  if (!source) throw notFound('Ticket');
  if (source.labels.includes('escalated')) {
    throw Object.assign(new Error('This ticket has already been escalated.'), { status: 409, code: 'ALREADY_ESCALATED' });
  }

  // Copy into the ADMIN store (14-table). Reporter + project are resolved in that
  // store; ticket number is allocated from the admin store's sequence.
  await runWithTicketDb('admin', async () => {
    const actor = await resolveTicketActor(b2bUserId, platformRole);
    const projectId = await db.getOrCreateEscalationProject(actor.id);
    const fmt = await getTicketNumberFormat();

    let created = false;
    for (let attempt = 0; attempt < 10 && !created; attempt++) {
      const ticketNumber = await nextTicketNumber(fmt, null);
      try {
        await db.createTicketRow({
          ticketNumber,
          title: source.title,
          description: `Escalated from ${source.ticketNumber} (${source.customer?.name ?? source.projectName ?? 'client'}).\n\n${source.description}`,
          type: source.type,
          priority: source.priority,
          status: 'todo',
          projectId,
          reporterId: actor.id,
          createdBy: actor.id,
          labels: ['escalated', `src:${source.ticketNumber}`],
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
  });

  // Flag + log the source in the shared store.
  await runWithTicketDb('default', async () => {
    const actor = await resolveTicketActor(b2bUserId, platformRole);
    await db.updateTicketRow(sourceTicketId, { labels: [...source.labels, 'escalated'] });
    await db.writeActivity({ type: 'updated', ticketId: sourceTicketId, userId: actor.id, field: 'escalated', newValue: true, description: 'Escalated to platform administrators' });
  });

  return { escalated: true, ticketNumber: source.ticketNumber };
}
