import fs from 'fs/promises';
import path from 'path';
import * as db from './ticketing.client';
import { UPLOAD_DIR } from './uploads';
import { resolveB2bIdentity } from './identity';
import { notify } from '../notifications/notifications.service';
import { nextTicketNumber } from './utils/ticketNumber';
import { getTicketNumberFormat, resolveOrgCode } from './services/numberFormat';
import { getNextAssignee, withLastAssigned } from './utils/roundRobin';
import { pausePatch } from './services/slaService';
import { notifyTicketAssignedInBackground } from './services/ticketNotify';
import { mirrorComment, mirrorFields, mirrorInBackground } from './services/escalationMirror';
import { isBreached } from './services/dashboardAggregate';
import { prisma } from '../../config/database';
import type { Role } from '@prisma/client';
import type { z } from 'zod';
import type { CreateTicketSchema, UpdateTicketSchema, CreateProjectSchema, UpdateProjectSchema, CreateSlaSchema } from './ticketing.schema';
import type { TicketDTO, ProjectDTO, SlaDTO, TicketFilters, TicketPriority } from './ticketing.types';

// Tenant-scoping guards for the ticket store (close the cross-org IDOR).
export { ticketAccessScope, assertTicketAccess, assertAttachmentAccess } from './access';

type CreateTicketInput = z.infer<typeof CreateTicketSchema>;
type UpdateTicketInput = z.infer<typeof UpdateTicketSchema>;

const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { status: 404, code: 'NOT_FOUND' });

// ─── Tickets ─────────────────────────────────────────────────────────────────
export const listTickets = (filters: TicketFilters = {}) => db.listTickets(filters);
export const getTicket = (id: string) => db.getTicketById(id);

export async function createTicket(actorId: string, input: CreateTicketInput, b2bCustomerId?: string | null, creatorRole?: Role): Promise<TicketDTO> {
  const project = await db.getProjectSettings(input.projectId);
  if (!project) throw notFound('Project');

  // Ticket-number format (admin-configurable) + the creating org's code, resolved
  // once and reused across the unique-violation retry loop below.
  const numberFormat = await getTicketNumberFormat();
  const orgCode = numberFormat.includeOrgCode ? await resolveOrgCode(b2bCustomerId) : null;

  // SLA: first active SLA matching the ticket priority.
  const slaId = await db.findActiveSlaIdByPriority(input.priority);

  // A plain organization member's ticket is routed to its ORG ADMIN — LAZILY. The
  // ticket is stored UNASSIGNED with the `pending:org-admin` label, and the first
  // org admin who opens it (from the ticket list or its notification) claims it in
  // getTicket. Round-robin is bypassed for these: they already have a designated
  // taker, and an explicit assignee the user picked always wins over both.
  const pendingOrgAdmin = creatorRole === 'USER' && Boolean(b2bCustomerId) && !input.assigneeId;

  // Round-robin: only when no explicit assignee and the project enables it.
  let assigneeId = input.assigneeId ?? null;
  let settingsToPersist: object | null = null;
  if (!assigneeId && !pendingOrgAdmin) {
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

  // Same for the client's email: the form prefills it from the client record, so what
  // comes back is either that same address or the one the administrator filled in for a
  // client that had none.
  if (input.customerEmail !== undefined && customerId) {
    await db.setCustomerEmail(customerId, input.customerEmail);
  }

  const labels = [...(input.labels ?? []), ...(pendingOrgAdmin ? ['pending:org-admin'] : [])];

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
    ...(labels.length ? { labels } : {}),
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
  const nextStatus = input.status;
  const statusChanged = nextStatus !== undefined && nextStatus !== current.status;
  const patch = statusChanged
    ? pausePatch({ status: current.status, pausedTime: current.pausedTime, totalPausedTime: current.totalPausedTime }, nextStatus)
    : {};
  // resolvedAt is the moment status flips to completed: set it on resolution,
  // clear it when a completed ticket is reopened. Column absent until migration
  // 2026-09-09-ticket-resolvedat.sql is applied — NULL just reads as unresolved.
  const resolutionPatch = statusChanged
    ? nextStatus === 'completed'
      ? { resolvedAt: new Date() }
      : current.status === 'completed'
        ? { resolvedAt: null }
        : {}
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
    ...resolutionPatch,
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
  // A title or description edit used to leave NO trace in the ticket's own timeline,
  // so a reworded ticket looked untouched. The 'updated' activity type already existed
  // for this and was only ever used by escalation.
  if (input.title !== undefined && input.title !== current.title) {
    await db.writeActivity({ type: 'updated', ticketId: id, userId: actorId, field: 'title', oldValue: current.title, newValue: input.title });
  }
  if (input.description !== undefined && input.description !== current.description) {
    // The bodies can be 10k characters; record THAT it changed, not two novels.
    await db.writeActivity({ type: 'updated', ticketId: id, userId: actorId, field: 'description', oldValue: null, newValue: null });
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

/**
 * Permanently delete a ticket. Returns what the caller needs for the audit row,
 * because after this the ticket — and its entire Activities history, which is
 * ON DELETE CASCADE — no longer exists to be read.
 *
 * Order is deliberate and must not be rearranged:
 *   escalation check → capture identifiers → unlink files → delete row.
 */
export async function deleteTicket(id: string): Promise<{ ticketNumber: string; title: string }> {
  const ticket = await db.getTicketForDelete(id);
  if (!ticket) throw notFound('Ticket');

  // An escalated ticket has a COPY in the other database, joined only by a
  // `src:<ticketNumber>` label with no foreign key. Deleting this one would leave
  // that copy alive and permanently unresolvable, with nothing surfacing the break
  // (mirror failures are swallowed by design). Refuse instead.
  if (ticket.labels.includes('escalated')) {
    throw Object.assign(
      new Error('This ticket has been escalated to the platform team and cannot be deleted.'),
      { status: 409, code: 'TICKET_ESCALATED' },
    );
  }

  // Files before rows: the cascade destroys the filenames, and orphaned bytes on
  // disk can then never be matched back to anything.
  const filenames = await db.getTicketAttachmentFilenames(id);
  await Promise.all(filenames.map((name) =>
    fs.unlink(path.join(UPLOAD_DIR, path.basename(name))).catch(() => {}),
  ));

  await db.deleteTicketRow(id);
  return { ticketNumber: ticket.ticketNumber, title: ticket.title };
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

/**
 * Delete a project and everything under it. IRREVERSIBLE.
 *
 * This used to refuse outright whenever the project held any ticket, telling the
 * caller to "reassign or close them" — which was doubly wrong: the count ignores
 * status so closing changed nothing, and there is no reassign UI. Every project in
 * both stores holds hundreds of tickets, so in practice nothing was ever deletable.
 *
 * The guard is now a typed-name confirmation instead of an impossible precondition.
 * It is checked HERE, not only in the dialog: a destructive endpoint that trusts the
 * client to have asked is not confirmed, it is merely inconvenient to call by hand.
 */
export async function deleteProject(id: string, confirmName: string): Promise<{ name: string; tickets: number; attachments: number }> {
  const project = await db.getProjectForDelete(id);
  if (!project) throw notFound('Project');

  if (confirmName.trim() !== project.name.trim()) {
    throw Object.assign(new Error('The typed name does not match this project.'), {
      status: 400, code: 'CONFIRM_MISMATCH',
    });
  }

  // An escalated ticket has a COPY in the other database joined only by a `src:` label
  // with no foreign key. Taking this side out leaves that copy alive and permanently
  // unresolvable, with nothing surfacing the break — so refuse, exactly as deleteTicket
  // does for the single-ticket case.
  const escalated = await db.countEscalatedInProject(id);
  if (escalated > 0) {
    throw Object.assign(
      new Error(`${escalated} ticket(s) in this project have been escalated to the platform team; the project cannot be deleted.`),
      { status: 409, code: 'PROJECT_HAS_ESCALATIONS' },
    );
  }

  const { tickets, attachments } = await db.deleteProjectCascade(id);
  return { name: project.name, tickets, attachments };
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
// Same tenant rule as every other read: without `scope` this polled the whole shared
// store, so an ORG_ADMIN's "new tickets" alerts surfaced other organizations' ticket
// TITLES — a worse leak than the aggregate counts, since it is verbatim customer text.
export async function getNewTickets(since: string, excludeUserId: string, scope: string[] | null) {
  const tickets = await db.listTickets({ since, ...(scope ? { reporterOrAssigneeIn: scope } : {}) });
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

// The lazy half of auto-assign-to-org-admin: a plain member's ticket carries the
// pending:org-admin label, and OPENING it as an ORG_ADMIN claims it (first-wins).
// Best-effort by design — losing the race, or encountering an already-assigned
// label-free ticket, simply yields the caller's existing ticket unchanged.
export async function claimPendingOrgAdminTicket(claimerId: string, ticketId: string): Promise<TicketDTO | null> {
  const current = await db.getTicketById(ticketId);
  if (!current || current.assignee !== null || !current.labels.includes('pending:org-admin')) return null;
  const won = await db.claimTicket(ticketId, claimerId); // atomic: WHERE assigneeId IS NULL
  if (!won) return null;
  await db.updateTicketRow(ticketId, { labels: current.labels.filter((l) => l !== 'pending:org-admin') });
  await db.writeActivity({ type: 'assigned', ticketId, userId: claimerId, field: 'assigneeId', newValue: claimerId, description: 'Auto-assigned to the organization admin on open' });
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

export interface AddCommentExtras {
  /** Ticket-store user ids chosen from the @ picker. Validated here, never trusted. */
  mentions: string[];
  /** The author's MAIN-database user id — recorded as the notification's actor. */
  actorB2bUserId: string;
}

export async function addComment(
  actorId: string,
  ticketId: string,
  content: string,
  files: Express.Multer.File[] = [],
  extras?: AddCommentExtras,
) {
  const exists = await db.getTicketCore(ticketId);
  if (!exists) throw notFound('Ticket');
  const commentId = await db.createComment(ticketId, actorId, content);
  for (const f of files) await db.addCommentAttachment(commentId, f, actorId);
  await db.writeActivity({ type: 'commented', ticketId, userId: actorId, description: content.slice(0, 140) });
  // Both halves of an escalated pair see the same conversation.
  mirrorInBackground(() => mirrorComment(ticketId, actorId, content, files));

  if (extras?.mentions.length) {
    await deliverMentions({ actorId, ticketId, commentId, content, ...extras });
  }
  return db.listComments(ticketId);
}

/**
 * Notify everyone named in a comment. Three guards, and all three are load-bearing.
 *
 * Failures are swallowed: the comment is already committed, and a notification
 * problem must not turn a successful post into an error the author has to retry.
 */
async function deliverMentions(args: {
  actorId: string; ticketId: string; commentId: string; content: string;
  mentions: string[]; actorB2bUserId: string;
}): Promise<void> {
  try {
    // GUARD 1 — PLATFORM USERS ONLY. Mentions address B2B-Site accounts, so the
    // candidate must resolve to one. `resolveB2bIdentity` joins the ticket-store
    // user to the platform users list BY EMAIL and returns null for bots and for
    // ticketing staff without a B2B account — those simply cannot be mentioned.
    // This now runs for every ticket in both stores (no scope gate anymore):
    // the comment route serves both, so the email check is the actual boundary.
    if (args.mentions.length === 0) return;

    // GUARD 2 — SELF. Mentioning yourself notifies nobody, matching the
    // self-assignment skip in ticketNotify.ts.
    const ticket = await db.getTicketForDelete(args.ticketId);  // id + number + title
    const author = (await db.getUserName(args.actorId).catch(() => null)) ?? 'Someone';

    for (const ticketUserId of [...new Set(args.mentions)]) {
      if (ticketUserId === args.actorId) continue;

      // Ticket-store id → main-database account. This IS the platform-users-list
      // validation: if there is no platform user with this email, nobody is
      // mentioned and no notification is created.
      const recipient = await resolveB2bIdentity(ticketUserId);
      if (!recipient) continue;

      // The mention belongs in the ticket's own timeline too, so it reads in
      // context. Decoration only — the Notification row is the delivery guarantee.
      await db.writeActivity({
        type: 'mentioned', ticketId: args.ticketId, userId: args.actorId,
        field: 'mention', newValue: ticketUserId, description: args.content.slice(0, 140),
      }).catch(() => {});

      await notify({
        userId: recipient.userId,
        customerId: recipient.tenantId,   // the RECIPIENT's org — see notifications.service
        kind: 'ticket_mention',
        title: `${author} mentioned you on ${ticket?.ticketNumber ?? 'a ticket'}`,
        body: args.content.slice(0, 200),
        url: `/ticketing?ticket=${args.ticketId}`,
        actorId: args.actorB2bUserId,
        entityId: args.ticketId,
      });
    }
  } catch (err) {
    console.error('⚠️  Mention delivery failed:', err instanceof Error ? err.message : err);
  }
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

// Every function below takes the caller's `scope` (from ticketAccessScope) and passes
// it to the query. They used to read the whole store, so an ORG_ADMIN's numbers were
// inflated by every OTHER organization sharing b2b_ticket. `null` means the whole
// store and is correct only for an administrator inside the isolated admin store.
export async function getStats(scope: string[] | null) {
  const tickets = await db.allTicketsForStats(scope);
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

export async function getAnalytics(scope: string[] | null) {
  const tickets = await db.allTicketsForStats(scope);
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

// ─── Ticket report ─────────────────────────────────────────────────────────────
// Per-ticket rows, grouped. This replaced an aggregate that returned only group
// COUNTS — the Reports tab now lets the user choose which ticket columns to export,
// which needs the tickets themselves.
//
// Every selectable field is returned regardless of what the user ticked: the field
// picker lives in the browser, so changing the column set is a re-render rather than
// a refetch. Filtering server-side by field would buy nothing and cost a round trip.

export type ReportType = 'client' | 'assignee' | 'overall' | 'sla_breach';

export interface ReportGroup {
  key: string;
  label: string;
  tickets: db.ReportTicketRow[];
}

export interface TicketReportResult {
  type: ReportType;
  from: string | null;
  to: string | null;
  customerId: string | null;
  assigneeId: string | null;
  groups: ReportGroup[];
  totals: { tickets: number; open: number; completed: number; breached: number };
  truncated: boolean;
}

export async function getReport(
  input: { type: ReportType; customerId: string[]; assigneeId?: string; from?: Date; to?: Date },
  scope: string[] | null,
): Promise<TicketReportResult> {
  const { rows, truncated } = await db.listReportTickets({
    ...(input.customerId.length ? { customerIds: input.customerId } : {}),
    ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
  }, scope);

  const now = Date.now();
  // Resolution breaches only. isBreached is the DASHBOARD's rule, imported rather than
  // re-derived so a ticket cannot read as breached on one screen and healthy on the
  // other. Response-SLA breach is deliberately excluded: nothing records a first
  // response, so slaService computes it as an approximation (slaService.ts:70-72) and
  // a report is the wrong place to present an estimate as a fact.
  const considered = input.type === 'sla_breach' ? rows.filter((t) => isBreached(t, now)) : rows;

  const groupOf = (t: db.ReportTicketRow): { key: string; label: string } => {
    switch (input.type) {
      case 'assignee':
        return { key: t.assigneeId ?? '__unassigned__', label: t.assigneeName ?? 'Unassigned' };
      case 'overall':
        return { key: '__all__', label: 'All tickets' };
      // sla_breach groups by client too — "who is being let down" is the question it
      // exists to answer.
      case 'client':
      case 'sla_breach':
      default:
        return { key: t.customerId ?? '__no_client__', label: t.customerName ?? 'No client' };
    }
  };

  const byKey = new Map<string, ReportGroup>();
  for (const t of considered) {
    const { key, label } = groupOf(t);
    const g = byKey.get(key) ?? { key, label, tickets: [] };
    g.tickets.push(t);
    byKey.set(key, g);
  }

  return {
    type: input.type,
    from: input.from?.toISOString() ?? null,
    to: input.to?.toISOString() ?? null,
    customerId: input.customerId[0] ?? null,
    assigneeId: input.assigneeId ?? null,
    groups: [...byKey.values()].sort((a, b) => b.tickets.length - a.tickets.length),
    totals: {
      tickets: considered.length,
      open: considered.filter((t) => OPEN.includes(t.status)).length,
      completed: considered.filter((t) => t.status === 'completed').length,
      breached: considered.filter((t) => isBreached(t, now)).length,
    },
    truncated,
  };
}
