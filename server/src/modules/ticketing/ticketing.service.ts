import * as db from './ticketing.client';
import { nextTicketNumber } from './utils/ticketNumber';
import { getTicketNumberFormat, resolveOrgCode } from './services/numberFormat';
import { getNextAssignee, withLastAssigned } from './utils/roundRobin';
import { pausePatch } from './services/slaService';
import { notifyTicketAssignedInBackground } from './services/ticketNotify';
import { mirrorComment, mirrorFields, mirrorInBackground } from './services/escalationMirror';
import { prisma } from '../../config/database';
import type { z } from 'zod';
import type { CreateTicketSchema, UpdateTicketSchema, CreateProjectSchema, UpdateProjectSchema, CreateSlaSchema } from './ticketing.schema';
import type { TicketDTO, ProjectDTO, SlaDTO, TicketFilters, TicketPriority } from './ticketing.types';

// Tenant-scoping guards for the ticket store (close the cross-org IDOR).
export { ticketAccessScope, assertTicketAccess, assertAttachmentAccess } from './access';

type CreateTicketInput = z.infer<typeof CreateTicketSchema>;
type UpdateTicketInput = z.infer<typeof UpdateTicketSchema>;

const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { status: 404, code: 'NOT_FOUND' });
const badRequest = (msg: string) => Object.assign(new Error(msg), { status: 400, code: 'BAD_REQUEST' });

// ─── Tickets ─────────────────────────────────────────────────────────────────
export const listTickets = (filters: TicketFilters = {}) => db.listTickets(filters);
export const getTicket = (id: string) => db.getTicketById(id);

export async function createTicket(actorId: string, input: CreateTicketInput, b2bCustomerId?: string | null): Promise<TicketDTO> {
  const project = await db.getProjectSettings(input.projectId);
  if (!project) throw notFound('Project');

  // Ticket-number format (admin-configurable) + the creating org's code, resolved
  // once and reused across the unique-violation retry loop below.
  const numberFormat = await getTicketNumberFormat();
  const orgCode = numberFormat.includeOrgCode ? await resolveOrgCode(b2bCustomerId) : null;

  // SLA: first active SLA matching the ticket priority.
  const slaId = await db.findActiveSlaIdByPriority(input.priority);

  // Round-robin: only when no explicit assignee and the project enables it.
  let assigneeId = input.assigneeId ?? null;
  let settingsToPersist: object | null = null;
  if (!assigneeId) {
    const next = getNextAssignee(project.settings);
    if (next) { assigneeId = next; settingsToPersist = withLastAssigned(project.settings, next); }
  }

  // Link the requesting organization as the ticket's client so the detail view shows
  // Client Name / Email / Contact Person (org-created tickets otherwise carry no client
  // and those fields render blank). Resolved from the creator's B2B org and reused
  // across the org's tickets; an explicit input.customerId (already a ticket-store id) wins.
  //
  // The fallback is keyed on the field being ABSENT, not falsy: an administrator whose
  // form offers a client picker sends customerId: null to mean "no client", and must not
  // have their OWN organization silently linked instead.
  let customerId = input.customerId ?? null;
  if (input.customerId === undefined && b2bCustomerId) {
    const org = await prisma.customer
      .findUnique({ where: { id: b2bCustomerId }, select: { name: true, mailId: true, contactPerson: true } })
      .catch(() => null);
    if (org) {
      customerId = await db.getOrCreateCustomerByName({ name: org.name, email: org.mailId, contactPerson: org.contactPerson });
    }
  }

  // Contact person belongs to the client record (Tickets has no such column), so it is
  // stored on the picked Customers row and shows on every ticket for that client.
  if (input.contactPerson !== undefined && customerId) {
    await db.setCustomerContactPerson(customerId, input.contactPerson);
  }

  const base = {
    title: input.title,
    description: input.description,
    type: input.type,
    priority: input.priority,
    status: input.status,
    projectId: input.projectId,
    reporterId: actorId,
    createdBy: actorId,
    assigneeId,
    customerId,
    storyPoints: input.storyPoints ?? null,
    dueDate: input.dueDate ? new Date(input.dueDate) : null,
    ...(input.labels ? { labels: input.labels } : {}),
    SLAId: slaId,
    branch: input.branch ?? null,
    onSiteSupportRequired: input.onSiteSupportRequired ?? false,
  };

  // Generate TKT-NNN with a unique-violation retry loop (survives races).
  let ticketId: string | null = null;
  for (let attempt = 0; attempt < 10 && !ticketId; attempt++) {
    const ticketNumber = await nextTicketNumber(numberFormat, orgCode);
    try {
      ticketId = await db.createTicketRow({ ...base, ticketNumber });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') continue; // ticketNumber collision → retry
      throw err;
    }
  }
  if (!ticketId) throw Object.assign(new Error('Could not allocate a ticket number'), { status: 500, code: 'TICKET_NUMBER_RACE' });

  if (settingsToPersist) await db.setProjectSettings(input.projectId, settingsToPersist);
  await db.writeActivity({ type: 'created', ticketId, userId: actorId, description: `Created ${base.title}` });

  const ticket = (await db.getTicketById(ticketId))!;
  // Assigned at creation (explicitly or by round-robin) → tell the assignee.
  notifyTicketAssignedInBackground({ ticket, assigneeTicketUserId: assigneeId, actorTicketUserId: actorId });
  return ticket;
}

export async function updateTicket(actorId: string, id: string, input: UpdateTicketInput): Promise<TicketDTO> {
  const current = await db.getTicketCore(id);
  if (!current) throw notFound('Ticket');

  // SLA pause accounting on a status transition.
  const patch = input.status !== undefined
    ? pausePatch({ status: current.status, pausedTime: current.pausedTime, totalPausedTime: current.totalPausedTime }, input.status)
    : {};

  const data = {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
    ...(input.storyPoints !== undefined ? { storyPoints: input.storyPoints } : {}),
    ...(input.dueDate !== undefined ? { dueDate: input.dueDate ? new Date(input.dueDate) : null } : {}),
    ...(input.labels !== undefined ? { labels: input.labels } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.onSiteSupportRequired !== undefined ? { onSiteSupportRequired: input.onSiteSupportRequired } : {}),
    ...(input.reasonForDelay !== undefined ? { reasonForDelay: input.reasonForDelay } : {}),
    ...(input.resolvedMethods !== undefined ? { resolvedMethods: input.resolvedMethods } : {}),
    ...patch,
  };

  await db.updateTicketRow(id, data);

  // An escalated ticket exists twice, in two databases — keep the resolution notes
  // in step so the requester sees how it was resolved and why it was delayed.
  if (input.resolvedMethods !== undefined || input.reasonForDelay !== undefined) {
    mirrorInBackground(() => mirrorFields(id, {
      ...(input.resolvedMethods !== undefined ? { resolvedMethods: input.resolvedMethods } : {}),
      ...(input.reasonForDelay !== undefined ? { reasonForDelay: input.reasonForDelay } : {}),
    }));
  }

  // Typed activity log for the meaningful transitions.
  if (input.status !== undefined && input.status !== current.status) {
    await db.writeActivity({ type: 'status_changed', ticketId: id, userId: actorId, field: 'status', oldValue: current.status, newValue: input.status });
  }
  if (input.priority !== undefined && input.priority !== current.priority) {
    await db.writeActivity({ type: 'priority_changed', ticketId: id, userId: actorId, field: 'priority', oldValue: current.priority, newValue: input.priority });
  }
  const reassigned = input.assigneeId !== undefined && input.assigneeId !== current.assigneeId;
  if (reassigned) {
    await db.writeActivity({ type: 'assigned', ticketId: id, userId: actorId, field: 'assigneeId', oldValue: current.assigneeId, newValue: input.assigneeId });
  }

  const ticket = (await db.getTicketById(id))!;
  // Only a change TO a person notifies — clearing the assignee (null) does not.
  if (reassigned && input.assigneeId) {
    notifyTicketAssignedInBackground({ ticket, assigneeTicketUserId: input.assigneeId, actorTicketUserId: actorId });
  }
  return ticket;
}

// ─── Projects ──────────────────────────────────────────────────────────────────
export const listProjects = () => db.listProjects();

export async function createProject(actorId: string, input: z.infer<typeof CreateProjectSchema>): Promise<ProjectDTO> {
  const id = await db.createProjectRow({
    name: input.name,
    description: input.description ?? null,
    category: input.category,
    type: input.type,
    priority: input.priority,
    leadId: input.leadId ?? actorId,
    settings: (input.settings ?? {}) as object,
    startDate: input.startDate ? new Date(input.startDate) : null,
    endDate: input.endDate ? new Date(input.endDate) : null,
  });
  return (await db.getProjectById(id))!;
}

export async function updateProject(id: string, input: z.infer<typeof UpdateProjectSchema>): Promise<ProjectDTO> {
  const existing = await db.getProjectSettings(id);
  if (!existing) throw notFound('Project');
  await db.updateProjectRow(id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.leadId !== undefined ? { leadId: input.leadId } : {}),
    ...(input.settings !== undefined ? { settings: input.settings as object } : {}),
  });
  return (await db.getProjectById(id))!;
}

export async function deleteProject(id: string): Promise<void> {
  const existing = await db.getProjectSettings(id);
  if (!existing) throw notFound('Project');
  const tickets = await db.countProjectTickets(id);
  if (tickets > 0) throw badRequest(`Project has ${tickets} ticket(s); reassign or close them before deleting.`);
  await db.deleteProjectById(id);
}

// ─── SLAs ──────────────────────────────────────────────────────────────────────
export const listSlas = () => db.listSlas();

export function createSla(input: z.infer<typeof CreateSlaSchema>): Promise<SlaDTO> {
  return db.createSlaRow({
    name: input.name,
    description: input.description ?? null,
    priority: input.priority ?? null,
    responseTime: input.responseTime,
    resolutionTime: input.resolutionTime,
    timeUnit: input.timeUnit,
    ...(input.workingDays ? { workingDays: input.workingDays } : {}),
    businessHours: (input.businessHours ?? undefined) as object | undefined,
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
  });
}

export async function updateSla(id: string, input: Partial<z.infer<typeof CreateSlaSchema>>): Promise<SlaDTO> {
  return db.updateSlaRow(id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.responseTime !== undefined ? { responseTime: input.responseTime } : {}),
    ...(input.resolutionTime !== undefined ? { resolutionTime: input.resolutionTime } : {}),
    ...(input.timeUnit !== undefined ? { timeUnit: input.timeUnit } : {}),
    ...(input.workingDays !== undefined ? { workingDays: input.workingDays } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
  });
}

export const deleteSla = (id: string) => db.deleteSlaById(id);

// Alert polling for staff: tickets created since `since`, excluding the viewer's own.
export async function getNewTickets(since: string, excludeUserId: string) {
  const tickets = await db.listTickets({ since });
  return tickets.filter((t) => t.reporter?.id !== excludeUserId).slice(0, 10);
}

// ─── Notifications ──────────────────────────────────────────────────────────
export const getMyTicketUpdates = (actorId: string, since: string) => db.getMyTicketUpdates(actorId, since);
export const getEscalationAlerts = (since: string, excludeUserId: string) => db.listEscalationAlerts(since, excludeUserId);

// First-wins claim of an (escalated) admin-store ticket: atomically self-assign
// while unassigned; if someone already claimed it, surface who.
export async function claimTicket(claimerId: string, ticketId: string): Promise<TicketDTO> {
  const existing = await db.getTicketCore(ticketId);
  if (!existing) throw notFound('Ticket');
  const won = await db.claimTicket(ticketId, claimerId);
  if (!won) {
    const t = await db.getTicketById(ticketId);
    throw Object.assign(new Error(`Already claimed by ${t?.assignee?.name ?? 'another administrator'}.`), { status: 409, code: 'ALREADY_CLAIMED' });
  }
  await db.writeActivity({ type: 'assigned', ticketId, userId: claimerId, field: 'assigneeId', newValue: claimerId, description: 'Claimed the escalated ticket' });
  return (await db.getTicketById(ticketId))!;
}

// ─── Collaboration: comments / attachments / watchers / history ─────────────────
export const listComments = (ticketId: string) => db.listComments(ticketId);
export const listActivities = (ticketId: string) => db.listActivities(ticketId);
export const listWatchers = (ticketId: string) => db.listWatchers(ticketId);
export const listTicketAttachments = (ticketId: string) => db.listTicketAttachments(ticketId);
export const getAttachmentFile = (id: string) => db.getAttachmentFile(id);
export const watch = (ticketId: string, userId: string) => db.addWatcher(ticketId, userId);
export const unwatch = (ticketId: string, userId: string) => db.removeWatcher(ticketId, userId);

export async function addComment(actorId: string, ticketId: string, content: string, files: Express.Multer.File[] = []) {
  const exists = await db.getTicketCore(ticketId);
  if (!exists) throw notFound('Ticket');
  const commentId = await db.createComment(ticketId, actorId, content);
  for (const f of files) await db.addCommentAttachment(commentId, f, actorId);
  await db.writeActivity({ type: 'commented', ticketId, userId: actorId, description: content.slice(0, 140) });
  // Both halves of an escalated pair see the same conversation.
  mirrorInBackground(() => mirrorComment(ticketId, actorId, content, files));
  return db.listComments(ticketId);
}

export async function addTicketAttachments(actorId: string, ticketId: string, files: Express.Multer.File[]) {
  const exists = await db.getTicketCore(ticketId);
  if (!exists) throw notFound('Ticket');
  for (const f of files) await db.addTicketAttachment(ticketId, f, actorId);
  await db.writeActivity({ type: 'attachment_added', ticketId, userId: actorId, description: `${files.length} file(s) attached` });
  return db.listTicketAttachments(ticketId);
}

// ─── In-app stats / analytics / reports (computed in-process) ───────────────────
const OPEN = ['todo', 'in_progress', 'client_pending'];

export async function getStats() {
  const tickets = await db.allTicketsForStats();
  const total = tickets.length;
  const completed = tickets.filter((t) => t.status === 'completed').length;
  const inProgress = tickets.filter((t) => t.status === 'in_progress').length;
  const todo = tickets.filter((t) => t.status === 'todo').length;
  const clientPending = tickets.filter((t) => t.status === 'client_pending').length;
  const highPriority = tickets.filter((t) => (t.priority === 'high' || t.priority === 'urgent') && t.status !== 'completed').length;
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const today = tickets.filter((t) => t.createdAt >= startOfDay).length;
  return {
    tickets: {
      total, completed, inProgress, todo, clientPending, highPriority, today,
      open: tickets.filter((t) => OPEN.includes(t.status)).length,
      completionRate: total ? Math.round((completed / total) * 100) : 0,
    },
  };
}

export async function getAnalytics() {
  const tickets = await db.allTicketsForStats();
  const byType = new Map<string, number>();
  for (const t of tickets) byType.set(t.type, (byType.get(t.type) ?? 0) + 1);
  const issueDistribution = [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([issue, count]) => ({ issue, count }));

  const daily: Array<{ date: string; created: number }> = [];
  for (let i = 13; i >= 0; i--) daily.push({ date: new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10), created: 0 });
  const idx = new Map(daily.map((d, i) => [d.date, i] as const));
  for (const t of tickets) { const i = idx.get(t.createdAt.toISOString().slice(0, 10)); if (i !== undefined) daily[i]!.created++; }

  const byPriority = (['urgent', 'high', 'medium', 'low'] as TicketPriority[]).map((p) => ({ priority: p, count: tickets.filter((t) => t.priority === p).length }));
  return { issueDistribution, daily, byPriority, analyzed: tickets.length };
}

export async function getReport(type: 'status' | 'priority' | 'type' | 'project' | 'assignee', from?: string, to?: string) {
  const tickets = await db.allTicketsForStats();
  const inRange = tickets.filter((t) => (!from || t.createdAt >= new Date(from)) && (!to || t.createdAt <= new Date(to)));
  const keyOf = (t: typeof tickets[number]): string =>
    type === 'status' ? t.status :
    type === 'priority' ? t.priority :
    type === 'type' ? t.type :
    type === 'project' ? (t.Projects?.name ?? 'No project') :
    (t.Users_Tickets_assigneeIdToUsers ? `${t.Users_Tickets_assigneeIdToUsers.firstName} ${t.Users_Tickets_assigneeIdToUsers.lastName}`.trim() : 'Unassigned');

  const groups = new Map<string, typeof tickets>();
  for (const t of inRange) { const k = keyOf(t); const g = groups.get(k) ?? []; g.push(t); groups.set(k, g); }
  const rows = [...groups.entries()].map(([group, list]) => ({
    group,
    total: list.length,
    completed: list.filter((t) => t.status === 'completed').length,
    inProgress: list.filter((t) => t.status === 'in_progress').length,
    todo: list.filter((t) => t.status === 'todo').length,
    highPriority: list.filter((t) => t.priority === 'high' || t.priority === 'urgent').length,
  })).sort((a, b) => b.total - a.total);

  return { rows, totalTickets: inRange.length, from: from ?? null, to: to ?? null, type };
}
