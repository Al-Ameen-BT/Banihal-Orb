import { ticketPrisma, getTicketDb } from '../../config/ticketDatabase';
import { evaluateSla, evaluateResponseSla, type TimeUnit } from './services/slaService';
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
  Customers: { select: { id: true, name: true, email: true, contactPerson: true } },
  SLAs: { select: { id: true, name: true, responseTime: true, resolutionTime: true, timeUnit: true } },
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
  const sla = row.SLAs ? { id: row.SLAs.id, name: row.SLAs.name, responseTime: row.SLAs.responseTime, resolutionTime: row.SLAs.resolutionTime, timeUnit: row.SLAs.timeUnit as string } : null;
  const timeFields = { status: row.status, createdAt: row.createdAt, pausedTime: row.pausedTime, totalPausedTime: row.totalPausedTime };
  const resolutionSla = evaluateSla(timeFields, row.SLAs ? { resolutionTime: row.SLAs.resolutionTime, timeUnit: row.SLAs.timeUnit as TimeUnit } : null);
  const responseSla = evaluateResponseSla(timeFields, row.SLAs ? { responseTime: row.SLAs.responseTime, timeUnit: row.SLAs.timeUnit as TimeUnit } : null);
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
    customer: row.Customers ? { id: row.Customers.id, name: row.Customers.name, email: row.Customers.email, contactPerson: row.Customers.contactPerson } : null,
    storyPoints: row.storyPoints,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    labels: row.labels,
    branch: row.branch,
    onSiteSupportRequired: row.onSiteSupportRequired,
    reasonForDelay: row.reasonForDelay,
    resolvedMethods: row.resolvedMethods,
    sla,
    slaStatus: resolutionSla.status,
    slaRemainingSeconds: resolutionSla.remainingSeconds,
    slaDeadline: resolutionSla.deadline,
    responseSla,
    resolutionSla,
    pausedTime: row.pausedTime ? row.pausedTime.toISOString() : null,
    totalPausedTime: row.totalPausedTime,
    counts: { comments: row._count.Comments, attachments: row._count.TicketAttachments, watchers: row._count.TicketWatchers },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── Tickets ─────────────────────────────────────────────────────────────────
export async function listTickets(filters: TicketFilters = {}): Promise<TicketDTO[]> {
  // Each reporter/assignee OR-group goes in a separate AND clause — combining them
  // as sibling `OR` keys would silently overwrite one another (a single object can
  // hold only one `OR`), so the tenant scope must not share a key with `mine`/search.
  const and: Record<string, unknown>[] = [];
  if (filters.reporterOrAssigneeIn) {
    and.push({ OR: [{ reporterId: { in: filters.reporterOrAssigneeIn } }, { assigneeId: { in: filters.reporterOrAssigneeIn } }] });
  }
  if (filters.mineUserId) {
    and.push({ OR: [{ reporterId: filters.mineUserId }, { assigneeId: filters.mineUserId }] });
  }
  if (filters.search) {
    and.push({ OR: [
      { title: { contains: filters.search, mode: 'insensitive' as const } },
      { ticketNumber: { contains: filters.search, mode: 'insensitive' as const } },
    ] });
  }
  const rows = await getTicketDb().tickets.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.priority ? { priority: filters.priority } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.assigneeId ? { assigneeId: filters.assigneeId } : {}),
      ...(filters.escalatedOnly ? { labels: { has: 'escalated' } } : {}),
      ...(filters.since ? { createdAt: { gt: new Date(filters.since) } } : {}),
      ...(and.length ? { AND: and } : {}),
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

// Find (or additively create) a Customers row by name in the CURRENT store — used by
// escalation to replicate the source org into the admin store so escalated tickets can
// be grouped per organization and expose Client Name/Email/Contact. Never mutates an
// existing row (production-safe: the admin DB's existing customers are untouched).
// Resolve the ticket-store Customers row for an organization, creating it if absent.
// An EXISTING row is refreshed when the incoming email/contactPerson differ — otherwise the
// row keeps whatever the very first caller wrote (e.g. the first escalation's requester) and
// silently goes stale as the org's details change.
export async function getOrCreateCustomerByName(c: { name: string; email?: string | null; contactPerson?: string | null }): Promise<string> {
  const existing = await getTicketDb().customers.findFirst({
    where: { name: c.name },
    select: { id: true, email: true, contactPerson: true },
  });
  if (existing) {
    const patch: { email?: string | null; contactPerson?: string | null } = {};
    if (c.email !== undefined && c.email !== null && c.email !== existing.email) patch.email = c.email;
    if (c.contactPerson !== undefined && c.contactPerson !== null && c.contactPerson !== existing.contactPerson) patch.contactPerson = c.contactPerson;
    if (Object.keys(patch).length > 0) {
      await getTicketDb().customers.update({ where: { id: existing.id }, data: patch }).catch(() => {});
    }
    return existing.id;
  }
  const created = await getTicketDb().customers.create({
    data: { name: c.name, email: c.email ?? null, contactPerson: c.contactPerson ?? null },
    select: { id: true },
  });
  return created.id;
}

export function updateTicketRow(id: string, data: Parameters<typeof ticketPrisma.tickets.update>[0]['data']) {
  return getTicketDb().tickets.update({ where: { id }, data, select: { id: true } });
}

// Atomic claim (first-wins): assign only while still unassigned. A single guarded
// UPDATE means two concurrent claims can never double-assign — exactly one wins.
export async function claimTicket(id: string, assigneeId: string): Promise<boolean> {
  const res = await getTicketDb().tickets.updateMany({ where: { id, assigneeId: null }, data: { assigneeId } });
  return res.count === 1;
}

// New escalated tickets in the current store since `since` (admin notification
// source). Escalated snapshots carry the 'escalated' label. Excludes the viewer's own.
export async function listEscalationAlerts(since: string, excludeUserId: string): Promise<TicketDTO[]> {
  const rows = await getTicketDb().tickets.findMany({
    where: { createdAt: { gt: new Date(since) }, labels: { has: 'escalated' } },
    include: ticketInclude, orderBy: { createdAt: 'desc' }, take: 25,
  });
  const refs = await resolveTicketRefs(rows);
  return rows
    .map((r) => toTicketDTO(r, refs.projects.get(r.projectId) ?? null, person(refs.reporters.get(r.reporterId) ?? null)))
    .filter((t) => t.reporter?.id !== excludeUserId);
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

// ─── Slack-bot assignees ────────────────────────────────────────────────────────
// Bots participate in ticketing as bridged Users rows (like resolveTicketActor for
// humans), so a ticket can be assigned to a bot. They carry a reserved email domain
// so they can be recognised and kept out of the human staff pool. Additive upsert.
export const BOT_EMAIL_DOMAIN = '@slackbots.local';
export const botEmail = (slug: string) => `bot+${slug}${BOT_EMAIL_DOMAIN}`;

export async function resolveBotTicketUser(bot: { name: string; slug: string }): Promise<string> {
  const email = botEmail(bot.slug);
  const existing = await getTicketDb().users.findUnique({ where: { email }, select: { id: true } });
  if (existing) return existing.id;
  const row = await getTicketDb().users.create({
    data: { firstName: bot.name.slice(0, 255), lastName: '(bot)', email, password: '', role: 'developer', isActive: true },
    select: { id: true },
  });
  return row.id;
}

// Mirror a person into the CURRENT store by email — the same key the identity bridge
// uses, so a user who exists in both stores keeps one row per store. Used by the
// escalation mirror to attribute a mirrored comment to its real author even when that
// author has no B2B account behind them (staff created natively in the ticketing tool).
// The sentinel password can never match a bcrypt check, so this grants no login.
export async function getOrCreateUserByEmail(u: { email: string; firstName: string; lastName: string; role?: string }): Promise<string> {
  const email = u.email.toLowerCase();
  const existing = await getTicketDb().users.findUnique({ where: { email }, select: { id: true } });
  if (existing) return existing.id;
  const row = await getTicketDb().users.create({
    data: {
      email, firstName: u.firstName || 'User', lastName: u.lastName,
      password: '__sso_bridged__', role: (u.role ?? 'developer') as 'admin' | 'manager' | 'developer' | 'tester',
    },
    select: { id: true },
  });
  return row.id;
}

// ─── Staff (assignee pool) ─────────────────────────────────────────────────────
// Called with NO arguments from the org path: platform administrators (role 'admin')
// are excluded because they live in the isolated admin store and must not be
// assignable — or even enumerable/countable — from an org-level New Ticket form.
// `includeAdmins` is for the admin store only (listAdminAssignees), where the whole
// active roster IS the assignee pool; it must never be set on an org-scoped call.
export async function listStaff(opts?: { includeAdmins?: boolean }): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
  const rows = await getTicketDb().users.findMany({
    where: {
      isActive: true,
      ...(opts?.includeAdmins ? {} : { role: { not: 'admin' as const } }),
      NOT: { email: { endsWith: BOT_EMAIL_DOMAIN } },
    },
    select: { id: true, firstName: true, lastName: true, email: true, role: true },
    orderBy: [{ firstName: 'asc' }],
  });
  return rows.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email, role: u.role as string }));
}

// ─── Customers (client pool) ───────────────────────────────────────────────────
// The current store's client list, offered as the New Ticket form's client picker
// (ADMINISTRATOR only — see the route guard). Read-only: creating clients is not
// exposed here, so the externally-owned Customers rows are never added to by accident.
export async function listCustomers(): Promise<Array<{ id: string; name: string; email: string | null; contactPerson: string | null; company: string | null }>> {
  return getTicketDb().customers.findMany({
    select: { id: true, name: true, email: true, contactPerson: true, company: true },
    orderBy: { name: 'asc' },
  });
}

// Set the contact person on an existing client. Deliberately narrow (we already hold
// the id, unlike getOrCreateCustomerByName). Best-effort: a ticket must not fail to
// be created because the client row vanished between the picker load and submit.
export async function setCustomerContactPerson(id: string, contactPerson: string | null): Promise<void> {
  await getTicketDb().customers.update({ where: { id }, data: { contactPerson } }).catch(() => {});
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

// Updates on tickets the user reported (their notification feed) — status changes,
// (re)assignment, and new comments since `since`, excluding the user's own actions.
export interface TicketUpdateDTO { id: string; ticketId: string; ticketNumber: string; title: string; type: string; description: string | null; createdAt: string; }
export async function getMyTicketUpdates(actorId: string, since: string): Promise<TicketUpdateDTO[]> {
  const mine = await getTicketDb().tickets.findMany({ where: { reporterId: actorId }, select: { id: true, ticketNumber: true, title: true } });
  if (mine.length === 0) return [];
  const byId = new Map(mine.map((t) => [t.id, t] as const));
  const acts = await getTicketDb().activities.findMany({
    where: {
      ticketId: { in: [...byId.keys()] },
      createdAt: { gt: new Date(since) },
      userId: { not: actorId },
      type: { in: ['status_changed', 'assigned', 'commented'] },
    },
    orderBy: { createdAt: 'desc' }, take: 25,
  });
  return acts.map((a) => {
    const t = byId.get(a.ticketId)!;
    return { id: a.id, ticketId: a.ticketId, ticketNumber: t.ticketNumber, title: t.title, type: a.type as string, description: a.description, createdAt: a.createdAt.toISOString() };
  });
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
