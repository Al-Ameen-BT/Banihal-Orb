import fs from 'fs/promises';
import path from 'path';
import type { enum_Activities_type } from '@prisma/ticket-client';
import { ticketPrisma, getTicketDb } from '../../config/ticketDatabase';
import { UPLOAD_DIR } from './uploads';
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
    select: {
      id: true, status: true, priority: true, assigneeId: true, projectId: true,
      pausedTime: true, totalPausedTime: true,
      // title/description are here for the activity rows an edit writes — without an
      // old value there is nothing to record the change against.
      title: true, description: true,
      // reporterId identifies the ticket's creator — the ownership check for the
      // edit lock (creator + admins may edit; see service.updateTicket).
      reporterId: true,
    },
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

/** Name + ticket count, read BEFORE the delete — both are gone afterwards and both
 *  are needed: the name to check the typed confirmation against, the count for the
 *  audit row that becomes the only surviving record of what was destroyed. */
export async function getProjectForDelete(id: string) {
  const row = await getTicketDb().projects.findUnique({
    where: { id },
    select: { id: true, name: true, _count: { select: { Tickets: true } } },
  });
  return row ? { id: row.id, name: row.name, tickets: row._count.Tickets } : null;
}

/** Do any of this project's tickets have a copy in the OTHER store? Escalation joins
 *  the two by a `src:<ticketNumber>` label with no foreign key, so deleting this side
 *  orphans the copy permanently and silently — the same reason deleteTicket refuses. */
export function countEscalatedInProject(id: string) {
  return getTicketDb().tickets.count({ where: { projectId: id, labels: { has: 'escalated' } } });
}

/**
 * Delete a project AND every ticket under it.
 *
 * Tickets.projectId is NOT NULL, so the tickets cannot be orphaned — they go or the
 * project stays. Comments, comment attachments, ticket attachments, activities and
 * watchers all cascade in-database from the ticket delete (db/b2b_ticket.sql:196-257),
 * and ProjectMembers cascades from the project.
 *
 * FILES BEFORE ROWS, for the same reason as orgDeletion.service.ts: attachments are
 * random filenames in a flat directory whose only pointer is the row about to be
 * deleted. Delete the rows first and the bytes on disk are unreachable forever.
 */
export async function deleteProjectCascade(id: string): Promise<{ tickets: number; attachments: number }> {
  const db = getTicketDb();
  const tickets = await db.tickets.findMany({ where: { projectId: id }, select: { id: true } });
  const ticketIds = tickets.map((t) => t.id);

  let attachments = 0;
  if (ticketIds.length) {
    const files = [
      ...(await db.ticketAttachments.findMany({ where: { ticketId: { in: ticketIds } }, select: { filename: true } })),
      ...(await db.commentAttachments.findMany({ where: { Comments: { ticketId: { in: ticketIds } } }, select: { filename: true } })),
    ];
    // filename is nullable on both tables — a row without one has no file to unlink.
    const names = files.map((f) => f.filename).filter((n): n is string => !!n);
    attachments = names.length;
    await Promise.all(names.map((name) =>
      // Best-effort per file: a missing file must not abort the teardown, and
      // basename() keeps a crafted stored name from escaping UPLOAD_DIR.
      fs.unlink(path.join(UPLOAD_DIR, path.basename(name))).catch(() => {})));

    await db.tickets.deleteMany({ where: { id: { in: ticketIds } } });
  }

  await db.projects.delete({ where: { id } });
  return { tickets: ticketIds.length, attachments };
}

// ─── Ticket deletion ───────────────────────────────────────────────────────────

/** What a delete needs to know BEFORE the row is gone: the escalation check and the audit record. */
export function getTicketForDelete(id: string) {
  return getTicketDb().tickets.findUnique({
    where: { id },
    select: { id: true, ticketNumber: true, title: true, labels: true },
  });
}

/**
 * Every file belonging to a ticket — its own attachments plus those on its comments.
 * MUST be read before the rows are deleted: the cascade takes the filenames with it
 * and the bytes on disk then have nothing pointing at them (same reason
 * saas-admin/orgDeletion.service.ts collects names first).
 */
export async function getTicketAttachmentFilenames(ticketId: string): Promise<string[]> {
  const db = getTicketDb();
  const [own, onComments] = await Promise.all([
    db.ticketAttachments.findMany({ where: { ticketId }, select: { filename: true } }),
    db.commentAttachments.findMany({ where: { Comments: { ticketId } }, select: { filename: true } }),
  ]);
  // filename is nullable on both tables — a row without one has no file to unlink.
  return [...own, ...onComments].map((r) => r.filename).filter((n): n is string => !!n);
}

/** Comments, comment attachments, ticket attachments, activities and watchers all
 *  cascade from this one delete (db/b2b_ticket.sql:196-257) — do not remove them by hand. */
export async function deleteTicketRow(id: string): Promise<void> {
  await getTicketDb().tickets.delete({ where: { id } });
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
  const rows = await getTicketDb().activities.findMany({ where: { ticketId }, include: { Users: userSel }, orderBy: { createdAt: 'desc' } });
  return rows.map((a) => ({
    id: a.id, type: a.type as string, field: a.field, oldValue: a.oldValue, newValue: a.newValue,
    description: a.description, user: person(a.Users), createdAt: a.createdAt.toISOString(),
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
  const ticketWhere = {
    ...(f.scope ? { OR: [{ reporterId: { in: f.scope } }, { assigneeId: { in: f.scope } }] } : {}),
    ...(f.search ? {
      OR: [
        { ticketNumber: { contains: f.search, mode: 'insensitive' as const } },
        { title: { contains: f.search, mode: 'insensitive' as const } },
      ],
    } : {}),
  };

  const rows = await getTicketDb().activities.findMany({
    where: {
      ...(f.type ? { type: f.type } : {}),
      ...(f.ticketId ? { ticketId: f.ticketId } : {}),
      ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
      // An empty object here would be a no-op filter, so only attach it when it
      // actually constrains something — otherwise every row pays for a join.
      ...(Object.keys(ticketWhere).length ? { Tickets: ticketWhere } : {}),
    },
    include: { Users: userSel, Tickets: { select: { id: true, ticketNumber: true, title: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // One extra row is how we know whether a next page exists without a second
    // count(*) over a table this size.
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, f.limit);
  return {
    items: page.map((a) => ({
      id: a.id, type: a.type as string, field: a.field, oldValue: a.oldValue, newValue: a.newValue,
      description: a.description, user: person(a.Users), createdAt: a.createdAt.toISOString(),
      ticket: a.Tickets ? { id: a.Tickets.id, ticketNumber: a.Tickets.ticketNumber, title: a.Tickets.title } : null,
    })),
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

export async function dashboardFeed(): Promise<{ tickets: FeedTicket[]; projects: FeedProject[] }> {
  const db = getTicketDb();
  const [rows, projects] = await Promise.all([
    db.tickets.findMany({
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
    db.projects.findMany({ select: { id: true, status: true, endDate: true } }),
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
