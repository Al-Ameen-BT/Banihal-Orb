import { prisma } from '../../../config/database';
import { adminTicketingPrisma } from '../../../config/adminTicketingDatabase';
import * as db from '../ticketing.client';

// ─── Escalation ──────────────────────────────────────────────────────────────
// An ORG_ADMIN escalates a ticket: a SNAPSHOT of the full b2b_ticket ticket is
// copied into the administrators' database (b2b_ticketing_admin, the simpler
// Ticket schema) where platform ADMINISTRATORs manage it from the Escalations
// tab. The snapshot row shares the source ticket id so escalation is idempotent
// and the source can be flagged "escalated". Only escalated tickets flow in.

const notFound = (w: string) => Object.assign(new Error(`${w} not found`), { status: 404, code: 'NOT_FOUND' });

// full status/priority → simple-schema enums
const STATUS_MAP: Record<string, 'TODO' | 'IN_PROGRESS' | 'COMPLETED'> = {
  todo: 'TODO', in_progress: 'IN_PROGRESS', client_pending: 'IN_PROGRESS', completed: 'COMPLETED',
};
const PRIORITY_MAP: Record<string, 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'> = {
  low: 'LOW', medium: 'MEDIUM', high: 'HIGH', urgent: 'CRITICAL',
};

export async function escalateTicket(actorId: string, customerId: string, sourceTicketId: string) {
  const t = await db.getTicketById(sourceTicketId);
  if (!t) throw notFound('Ticket');

  const existing = await adminTicketingPrisma.ticket.findUnique({ where: { id: sourceTicketId }, select: { id: true } });
  if (existing) throw Object.assign(new Error('This ticket has already been escalated.'), { status: 409, code: 'ALREADY_ESCALATED' });

  // Snapshot into b2b_ticketing_admin (sharing the source id for a 1:1 link).
  await adminTicketingPrisma.ticket.create({
    data: {
      id: sourceTicketId,
      customerId,
      subject: t.title,
      description: t.description,
      issueType: t.type,
      status: STATUS_MAP[t.status] ?? 'TODO',
      priority: PRIORITY_MAP[t.priority] ?? 'MEDIUM',
      assignee: t.assignee?.name ?? null,
      raisedByName: t.reporter?.name ?? null,
      raisedByEmail: t.reporter?.email ?? null,
      clientName: t.customer?.name ?? null,
      branch: t.branch,
      onSiteSupport: t.onSiteSupportRequired,
    },
  });

  // Flag the source ticket (label) + log it, so the org-admin side shows "escalated".
  if (!t.labels.includes('escalated')) {
    await db.updateTicketRow(sourceTicketId, { labels: [...t.labels, 'escalated'] });
  }
  await db.writeActivity({ type: 'updated', ticketId: sourceTicketId, userId: actorId, field: 'escalated', newValue: true, description: 'Escalated to platform administrators' });

  return { escalated: true, ticketNumber: t.ticketNumber };
}

export interface EscalationDTO {
  id: string;
  subject: string;
  description: string;
  issueType: string;
  status: string;
  priority: string;
  assignee: string | null;
  raisedByName: string | null;
  raisedByEmail: string | null;
  branch: string | null;
  onSiteSupport: boolean;
  org: string;
  createdAt: string;
}

export async function listEscalations(): Promise<EscalationDTO[]> {
  const rows = await adminTicketingPrisma.ticket.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
  const ids = [...new Set(rows.map((r) => r.customerId))];
  const customers = await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const nameById = new Map(customers.map((c) => [c.id, c.name] as const));
  return rows.map((r) => ({
    id: r.id, subject: r.subject, description: r.description, issueType: r.issueType,
    status: r.status, priority: r.priority, assignee: r.assignee,
    raisedByName: r.raisedByName, raisedByEmail: r.raisedByEmail,
    branch: r.branch, onSiteSupport: r.onSiteSupport,
    org: nameById.get(r.customerId) ?? 'Unknown org',
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function updateEscalation(id: string, input: { status?: 'TODO' | 'IN_PROGRESS' | 'COMPLETED'; assignee?: string | null }) {
  const existing = await adminTicketingPrisma.ticket.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw notFound('Escalation');
  await adminTicketingPrisma.ticket.update({
    where: { id },
    data: {
      ...(input.status !== undefined ? { status: input.status, completedAt: input.status === 'COMPLETED' ? new Date() : null } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
    },
  });
  return { id, ...input };
}
