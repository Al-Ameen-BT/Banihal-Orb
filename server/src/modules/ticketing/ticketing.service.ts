import { prisma } from '../../config/database';
import * as client from './ticketing.client';
import type { Ticket, TicketFilters, CreateTicketInput, UpdateTicketInput, CreateProjectInput } from './ticketing.types';

// Stats / analytics / reports are computed here from the ticket list rather than
// delegated to provider-specific endpoints — that keeps them identical across
// fallback and external modes (and across whatever the external API exposes).

// Ticket list annotated with the escalation flag (escalations live in our DB).
export async function listTickets(customerId: string, filters: TicketFilters = {}): Promise<Ticket[]> {
  const tickets = await client.listTickets(customerId, filters);
  if (tickets.length === 0) return tickets;
  const rows = await prisma.ticketEscalation.findMany({
    where: { customerId, ticketId: { in: tickets.map((t) => t.id) } },
    select: { ticketId: true },
  });
  const escalated = new Set(rows.map((r) => r.ticketId));
  return tickets.map((t) => ({ ...t, escalated: escalated.has(t.id) }));
}

// ORG_ADMIN forwards a ticket to the platform Administrators. We snapshot the
// ticket fields so the escalation stays readable even in external-API mode and
// across fallback-store restarts.
export async function escalateTicket(customerId: string, userId: string, ticketId: string, note?: string) {
  const tickets = await client.listTickets(customerId);
  const ticket = tickets.find((t) => t.id === ticketId);
  if (!ticket) throw Object.assign(new Error('Ticket not found'), { status: 404, code: 'NOT_FOUND' });

  try {
    const escalation = await prisma.ticketEscalation.create({
      data: {
        customerId,
        ticketId,
        subject: ticket.subject,
        issueType: ticket.issueType,
        priority: ticket.priority,
        note: note?.trim() || null,
        escalatedById: userId,
      },
    });

    await prisma.auditLog.create({
      data: {
        action: 'TICKET_ESCALATED', performedById: userId, targetId: ticketId, customerId,
        metadata: { subject: ticket.subject, priority: ticket.priority, issueType: ticket.issueType },
      },
    }).catch(() => {});

    return escalation;
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw Object.assign(new Error('This ticket has already been escalated.'), { status: 409, code: 'ALREADY_ESCALATED' });
    }
    throw err;
  }
}

export const createTicket = client.createTicket;
export const updateTicket = client.updateTicket;
export const listProjects = client.listProjects;
export const createProject = client.createProject;
export const deleteProject = client.deleteProject;
export const usingFallback = client.usingFallback;

export async function getStats(customerId: string) {
  const [tickets, projects] = await Promise.all([
    client.listTickets(customerId),
    client.listProjects(customerId),
  ]);

  const total = tickets.length;
  const completed = tickets.filter((t) => t.status === 'COMPLETED').length;
  const inProgress = tickets.filter((t) => t.status === 'IN_PROGRESS').length;
  const todo = tickets.filter((t) => t.status === 'TODO').length;
  const highPriority = tickets.filter((t) => (t.priority === 'HIGH' || t.priority === 'CRITICAL') && t.status !== 'COMPLETED').length;

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const today = tickets.filter((t) => new Date(t.createdAt) >= startOfDay).length;

  const projectCounts = new Map<string, number>();
  for (const t of tickets) if (t.projectId) projectCounts.set(t.projectId, (projectCounts.get(t.projectId) ?? 0) + 1);

  return {
    tickets: {
      total, completed, inProgress, todo, highPriority, today,
      open: inProgress + todo,
      completionRate: total ? Math.round((completed / total) * 100) : 0,
    },
    projects: {
      total: projects.length,
      withOpenTickets: projects.filter((p) =>
        tickets.some((t) => t.projectId === p.id && t.status !== 'COMPLETED')).length,
    },
    fallback: client.usingFallback(),
  };
}

export async function getAnalytics(customerId: string) {
  const tickets = await client.listTickets(customerId);

  // Issue distribution (donut) — top 7 + Other, like the reference tool.
  const byIssue = new Map<string, number>();
  for (const t of tickets) byIssue.set(t.issueType, (byIssue.get(t.issueType) ?? 0) + 1);
  const sorted = [...byIssue.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 7).map(([issue, count]) => ({ issue, count }));
  const otherCount = sorted.slice(7).reduce((s, [, c]) => s + c, 0);
  if (otherCount > 0) top.push({ issue: 'Other', count: otherCount });

  // Daily created volume, last 14 days.
  const daily: Array<{ date: string; created: number }> = [];
  for (let i = 13; i >= 0; i--) {
    daily.push({ date: new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10), created: 0 });
  }
  const idx = new Map(daily.map((d, i) => [d.date, i] as const));
  for (const t of tickets) {
    const i = idx.get(t.createdAt.slice(0, 10));
    if (i !== undefined) daily[i]!.created++;
  }

  const byPriority = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((p) => ({
    priority: p,
    count: tickets.filter((t) => t.priority === p).length,
  }));

  return { issueDistribution: top, daily, byPriority, analyzed: tickets.length };
}

export interface ReportRow {
  group: string;
  total: number;
  completed: number;
  inProgress: number;
  todo: number;
  highPriority: number;
}

export async function getReport(customerId: string, type: 'status' | 'user' | 'project' | 'issue', from?: string, to?: string) {
  const [tickets, projects] = await Promise.all([
    client.listTickets(customerId),
    client.listProjects(customerId),
  ]);
  const projectName = new Map(projects.map((p) => [p.id, p.name] as const));

  const inRange = tickets.filter((t) =>
    (!from || t.createdAt >= from) && (!to || t.createdAt <= to));

  const keyOf = (t: Ticket): string =>
    type === 'status' ? t.status :
    type === 'user' ? (t.raisedBy?.name ?? 'Unknown') :
    type === 'project' ? (t.projectId ? projectName.get(t.projectId) ?? 'Unknown project' : 'No project') :
    t.issueType;

  const groups = new Map<string, Ticket[]>();
  for (const t of inRange) {
    const k = keyOf(t);
    const g = groups.get(k) ?? [];
    g.push(t);
    groups.set(k, g);
  }

  const rows: ReportRow[] = [...groups.entries()]
    .map(([group, list]) => ({
      group,
      total: list.length,
      completed: list.filter((t) => t.status === 'COMPLETED').length,
      inProgress: list.filter((t) => t.status === 'IN_PROGRESS').length,
      todo: list.filter((t) => t.status === 'TODO').length,
      highPriority: list.filter((t) => t.priority === 'HIGH' || t.priority === 'CRITICAL').length,
    }))
    .sort((a, b) => b.total - a.total);

  return { rows, totalTickets: inRange.length, from: from ?? null, to: to ?? null, type };
}

// Alert polling for org admins: tickets raised since `since`, excluding the
// admin's own submissions.
export async function getNewTickets(customerId: string, since: string, excludeEmail: string) {
  const tickets = await client.listTickets(customerId, { since } as TicketFilters);
  return tickets.filter((t) => t.raisedBy?.email !== excludeEmail).slice(0, 10);
}

export type { CreateTicketInput, UpdateTicketInput, CreateProjectInput };
