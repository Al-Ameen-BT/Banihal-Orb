import type { enum_Activities_type } from '@prisma/ticket-client';
import { prisma } from '../../config/database';
import { runWithTicketDb, ticketPrisma, getTicketDb } from '../../config/ticketDatabase';
import { evaluateSla, evaluateResponseSla, convertToSeconds, type TimeUnit } from './services/slaService';
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
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
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

/**
 * The tenant filter, as one predicate.
 *
 * `scope` is what ticketAccessScope() returns: the ticket-store user ids whose tickets
 * the caller may see, or NULL for "the whole store" (an administrator inside the
 * isolated admin store, which is already a tenant boundary of its own).
 *
 * The shared client store b2b_ticket holds EVERY organization's tickets, so an
 * aggregate that omits this reads across all of them. Spread it into a `where`; do not
 * hand-roll the OR again at a new call site.
 */
export const scopedWhere = (scope: string[] | null) =>
  scope ? { OR: [{ reporterId: { in: scope } }, { assigneeId: { in: scope } }] } : {};

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
      ...(filters.customerIds?.length ? { customerId: { in: filters.customerIds } } : {}),
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
    select: {
      id: true, status: true, priority: true, assigneeId: true, projectId: true,
      pausedTime: true, totalPausedTime: true,
      // title/description are here for the activity rows an edit writes — without an
      // old value there is nothing to record the change against.
      title: true, description: true,
      // reporterId identifies the ticket's creator — the ownership check for the
      // edit lock (creator + admins may edit; see service.updateTicket).
      reporterId: true,
      // labels: the approval state machine (pending:org-admin / pending:approval)
      // keys off this label set.
      labels: true,
    },
  });
}

// Brief projection (id + number + title) used by mention delivery — deliberately
// minimal so it survives schema drift and costs nothing for a notification.
export function getTicketBrief(id: string) {
  return getTicketDb().tickets.findUnique({
    where: { id },
    select: { id: true, ticketNumber: true, title: true },
  });
}

// Name of a ticket-store user, used to label the notification actor when mentions
// are delivered from the shared client store (where the old admin-roster lookup
// no longer applies).
export async function getUserName(id: string): Promise<string | null> {
  const row = await getTicketDb().users.findUnique({
    where: { id },
    select: { firstName: true, lastName: true },
  });
  if (!row) return null;
  return `${row.firstName} ${row.lastName}`.trim();
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
type ActivityType = 'created' | 'updated' | 'commented' | 'status_changed' | 'priority_changed' | 'assigned' | 'attachment_added' | 'mentioned';
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
  const rows = await getTicketDb().projects.findMany({
    where: { deletedAt: null },
    include: projectInclude,
    orderBy: { createdAt: 'desc' },
  });
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

/** Name of the hidden bucket where a deleted project's tickets are kept. */
export const RETAINED_PROJECT_NAME = 'Retained tickets';

/** Name + ticket count + lead, read BEFORE the delete — the name to check the typed
 *  confirmation against, the count to know whether tickets must be relocated, and the
 *  lead to reuse for the retained bucket (a Projects row always needs a User). */
export async function getProjectForDelete(id: string) {
  const row = await getTicketDb().projects.findUnique({
    where: { id },
    select: { id: true, name: true, leadId: true, _count: { select: { Tickets: true } } },
  });
  return row ? { id: row.id, name: row.name, leadId: row.leadId, tickets: row._count.Tickets } : null;
}

/**
 * Find (or lazily create) the "Retained tickets" bucket in the CURRENT store. The
 * bucket is invisible everywhere: `deletedAt` is set at creation, and every project
 * list / dashboard feed filters it out, so deleting an arbitrary project never leaks
 * a user-visible "Retained tickets" card. It exists so tickets survive the deletion
 * of the project they were grouped under — tickets are compliance records and can
 * never be deleted, and summary counts keep seeing them because they are still rows.
 */
export async function getOrCreateRetainedProject(leadId: string): Promise<string> {
  const existing = await getTicketDb().projects.findFirst({
    where: { name: RETAINED_PROJECT_NAME },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await getTicketDb().projects.create({
    data: {
      name: RETAINED_PROJECT_NAME,
      description: 'Tickets kept when their project was deleted — compliance records that are never deleted.',
      status: 'archived',
      category: 'retained',
      type: 'other',
      priority: 'medium',
      leadId,
      deletedAt: new Date(),
    },
    select: { id: true },
  });
  return created.id;
}

/** Re-point every ticket of `fromProjectId` at `toProjectId`. Returns the moved count. */
export function moveProjectTickets(fromProjectId: string, toProjectId: string) {
  return getTicketDb().tickets.updateMany({
    where: { projectId: fromProjectId },
    data: { projectId: toProjectId },
  });
}

/** Attachment rows whose owning ticket lives in `projectId` (files were NOT deleted;
 *  relocation preserves them — this count is only for the audit record). */
export async function countProjectAttachments(projectId: string): Promise<number> {
  const db = getTicketDb();
  const ticketIds = (await db.tickets.findMany({ where: { projectId }, select: { id: true } })).map((t) => t.id);
  if (!ticketIds.length) return 0;
  const [t, c] = await Promise.all([
    db.ticketAttachments.count({ where: { ticketId: { in: ticketIds } } }),
    db.commentAttachments.count({ where: { Comments: { ticketId: { in: ticketIds } } } }),
  ]);
  return t + c;
}

/** Delete a (now GUARANTEED empty) project row. The caller has already relocated any
 *  tickets — Tickets.projectId is a NO-ACTION reference, so a project with tickets
 *  cannot be deleted at the database level either. */
export function deleteProjectRow(id: string) {
  return getTicketDb().projects.delete({ where: { id } });
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

// ─── Org-scoped assignee pool ─────────────────────────────────────────────────
// The shared ticket store holds bridged Users rows for EVERY organization that has
// ever acted in it — plus the platform's own staff. listStaff() above scans ALL of
// them, which is what let one org's New Ticket form offer another org's people as
// assignees (a cross-org data leak) and surfaced the platform team in client orgs.
//
// The ticket-store Users row carries NO org column, so the only correct scoping key
// is email: the caller's organization in the Application (main DB) is the source of
// truth for who belongs to them. An org may only ever assign tickets to its OWN
// staff — everyone else has no business being in the pool. Platform administrators
// (role 'admin') stay excluded exactly as listStaff excludes them: they live in the
// isolated admin store, not in a client org's roster.
export async function listOrgStaff(b2bCustomerId: string): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
  const orgUsers = await prisma.user.findMany({
    where: { customerId: b2bCustomerId },
    select: { id: true, email: true },
  });
  const emails = orgUsers.map((u) => u.email.toLowerCase()).filter(Boolean);
  if (!emails.length) return [];

  const rows = await getTicketDb().users.findMany({
    where: {
      isActive: true,
      email: { in: emails },
      role: { not: 'admin' as const },
      NOT: { email: { endsWith: BOT_EMAIL_DOMAIN } },
    },
    select: { id: true, firstName: true, lastName: true, email: true, role: true },
    orderBy: [{ firstName: 'asc' }],
  });
  return rows.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email, role: u.role as string }));
}

// When a B2B account is deleted the ticket stores keep the bridged Users row (it is
// the FK target of tickets they opened / were assigned / commented on, so it must
// survive for history). It must NOT stay assignable: listStaff/listOrgStaff gate on
// isActive — flip it in BOTH stores so a deleted platform/org member drops out of
// every assignee pool immediately.
export async function deactivateUserInTicketStores(email: string): Promise<void> {
  const lower = email.toLowerCase();
  await Promise.all([
    getTicketDb().users.updateMany({ where: { email: lower }, data: { isActive: false } }),
    runWithTicketDb('admin', () => getTicketDb().users.updateMany({ where: { email: lower }, data: { isActive: false } })),
  ]);
}

// ─── Customers (client pool) ───────────────────────────────────────────────────
// The current store's client list, offered as the New Ticket form's client picker
// and the Reports tab's filter (ADMINISTRATOR only — see the route guard). Read-only
// in spirit: creating clients is not exposed here, so the externally-owned Customers
// rows are never added to by accident.
//
// Verification against the Application (b2b_saas) directory: the main database's
// Customer is the source of truth for a client's name/contact. The admin ticketing
// DB's Customers rows were created from escalations / ticket creation and can go
// stale or DUPLICATE — the same mailbox entered under two names produces two rows,
// and the old dropdown showed both. This collapses rows sharing a normalized email
// into one option (the Application's details win) and best-effort reconciles the
// ticket-store rows they stood for.
export interface CustomerOption {
  id: string;               // primary Customers.id (new-ticket linking, default filter)
  ids: string[];            // every Customers.id sharing this email (expanded in reports)
  name: string;
  email: string | null;
  contactPerson: string | null;
  company: string | null;
  b2bCustomerId: string | null; // matching Application customer, when one was found
  verified: boolean;             // whether the option resolved to an Application customer
}

type StoreCustomerRow = { id: string; name: string; email: string | null; contactPerson: string | null; company: string | null };

export async function listCustomers(): Promise<CustomerOption[]> {
  const db = getTicketDb();
  const [store, app] = await Promise.all([
    db.customers.findMany({ select: { id: true, name: true, email: true, contactPerson: true, company: true } }),
    prisma.customer.findMany({ select: { id: true, name: true, mailId: true, contactPerson: true } }),
  ]);

  const emailKey = (e: string | null | undefined) => (e ? e.trim().toLowerCase() : '');
  const byId: Map<string, StoreCustomerRow> = new Map(store.map((c) => [c.id, c]));

  // Application directory keyed by mailId. Customer is a global model (no tenant
  // injection), so all organizations are read — this pool is Administrator-only.
  const appByEmail = new Map<string, { id: string; name: string; mailId: string; contactPerson: string }>();
  for (const a of app) {
    const k = emailKey(a.mailId);
    if (k && !appByEmail.has(k)) appByEmail.set(k, a);
  }

  const merged = new Map<string, CustomerOption>();
  const standalone: CustomerOption[] = [];

  for (const c of store) {
    const key = emailKey(c.email);
    if (!key) {
      standalone.push({ id: c.id, ids: [c.id], name: c.name, email: null, contactPerson: c.contactPerson, company: c.company, b2bCustomerId: null, verified: false });
      continue;
    }
    const appCustomer = appByEmail.get(key);
    const existing = merged.get(key);
    if (existing) {
      existing.ids.push(c.id);
      continue;
    }
    merged.set(key, {
      id: c.id,
      ids: [c.id],
      // The Application is the authority on what the client is called and how to
      // reach them; a ticket-store-only row keeps its own data, unverified.
      name: appCustomer?.name ?? c.name,
      email: appCustomer?.mailId ?? c.email,
      contactPerson: appCustomer?.contactPerson || c.contactPerson,
      company: c.company,
      b2bCustomerId: appCustomer?.id ?? null,
      verified: Boolean(appCustomer),
    });
  }

  // Verification pass: reconcile every merged row against the Application details so
  // a stale or twice-entered client converges on the official name/contact. Best
  // effort — one bad write must never take the list down.
  for (const opt of merged.values()) {
    if (!opt.verified) continue;
    for (const id of opt.ids) {
      const row = byId.get(id);
      if (!row) continue;
      const patch: { name?: string; email?: string; contactPerson?: string } = {};
      if (row.name !== opt.name) patch.name = opt.name;
      if (opt.email && row.email !== opt.email) patch.email = opt.email;
      if (opt.contactPerson && row.contactPerson !== opt.contactPerson) patch.contactPerson = opt.contactPerson;
      if (Object.keys(patch).length > 0) {
        await db.customers.update({ where: { id }, data: patch }).catch(() => {});
      }
    }
  }

  return [...merged.values(), ...standalone].sort((a, b) => a.name.localeCompare(b.name));
}

// Set the contact person on an existing client. Deliberately narrow (we already hold
// the id, unlike getOrCreateCustomerByName). Best-effort: a ticket must not fail to
// be created because the client row vanished between the picker load and submit.
export async function setCustomerContactPerson(id: string, contactPerson: string | null): Promise<void> {
  await getTicketDb().customers.update({ where: { id }, data: { contactPerson } }).catch(() => {});
}

// Set the email on an existing client. Best-effort for the same reason as above.
export async function setCustomerEmail(id: string, email: string | null): Promise<void> {
  await getTicketDb().customers.update({ where: { id }, data: { email } }).catch(() => {});
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
export async function getAttachmentFile(id: string): Promise<{ filename: string | null; path: string | null; originalName: string | null; mimeType: string | null } | null> {
  // `filename` is the random basename inside UPLOAD_DIR; the download handler
  // serves by that under a fixed root rather than trusting the absolute `path`.
  const sel = { filename: true, path: true, originalName: true, mimeType: true } as const;
  const t = await getTicketDb().ticketAttachments.findUnique({ where: { id }, select: sel });
  if (t) return t;
  return getTicketDb().commentAttachments.findUnique({ where: { id }, select: sel });
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
  const db = getTicketDb();
  const rows = await db.activities.findMany({
    where: { ticketId },
    // Users is required, but the admin store (legacy import) can hold an activity row
    // whose user no longer exists — a required-relation `include` would throw and 500
    // the drawer. Batch-load and tolerate gaps, like the cross-ticket feed.
    select: { id: true, type: true, field: true, oldValue: true, newValue: true, description: true, userId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  const users = await db.users.findMany({ where: { id: { in: [...new Set(rows.map((a) => a.userId))] } }, ...userSel });
  const userById = new Map(users.map((u) => [u.id, u]));
  return rows.map((a) => ({
    id: a.id, type: a.type as string, field: a.field, oldValue: a.oldValue, newValue: a.newValue,
    description: a.description, user: person(userById.get(a.userId) ?? null), createdAt: a.createdAt.toISOString(),
  }));
}

// ─── Activity log feed ─────────────────────────────────────────────────────────
// The same Activities rows listActivities returns per ticket, read the other way
// round: the whole store ordered by time. Backs the ticketing Activity Log tab.
//
// Reads the CURRENT store only, like every other ticketing query — an ADMINISTRATOR
// sees b2b_ticketing_admin and an ORG_ADMIN sees b2b_ticket. The two are separate
// databases with no join, so there is nothing to merge and nothing that could leak
// across by accident.
export interface ActivityFeedFilters {
  /** The generated enum, not a string: a value ActivityFeedSchema forgot to allow is
   *  then a compile error rather than a silent zero-row filter. */
  type?: enum_Activities_type;
  ticketId?: string;
  from?: Date;
  to?: Date;
  search?: string;
  limit: number;
  cursor?: string;
  /** From ticketAccessScope(): the ticket-store user ids whose tickets the caller may
   *  see, or null for "the whole store" (an administrator in the isolated admin one).
   *  Passed in rather than derived here so this stays the same guard assertTicketAccess
   *  applies per ticket — an ORG_ADMIN must never read the other organizations sharing
   *  b2b_ticket. */
  scope: string[] | null;
}

export interface ActivityFeedRow extends ActivityDTO {
  ticket: { id: string; ticketNumber: string; title: string } | null;
}

export async function listActivityFeed(f: ActivityFeedFilters): Promise<{ items: ActivityFeedRow[]; nextCursor: string | null }> {
  const db = getTicketDb();
  const ticketWhere = {
    ...(f.scope ? { OR: [{ reporterId: { in: f.scope } }, { assigneeId: { in: f.scope } }] } : {}),
    ...(f.search ? {
      OR: [
        { ticketNumber: { contains: f.search, mode: 'insensitive' as const } },
        { title: { contains: f.search, mode: 'insensitive' as const } },
      ],
    } : {}),
  };

  const rows = await db.activities.findMany({
    where: {
      ...(f.type ? { type: f.type } : {}),
      ...(f.ticketId ? { ticketId: f.ticketId } : {}),
      ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
      // An empty object here would be a no-op filter, so only attach it when it
      // actually constrains something — otherwise every row pays for a join.
      ...(Object.keys(ticketWhere).length ? { Tickets: ticketWhere } : {}),
    },
    // The required Users/Tickets relations are deliberately NOT `include`d: the
    // admin store (a legacy import) can hold activity rows whose user or ticket no
    // longer exists, and a required-relation `include` then makes Prisma throw
    // "Inconsistent query result … got null" — the Activity Log's 500 at UAT. Both
    // are batch-loaded on the page below and gaps tolerated, like resolveTicketRefs.
    select: {
      id: true, type: true, field: true, oldValue: true, newValue: true, description: true,
      userId: true, ticketId: true, createdAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // One extra row is how we know whether a next page exists without a second
    // count(*) over a table this size.
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, f.limit);
  const [tickets, users] = await Promise.all([
    db.tickets.findMany({
      where: { id: { in: [...new Set(page.map((a) => a.ticketId))] } },
      select: { id: true, ticketNumber: true, title: true },
    }),
    db.users.findMany({ where: { id: { in: [...new Set(page.map((a) => a.userId))] } }, ...userSel }),
  ]);
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const userById = new Map(users.map((u) => [u.id, u]));

  return {
    items: page.map((a) => {
      const ticket = ticketById.get(a.ticketId);
      return {
        id: a.id, type: a.type as string, field: a.field, oldValue: a.oldValue, newValue: a.newValue,
        description: a.description, user: person(userById.get(a.userId) ?? null), createdAt: a.createdAt.toISOString(),
        ticket: ticket ? { id: ticket.id, ticketNumber: ticket.ticketNumber, title: ticket.title } : null,
      };
    }),
    nextCursor: rows.length > f.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
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
// `scope` is NOT optional with a default: this used to read the whole table with no
// filter, so every caller was silently aggregating every organization in the shared
// store. Making it a required argument is what forces each call site to have decided.
export async function allTicketsForStats(scope: string[] | null) {
  const rows = await getTicketDb().tickets.findMany({
    where: scopedWhere(scope),
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

// ─── Report source ───────────────────────────────────────────────────────────
// Per-ticket rows for the Reports tab. Distinct from allTicketsForStats (which has
// neither customer nor SLA fields) and from dashboardFeed (which has no filters and
// no cap) — the report has to filter by date range and client, and a wide range over
// a big store must not load the whole table.
//
// Everything the exported spreadsheet can show is selected here, because the FIELD
// PICKER IS CLIENT-SIDE: the server returns the full row and the browser chooses
// columns, so re-picking fields costs no refetch.
export interface ReportTicketRow {
  id: string; ticketNumber: string; title: string;
  status: string; priority: string; type: string;
  projectName: string | null;
  customerId: string | null; customerName: string | null;
  assigneeId: string | null; assigneeName: string | null;
  reporterName: string | null; reporterEmail: string | null;
  branch: string | null; onSiteSupportRequired: boolean; labels: string[];
  createdAt: string; updatedAt: string; dueDate: string | null;
  pausedTime: string | null; totalPausedTime: number;
  resolvedAt: string | null;
  /** Effective seconds from createdAt to resolvedAt, minus accumulated paused time. Null while open. */
  resolutionSeconds: number | null;
  slaName: string | null; slaResolutionSeconds: number | null;
}

export interface ReportFilters {
  from?: Date; to?: Date;
  // The client picker is deduplicated by email (see listCustomers), so one option
  // stands for several merged Customers rows — the filter must match ALL of them,
  // or a report on a deduped client silently drops the merged names' tickets.
  customerIds?: string[];
  assigneeId?: string;
}

/** Hard ceiling on a single report. A range wide enough to exceed this returns a
 *  `truncated` flag rather than quietly reporting on part of the period. */
export const REPORT_ROW_CAP = 5000;

export async function listReportTickets(
  f: ReportFilters,
  scope: string[] | null,
): Promise<{ rows: ReportTicketRow[]; truncated: boolean }> {
  const db = getTicketDb();
  const rows = await db.tickets.findMany({
    where: {
      ...scopedWhere(scope),
      ...(f.customerIds?.length ? { customerId: { in: f.customerIds } } : {}),
      ...(f.assigneeId ? { assigneeId: f.assigneeId } : {}),
      // Range pushed into SQL, not filtered in JS after loading the table.
      ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
    },
    select: {
      id: true, ticketNumber: true, title: true, status: true, priority: true, type: true,
      projectId: true, customerId: true, assigneeId: true, reporterId: true,
      branch: true, onSiteSupportRequired: true, labels: true,
createdAt: true, updatedAt: true, dueDate: true, pausedTime: true, totalPausedTime: true, resolvedAt: true,
      Users_Tickets_assigneeIdToUsers: userSel,
      Customers: { select: { name: true } },
      SLAs: { select: { name: true, resolutionTime: true, timeUnit: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: REPORT_ROW_CAP + 1,
  });

  const page = rows.slice(0, REPORT_ROW_CAP);
  // Projects and reporters are required relations the admin store can orphan, so both
  // are batch-loaded and missing rows tolerated rather than `include`d (see ticketInclude).
  const [projects, reporters] = await Promise.all([
    db.projects.findMany({ where: { id: { in: [...new Set(page.map((r) => r.projectId))] } }, select: { id: true, name: true } }),
    db.users.findMany({ where: { id: { in: [...new Set(page.map((r) => r.reporterId))] } }, ...userSel }),
  ]);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const reporterById = new Map(reporters.map((u) => [u.id, u]));

  return {
    rows: page.map((r) => {
      const a = r.Users_Tickets_assigneeIdToUsers;
      const rep = reporterById.get(r.reporterId) ?? null;
      return {
        id: r.id, ticketNumber: r.ticketNumber, title: r.title,
        status: r.status, priority: r.priority, type: r.type,
        projectName: projectById.get(r.projectId)?.name ?? null,
        customerId: r.customerId, customerName: r.Customers?.name ?? null,
        assigneeId: r.assigneeId, assigneeName: a ? `${a.firstName} ${a.lastName}`.trim() : null,
        reporterName: rep ? `${rep.firstName} ${rep.lastName}`.trim() : null,
        reporterEmail: rep?.email ?? null,
        branch: r.branch, onSiteSupportRequired: r.onSiteSupportRequired, labels: r.labels,
        createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
        dueDate: r.dueDate?.toISOString() ?? null,
        pausedTime: r.pausedTime?.toISOString() ?? null, totalPausedTime: r.totalPausedTime,
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolutionSeconds: r.resolvedAt
          ? Math.max(0, (r.resolvedAt.getTime() - r.createdAt.getTime()) / 1000 - (r.totalPausedTime ?? 0))
          : null,
        slaName: r.SLAs?.name ?? null,
        slaResolutionSeconds: r.SLAs ? convertToSeconds(r.SLAs.resolutionTime, r.SLAs.timeUnit as TimeUnit) : null,
      };
    }),
    truncated: rows.length > REPORT_ROW_CAP,
  };
}

// ─── Dashboard feed ──────────────────────────────────────────────────────────
// The whole ticket estate in the flat shape services/dashboardAggregate consumes.
// It owns every panel's arithmetic; this side only supplies rows, so adding a panel
// never means adding a query here. Names are denormalised (assignee/reporter/customer)
// because the aggregator groups by them and cannot follow a relation.
export interface FeedTicket {
  id: string; ticketNumber: string; title: string; status: string; priority: string;
  branch: string | null; projectId: string;
  assigneeId: string | null; assigneeName: string | null;
  reporterId: string | null; reporterName: string | null; reporterEmail: string | null;
  customerId: string | null; customerName: string | null;
  createdAt: string; updatedAt: string;
  pausedTime: string | null; totalPausedTime: number;
  slaResolutionSeconds: number | null;
}
export interface FeedProject { id: string; status: string; endDate: string | null }

// `scope` as above: required, because an unscoped feed aggregates every organization
// sharing b2b_ticket. Projects are deliberately NOT scoped — they are shared across
// organizations and carry no owner column (see orgDeletion.service.ts).
export async function dashboardFeed(scope: string[] | null): Promise<{ tickets: FeedTicket[]; projects: FeedProject[] }> {
  const db = getTicketDb();
  const [rows, projects] = await Promise.all([
    db.tickets.findMany({
      where: scopedWhere(scope),
      select: {
        id: true, ticketNumber: true, title: true, status: true, priority: true,
        branch: true, projectId: true, assigneeId: true, reporterId: true, customerId: true,
        createdAt: true, updatedAt: true, pausedTime: true, totalPausedTime: true,
        Users_Tickets_assigneeIdToUsers: userSel,
        Customers: { select: { name: true } },
        SLAs: { select: { resolutionTime: true, timeUnit: true } },
      },
      // The "recent activity" panel just takes the first 8 rows, so the ordering is
      // part of this contract, not a convenience.
      orderBy: { createdAt: 'desc' },
    }),
    db.projects.findMany({ where: { deletedAt: null }, select: { id: true, status: true, endDate: true } }),
  ]);

  // Reporters are a required relation the admin store can orphan (see ticketInclude),
  // so they are batch-loaded and missing rows tolerated rather than `include`d.
  const reporters = await db.users.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.reporterId))] } },
    ...userSel,
  });
  const byId = new Map(reporters.map((u) => [u.id, u]));

  return {
    tickets: rows.map((r) => {
      const rep = byId.get(r.reporterId) ?? null;
      const a = r.Users_Tickets_assigneeIdToUsers;
      return {
        id: r.id, ticketNumber: r.ticketNumber, title: r.title, status: r.status, priority: r.priority,
        branch: r.branch, projectId: r.projectId,
        assigneeId: r.assigneeId, assigneeName: a ? `${a.firstName} ${a.lastName}`.trim() : null,
        reporterId: r.reporterId, reporterName: rep ? `${rep.firstName} ${rep.lastName}`.trim() : null,
        reporterEmail: rep?.email ?? null,
        customerId: r.customerId, customerName: r.Customers?.name ?? null,
        createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
        pausedTime: r.pausedTime?.toISOString() ?? null, totalPausedTime: r.totalPausedTime,
        slaResolutionSeconds: r.SLAs
          ? convertToSeconds(r.SLAs.resolutionTime, r.SLAs.timeUnit as TimeUnit)
          : null,
      };
    }),
    projects: projects.map((p) => ({ id: p.id, status: p.status, endDate: p.endDate?.toISOString() ?? null })),
  };
}
