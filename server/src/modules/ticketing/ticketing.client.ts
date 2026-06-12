import crypto from 'crypto';
import { env } from '../../config/env';
import { ticketingPrisma } from '../../config/ticketingDatabase';
import type { Ticket as DbTicket, Project as DbProject } from '@prisma/ticketing-client';
import type {
  Ticket, Project, TicketFilters,
  CreateTicketInput, UpdateTicketInput, CreateProjectInput,
  TicketStatus, TicketPriority,
} from './ticketing.types';

/**
 * Ticketing data client — the single integration boundary with the external
 * Ticketing system (the API the customer will provide).
 *
 * Mode is decided by TICKETING_API_URL:
 *   • unset  → FALLBACK MODE: the dedicated ticketing database (b2b_ticketing,
 *     see prisma/ticketing.prisma) backs the tool. Each organization is
 *     lazy-seeded with realistic IT tickets on first access; everything
 *     persists across server restarts. Rows link to the main DB via customerId.
 *   • set    → EXTERNAL MODE: every function below must call the real API.
 *     The `externalNotConfigured` stubs throw until the provider's spec
 *     (endpoints, auth, payloads, org→client mapping) is filled in. ◄── TODO
 */

export function usingFallback(): boolean {
  return !env.TICKETING_API_URL;
}

// ─────────────────────────────────────────────────────────────────────────────
// DTO mapping (DB rows → UI-facing shapes; dates as ISO strings)
// ─────────────────────────────────────────────────────────────────────────────

function toTicket(row: DbTicket): Ticket {
  return {
    id: row.id,
    subject: row.subject,
    description: row.description,
    issueType: row.issueType,
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    projectId: row.projectId,
    assignee: row.assignee,
    raisedBy: row.raisedByEmail ? { name: row.raisedByName ?? 'Unknown', email: row.raisedByEmail } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

function toProject(row: DbProject): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    priority: row.priority as TicketPriority,
    assignees: row.assignees,
    createdAt: row.createdAt.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK MODE — lazy per-organization seeding (deterministic, idempotent)
// ─────────────────────────────────────────────────────────────────────────────

const ISSUE_TYPES = [
  'Printer issue', 'Password reset', 'AD account lockout', 'Proxy / site whitelist',
  'VPN connectivity', 'Outlook sync', 'Vulnerability detected', 'Hardware request',
];
const SAMPLE_USERS = [
  { name: 'Field Engineer', email: 'engineer@org.local' },
  { name: 'Branch Office', email: 'branch@org.local' },
  { name: 'Operations Desk', email: 'ops@org.local' },
];
const STATUS_WEIGHTS: TicketStatus[] = [
  'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED',
  'IN_PROGRESS', 'TODO', 'TODO',
];
const PRIORITIES: TicketPriority[] = ['LOW', 'MEDIUM', 'MEDIUM', 'MEDIUM', 'HIGH', 'HIGH', 'CRITICAL'];

// Deterministic PRNG per org so seed data (incl. ids) is stable and re-seeding
// is idempotent via skipDuplicates.
function mulberry32(seedStr: string): () => number {
  let a = parseInt(crypto.createHash('md5').update(seedStr).digest('hex').slice(0, 8), 16);
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seededOrgs = new Set<string>();

async function ensureSeeded(customerId: string): Promise<void> {
  if (seededOrgs.has(customerId)) return;
  const existing = await ticketingPrisma.ticket.count({ where: { customerId } });
  if (existing > 0) { seededOrgs.add(customerId); return; }

  const rnd = mulberry32(customerId);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const now = Date.now();
  const suffix = customerId.slice(-6);

  const projects = [
    {
      id: `prj-${suffix}-1`, customerId, name: 'Support',
      description: 'Day-to-day IT support calls', category: 'other',
      priority: 'MEDIUM' as const, assignees: ['IT Helpdesk', 'Network Team', 'Desktop Support'],
      createdAt: new Date(now - 60 * 86400_000),
    },
    {
      id: `prj-${suffix}-2`, customerId, name: 'Infrastructure Upgrade',
      description: 'Workstation and network refresh programme', category: 'software',
      priority: 'MEDIUM' as const, assignees: [] as string[],
      createdAt: new Date(now - 30 * 86400_000),
    },
  ];

  const tickets = Array.from({ length: 34 }).map((_, i) => {
    const created = now - Math.floor(rnd() * 30) * 86400_000 - Math.floor(rnd() * 86400_000);
    const status = pick(STATUS_WEIGHTS);
    const issueType = pick(ISSUE_TYPES);
    const raisedBy = pick(SAMPLE_USERS);
    const completed = status === 'COMPLETED' ? created + Math.floor(rnd() * 3 * 86400_000) : null;
    return {
      id: `tkt-${suffix}-${i + 1}`,
      customerId,
      subject: `${issueType} — reported by user`,
      description: `Auto-seeded fallback ticket for "${issueType}". Replace with live data once the external ticketing API is connected.`,
      issueType,
      status,
      priority: pick(PRIORITIES),
      projectId: rnd() > 0.4 ? projects[0]!.id : projects[1]!.id,
      assignee: status === 'TODO' ? null : pick(['IT Helpdesk', 'Network Team', 'Desktop Support']),
      raisedByName: raisedBy.name,
      raisedByEmail: raisedBy.email,
      createdAt: new Date(created),
      updatedAt: new Date(completed ?? created),
      completedAt: completed ? new Date(completed) : null,
    };
  });

  await ticketingPrisma.project.createMany({ data: projects, skipDuplicates: true });
  await ticketingPrisma.ticket.createMany({ data: tickets, skipDuplicates: true });
  seededOrgs.add(customerId);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTERNAL MODE — fill in when the provider's API spec is supplied  ◄── TODO
// ─────────────────────────────────────────────────────────────────────────────

function externalNotConfigured(): never {
  throw Object.assign(
    new Error('External ticketing API integration is not implemented yet — awaiting the provider API specification.'),
    { status: 503, code: 'TICKETING_API_PENDING' },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public client API (UI-facing shapes; mode-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

export async function listTickets(customerId: string, filters: TicketFilters = {}): Promise<Ticket[]> {
  if (!usingFallback()) return externalNotConfigured();
  await ensureSeeded(customerId);

  const rows = await ticketingPrisma.ticket.findMany({
    where: {
      customerId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.mine ? { raisedByEmail: filters.mine } : {}),
      ...(filters.since ? { createdAt: { gt: new Date(filters.since) } } : {}),
      ...(filters.search ? {
        OR: [
          { subject: { contains: filters.search, mode: 'insensitive' as const } },
          { issueType: { contains: filters.search, mode: 'insensitive' as const } },
        ],
      } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  return rows.map(toTicket);
}

export async function createTicket(customerId: string, input: CreateTicketInput): Promise<Ticket> {
  if (!usingFallback()) return externalNotConfigured();
  await ensureSeeded(customerId);

  const row = await ticketingPrisma.ticket.create({
    data: {
      id: `tkt-${crypto.randomBytes(4).toString('hex')}`,
      customerId,
      subject: input.subject,
      description: input.description,
      issueType: input.issueType,
      priority: input.priority,
      projectId: input.projectId ?? null,
      raisedByName: input.raisedBy.name,
      raisedByEmail: input.raisedBy.email,
    },
  });
  return toTicket(row);
}

export async function updateTicket(customerId: string, ticketId: string, input: UpdateTicketInput): Promise<Ticket> {
  if (!usingFallback()) return externalNotConfigured();

  const existing = await ticketingPrisma.ticket.findFirst({ where: { id: ticketId, customerId } });
  if (!existing) throw Object.assign(new Error('Ticket not found'), { status: 404, code: 'NOT_FOUND' });

  const row = await ticketingPrisma.ticket.update({
    where: { id: ticketId },
    data: {
      ...(input.status !== undefined ? {
        status: input.status,
        completedAt: input.status === 'COMPLETED' ? new Date() : null,
      } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    },
  });
  return toTicket(row);
}

export async function listProjects(customerId: string): Promise<Project[]> {
  if (!usingFallback()) return externalNotConfigured();
  await ensureSeeded(customerId);

  const rows = await ticketingPrisma.project.findMany({
    where: { customerId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toProject);
}

export async function createProject(customerId: string, input: CreateProjectInput): Promise<Project> {
  if (!usingFallback()) return externalNotConfigured();

  const row = await ticketingPrisma.project.create({
    data: {
      id: `prj-${crypto.randomBytes(4).toString('hex')}`,
      customerId,
      name: input.name,
      description: input.description,
      category: input.category,
      priority: input.priority,
      assignees: input.assignees,
    },
  });
  return toProject(row);
}

export async function deleteProject(customerId: string, projectId: string): Promise<void> {
  if (!usingFallback()) return externalNotConfigured();

  const existing = await ticketingPrisma.project.findFirst({ where: { id: projectId, customerId } });
  if (!existing) throw Object.assign(new Error('Project not found'), { status: 404, code: 'NOT_FOUND' });

  // Tickets keep living, just unassigned from the project (relation is SetNull,
  // but be explicit so behavior is identical if the relation ever changes).
  await ticketingPrisma.ticket.updateMany({ where: { projectId, customerId }, data: { projectId: null } });
  await ticketingPrisma.project.delete({ where: { id: projectId } });
}
