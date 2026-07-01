import { ticketPrisma, getTicketDb } from '../../config/ticketDatabase';
import { evaluateSla, type TimeUnit } from './services/slaService';
import type {
  TicketDTO, ProjectDTO, SlaDTO, TicketFilters, PersonRef,
  TicketStatus, TicketPriority, TicketType, ProjectPriority,
  CommentDTO, AttachmentDTO, ActivityDTO,
} from './ticketing.types';

type UploadedFile = { filename: string; originalname: string; mimetype: string; size: number; path: string };

// ─── Includes ────────────────────────────────────────────────────────────────
const userSel = { select: { id: true, firstName: true, lastName: true, email: true } } as const;

// NOTE: the required Projects + reporter relations are deliberately NOT included here.
// The admin ticket store (b2b_ticketing_admin) can hold tickets whose projectId/reporterId
// reference rows that no longer exist; a required-relation `include` would then make Prisma
// throw "Inconsistent query result: Field … is required to return data, got null" and 500
// the whole request. We batch-load them separately (resolveTicketRefs) and tolerate gaps.
const ticketInclude = {
  Users_Tickets_assigneeIdToUsers: userSel,
  Customers: { select: { id: true, name: true } },
  SLAs: { select: { id: true, name: true, resolutionTime: true, timeUnit: true } },
  _count: { select: { Comments: true, TicketAttachments: true, TicketWatchers: true } },
} as const;

type TicketRow = Awaited<ReturnType<typeof ticketPrisma.tickets.findFirstOrThrow<{ include: typeof ticketInclude }>>>;

function person(u: { id: string; firstName: string; lastName: string; email: string | null } | null): PersonRef | null {
  if (!u) return null;
  return { id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email };
}

// Batch-load the required-relation rows (project + reporter) for a set of tickets, keyed by
// id, tolerating orphaned references (Map.get(...) ?? null) instead of throwing.
async function resolveTicketRefs(rows: ReadonlyArray<{ projectId: string; reporterId: string }>) {
  const db = getTicketDb();
  const [projects, reporters] = await Promise.all([
    db.projects.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.projectId))] } }, select: { id: true, name: true } }),
    db.users.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.reporterId))] } }, ...userSel }),
  ]);
  return {
    projects: new Map(projects.map((p) => [p.id, p])),
    reporters: new Map(reporters.map((u) => [u.id, u])),
  };
}

function toTicketDTO(row: TicketRow, project: { id: string; name: string } | null, reporter: PersonRef | null): TicketDTO {
  const sla = row.SLAs ? { id: row.SLAs.id, name: row.SLAs.name, resolutionTime: row.SLAs.resolutionTime, timeUnit: row.SLAs.timeUnit as string } : null;
  const evalSla = evaluateSla(
    { status: row.status, createdAt: row.createdAt, pausedTime: row.pausedTime, totalPausedTime: row.totalPausedTime },
    row.SLAs ? { resolutionTime: row.SLAs.resolutionTime, timeUnit: row.SLAs.timeUnit as TimeUnit } : null,
  );
  return {
    id: row.id,
    ticketNumber: row.ticketNumber,
    title: row.title,
    description: row.description,
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    type: row.type as TicketType,
    projectId: row.projectId,
    projectName: project?.name ?? null,
    reporter,
    assignee: person(row.Users_Tickets_assigneeIdToUsers),
    customer: row.Customers ? { id: row.Customers.id, name: row.Customers.name } : null,
    storyPoints: row.storyPoints,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    labels: row.labels,
    branch: row.branch,
    onSiteSupportRequired: row.onSiteSupportRequired,
    reasonForDelay: row.reasonForDelay,
    resolvedMethods: row.resolvedMethods,
    sla,
    slaStatus: evalSla.status,
    slaRemainingSeconds: evalSla.remainingSeconds,
    slaDeadline: evalSla.deadline,
    pausedTime: row.pausedTime ? row.pausedTime.toISOString() : null,
    totalPausedTime: row.totalPausedTime,
    counts: { comments: row._count.Comments, attachments: row._count.TicketAttachments, watchers: row._count.TicketWatchers },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── Tickets ─────────────────────────────────────────────────────────────────
export async function listTickets(filters: TicketFilters = {}): Promise<TicketDTO[]> {
  const rows = await getTicketDb().tickets.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.priority ? { priority: filters.priority } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.assigneeId ? { assigneeId: filters.assigneeId } : {}),
      ...(filters.since ? { createdAt: { gt: new Date(filters.since) } } : {}),
      ...(filters.mineUserId ? { OR: [{ reporterId: filters.mineUserId }, { assigneeId: filters.mineUserId }] } : {}),
      ...(filters.search ? {
        OR: [
          { title: { contains: filters.search, mode: 'insensitive' as const } },
          { ticketNumber: { contains: filters.search, mode: 'insensitive' as const } },
        ],
      } : {}),
    },
    include: ticketInclude,
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const refs = await resolveTicketRefs(rows);
  return rows.map((r) => toTicketDTO(r, refs.projects.get(r.projectId) ?? null, person(refs.reporters.get(r.reporterId) ?? null)));
}

export async function getTicketById(id: string): Promise<TicketDTO | null> {
  const row = await getTicketDb().tickets.findUnique({ where: { id }, include: ticketInclude });
  if (!row) return null;
  const refs = await resolveTicketRefs([row]);
  return toTicketDTO(row, refs.projects.get(row.projectId) ?? null, person(refs.reporters.get(row.reporterId) ?? null));
}

// Minimal fields for status/assign transitions (pause accounting).
export function getTicketCore(id: string) {
  return getTicketDb().tickets.findUnique({
    where: { id },
    select: { id: true, status: true, priority: true, assigneeId: true, projectId: true, pausedTime: true, totalPausedTime: true },
  });
}

export async function createTicketRow(data: Parameters<typeof ticketPrisma.tickets.create>[0]['data']): Promise<string> {
  const row = await getTicketDb().tickets.create({ data, select: { id: true } });
  return row.id;
}

export function updateTicketRow(id: string, data: Parameters<typeof ticketPrisma.tickets.update>[0]['data']) {
  return getTicketDb().tickets.update({ where: { id }, data, select: { id: true } });
}

// First active SLA whose priority matches the ticket priority (report §7.2 step 3).
export async function findActiveSlaIdByPriority(priority: TicketPriority): Promise<string | null> {
  const sla = await getTicketDb().sLAs.findFirst({
    where: { isActive: true, priority },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return sla?.id ?? null;
}

// ─── Activity log ──────────────────────────────────────────────────────────────
type ActivityType = 'created' | 'updated' | 'commented' | 'status_changed' | 'priority_changed' | 'assigned' | 'attachment_added';
export function writeActivity(a: {
  type: ActivityType; ticketId: string; userId: string;
  field?: string; oldValue?: unknown; newValue?: unknown; description?: string;
}) {
  return getTicketDb().activities.create({
    data: {
      type: a.type, ticketId: a.ticketId, userId: a.userId,
      field: a.field ?? null,
      oldValue: a.oldValue === undefined ? undefined : (a.oldValue as object),
      newValue: a.newValue === undefined ? undefined : (a.newValue as object),
      description: a.description ?? null,
    },
  });
}

// ─── Projects ──────────────────────────────────────────────────────────────────
// The required lead (Users) relation is loaded separately (see resolveTicketRefs rationale)
// so an orphaned leadId degrades to a null lead instead of throwing/500-ing.
const projectInclude = {
  _count: { select: { ProjectMembers: true, Tickets: true } },
} as const;
type ProjectRow = Awaited<ReturnType<typeof ticketPrisma.projects.findFirstOrThrow<{ include: typeof projectInclude }>>>;

function toProjectDTO(row: ProjectRow, lead: PersonRef | null): ProjectDTO {
  return {
    id: row.id, name: row.name, description: row.description, status: row.status,
    category: row.category, type: row.type as string, priority: row.priority as ProjectPriority,
    leadId: row.leadId, lead, settings: row.settings,
    memberCount: row._count.ProjectMembers, ticketCount: row._count.Tickets,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listProjects(): Promise<ProjectDTO[]> {
  const rows = await getTicketDb().projects.findMany({ include: projectInclude, orderBy: { createdAt: 'desc' } });
  const leadRows = await getTicketDb().users.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.leadId))] } }, ...userSel });
  const leads = new Map(leadRows.map((u) => [u.id, u]));
  return rows.map((r) => toProjectDTO(r, person(leads.get(r.leadId) ?? null)));
}
export async function getProjectById(id: string): Promise<ProjectDTO | null> {
  const row = await getTicketDb().projects.findUnique({ where: { id }, include: projectInclude });
  if (!row) return null;
  const lead = await getTicketDb().users.findUnique({ where: { id: row.leadId }, ...userSel });
  return toProjectDTO(row, person(lead));
}
export function getProjectSettings(id: string) {
  return getTicketDb().projects.findUnique({ where: { id }, select: { id: true, settings: true } });
}
export function setProjectSettings(id: string, settings: object) {
  return getTicketDb().projects.update({ where: { id }, data: { settings }, select: { id: true } });
}
export async function createProjectRow(data: Parameters<typeof ticketPrisma.projects.create>[0]['data']): Promise<string> {
  const row = await getTicketDb().projects.create({ data, select: { id: true } });
  return row.id;
}
// Find (or lazily create) the "Escalations" project in the CURRENT store — where
// escalated client tickets land in the admin DB.
export async function getOrCreateEscalationProject(leadId: string): Promise<string> {
  const existing = await getTicketDb().projects.findFirst({ where: { name: 'Escalations' }, select: { id: true } });
  if (existing) return existing.id;
  const created = await getTicketDb().projects.create({
    data: { name: 'Escalations', description: 'Tickets escalated from client organizations', category: 'escalation', type: 'other', priority: 'high', leadId },
    select: { id: true },
  });
  return created.id;
}
export function updateProjectRow(id: string, data: Parameters<typeof ticketPrisma.projects.update>[0]['data']) {
  return getTicketDb().projects.update({ where: { id }, data, select: { id: true } });
}
export function countProjectTickets(id: string) {
  return getTicketDb().tickets.count({ where: { projectId: id } });
}
export async function deleteProjectById(id: string): Promise<void> {
  // Tickets.projectId is NOT NULL — the service blocks deletion when tickets exist.
  await getTicketDb().projects.delete({ where: { id } });
}

// ─── SLAs ──────────────────────────────────────────────────────────────────────
function toSlaDTO(row: Awaited<ReturnType<typeof ticketPrisma.sLAs.findFirstOrThrow>>): SlaDTO {
  return {
    id: row.id, name: row.name, description: row.description,
    priority: (row.priority as TicketPriority | null) ?? null,
    responseTime: row.responseTime, resolutionTime: row.resolutionTime,
    timeUnit: row.timeUnit as 'minutes' | 'hours' | 'days',
    workingDays: row.workingDays, businessHours: row.businessHours, isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}
export async function listSlas(): Promise<SlaDTO[]> {
  const rows = await getTicketDb().sLAs.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map(toSlaDTO);
}
export async function createSlaRow(data: Parameters<typeof ticketPrisma.sLAs.create>[0]['data']): Promise<SlaDTO> {
  const row = await getTicketDb().sLAs.create({ data });
  return toSlaDTO(row);
}
export async function updateSlaRow(id: string, data: Parameters<typeof ticketPrisma.sLAs.update>[0]['data']): Promise<SlaDTO> {
  const row = await getTicketDb().sLAs.update({ where: { id }, data });
  return toSlaDTO(row);
}
export function deleteSlaById(id: string) {
  return getTicketDb().sLAs.delete({ where: { id } });
}

// ─── Staff (assignee pool) ─────────────────────────────────────────────────────
export async function listStaff(): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
  const rows = await getTicketDb().users.findMany({
    where: { isActive: true },
    select: { id: true, firstName: true, lastName: true, email: true, role: true },
    orderBy: [{ firstName: 'asc' }],
  });
  return rows.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email, role: u.role as string }));
}

// ─── Comments ──────────────────────────────────────────────────────────────────
function attDTO(a: { id: string; originalName: string | null; mimeType: string | null; size: number | null; createdAt: Date },
  kind: 'ticket' | 'comment', uploader: Parameters<typeof person>[0]): AttachmentDTO {
  return { id: a.id, originalName: a.originalName, mimeType: a.mimeType, size: a.size, kind, uploadedBy: person(uploader), createdAt: a.createdAt.toISOString() };
}

export async function listComments(ticketId: string): Promise<CommentDTO[]> {
  const rows = await getTicketDb().comments.findMany({
    where: { ticketId },
    include: { Users: userSel, CommentAttachments: { include: { Users: userSel } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((c) => ({
    id: c.id, content: c.content, author: person(c.Users),
    attachments: c.CommentAttachments.map((a) => attDTO(a, 'comment', a.Users)),
    createdAt: c.createdAt.toISOString(),
  }));
}
export async function createComment(ticketId: string, userId: string, content: string): Promise<string> {
  const c = await getTicketDb().comments.create({ data: { ticketId, userId, content }, select: { id: true } });
  return c.id;
}
export function addCommentAttachment(commentId: string, file: UploadedFile, uploadedBy: string) {
  return getTicketDb().commentAttachments.create({
    data: { commentId, filename: file.filename, originalName: file.originalname, mimeType: file.mimetype, size: file.size, path: file.path, uploadedBy },
  });
}

// ─── Ticket attachments ─────────────────────────────────────────────────────────
export async function listTicketAttachments(ticketId: string): Promise<AttachmentDTO[]> {
  const rows = await getTicketDb().ticketAttachments.findMany({ where: { ticketId }, include: { Users: userSel }, orderBy: { createdAt: 'asc' } });
  return rows.map((a) => attDTO(a, 'ticket', a.Users));
}
export function addTicketAttachment(ticketId: string, file: UploadedFile, uploadedBy: string | null) {
  return getTicketDb().ticketAttachments.create({
    data: { ticketId, filename: file.filename, originalName: file.originalname, mimeType: file.mimetype, size: file.size, path: file.path, uploadedBy },
  });
}
export async function getAttachmentFile(id: string): Promise<{ path: string | null; originalName: string | null; mimeType: string | null } | null> {
  const t = await getTicketDb().ticketAttachments.findUnique({ where: { id }, select: { path: true, originalName: true, mimeType: true } });
  if (t) return t;
  return getTicketDb().commentAttachments.findUnique({ where: { id }, select: { path: true, originalName: true, mimeType: true } });
}

// ─── Watchers ───────────────────────────────────────────────────────────────────
export async function listWatchers(ticketId: string): Promise<PersonRef[]> {
  const rows = await getTicketDb().ticketWatchers.findMany({ where: { ticketId }, include: { Users: userSel } });
  return rows.map((w) => person(w.Users)).filter((p): p is PersonRef => p !== null);
}
export async function addWatcher(ticketId: string, userId: string): Promise<void> {
  const n = await getTicketDb().ticketWatchers.count({ where: { ticketId, userId } });
  if (!n) await getTicketDb().ticketWatchers.create({ data: { ticketId, userId } });
}
export async function removeWatcher(ticketId: string, userId: string): Promise<void> {
  await getTicketDb().ticketWatchers.deleteMany({ where: { ticketId, userId } });
}

// ─── Activity history ─────────────────────────────────────────────────────────
export async function listActivities(ticketId: string): Promise<ActivityDTO[]> {
  const rows = await getTicketDb().activities.findMany({ where: { ticketId }, include: { Users: userSel }, orderBy: { createdAt: 'desc' } });
  return rows.map((a) => ({
    id: a.id, type: a.type as string, field: a.field, oldValue: a.oldValue, newValue: a.newValue,
    description: a.description, user: person(a.Users), createdAt: a.createdAt.toISOString(),
  }));
}

// ─── Stats source ────────────────────────────────────────────────────────────
export async function allTicketsForStats() {
  const rows = await getTicketDb().tickets.findMany({
    select: {
      status: true, priority: true, type: true, projectId: true, createdAt: true,
      Users_Tickets_assigneeIdToUsers: { select: { firstName: true, lastName: true } },
    },
  });
  // Resolve project names separately, tolerating orphaned projectIds (see ticketInclude note).
  const projects = await getTicketDb().projects.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.projectId))] } },
    select: { id: true, name: true },
  });
  const byId = new Map(projects.map((p) => [p.id, p]));
  return rows.map((r) => ({ ...r, Projects: byId.get(r.projectId) ?? null }));
}
