import { Request } from 'express';
import { prisma } from '../../config/database';
import { getTicketDb, runWithTicketDb } from '../../config/ticketDatabase';

// ─── External key cross-tenant guard ─────────────────────────────────────────
// A default-store key is scoped to a set of orgs (main-database customerIds in
// `req.external.orgs`). Tickets live in a DIFFERENT database and only hold their
// client as a loose Customers row (name/email), so resolving a ticket's owning
// org needs a few join keys. Admin-store requests have no org axis (that store
// is platform-internal) and skip the checks entirely.

const forbidden = (msg: string, code: string) => Object.assign(new Error(msg), { status: 403, code });
const notFound = (msg: string) => Object.assign(new Error(msg), { status: 404, code: 'NOT_FOUND' });

/** Run `fn` against the store bound to the calling key (default | admin). */
export function runExternalStore<T>(req: Request, fn: () => T): T {
  return runWithTicketDb(req.external!.store, fn);
}

async function keyCreatorOrg(req: Request): Promise<string | null> {
  const key = await prisma.externalApiKey.findUnique({
    where: { id: req.external!.keyId },
    select: { createdBy: { select: { customerId: true } } },
  });
  return key?.createdBy?.customerId ?? null;
}

/** Store Customers ids the key may see. `undefined` (admin store) = no filter. */
export async function allowedCustomerIds(req: Request): Promise<string[] | undefined> {
  const external = req.external!;
  if (external.store === 'admin') return undefined;
  const orgs = external.orgs;
  if (!orgs.length) return [];
  const orgRows = await prisma.customer.findMany({ where: { id: { in: orgs } }, select: { mailId: true } });
  const emails = [...new Set(orgRows.map((o) => o.mailId).filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase()))];
  if (!emails.length) return [];
  const customers = await getTicketDb().customers.findMany({ where: { email: { in: emails } }, select: { id: true } });
  return customers.map((c) => c.id);
}

/** Owning org (main-DB customerId) of a ticket, or null when unresolvable. */
export async function resolveTicketOrg(ticketId: string): Promise<string | null> {
  // 1. Bot-created tickets record their org directly (main DB, no email pivot).
  const sub = await prisma.botTicketSubmission.findFirst({ where: { ticketId }, select: { customerId: true } }).catch(() => null);
  if (sub?.customerId) return sub.customerId;

  // 2. The ticket's linked client → org by email.
  const ticket = await getTicketDb().tickets.findUnique({
    where: { id: ticketId },
    select: { customerId: true, reporterId: true },
  });
  if (!ticket) return null;
  if (ticket.customerId) {
    const c = await getTicketDb().customers.findUnique({ where: { id: ticket.customerId }, select: { email: true } });
    if (c?.email) {
      const org = await prisma.customer.findFirst({ where: { mailId: { equals: c.email, mode: 'insensitive' } }, select: { id: true } });
      if (org) return org.id;
    }
  }
  // 3. The reporter's platform account → its org.
  if (ticket.reporterId) {
    const user = await getTicketDb().users.findUnique({ where: { id: ticket.reporterId }, select: { email: true } });
    if (user?.email) {
      const platformUser = await prisma.user.findFirst({ where: { email: { equals: user.email, mode: 'insensitive' } }, select: { customerId: true } });
      if (platformUser?.customerId) return platformUser.customerId;
    }
  }
  return null;
}

/**
 * A cross-tenant ticket must not even be *revealed*: 404, not 403.
 * Admin-store keys skip the org axis entirely.
 */
export async function assertTicketInScope(req: Request, ticketId: string): Promise<void> {
  if (req.external!.store === 'admin') return;
  const org = await resolveTicketOrg(ticketId);
  if (!org || !req.external!.orgs.includes(org)) throw notFound('Ticket');
}

/** The ticket-store persona the key acts as (assignee, else reporter). */
export async function ticketActor(ticketId: string): Promise<string> {
  const core = await getTicketDb().tickets.findUnique({
    where: { id: ticketId },
    select: { assigneeId: true, reporterId: true },
  });
  if (core?.assigneeId) return core.assigneeId;
  if (core?.reporterId) return core.reporterId;
  throw forbidden('Ticket has no machine actor', 'TICKET_NO_PERSONA');
}

/** org the audit row belongs to: the ticket's org (default store) or the key issuer's. */
export function orgForAudit(req: Request, fallbackOrg?: string): Promise<string | null> {
  return req.external!.store === 'default'
    ? Promise.resolve(fallbackOrg ?? null)
    : keyCreatorOrg(req);
}