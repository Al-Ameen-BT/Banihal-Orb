import { PrismaClient } from '@prisma/ticket-client';
import { AsyncLocalStorage } from 'async_hooks';
import { env } from './env';

// Full Ticketing Platform database (TICKET_DATABASE_URL → b2b_ticket, 14-table
// schema). Backs the ticketing module for USER / ORG_ADMIN. Connection is lazy —
// we deliberately do NOT $connect() at boot so a missing/unreachable ticket DB
// can never crash startup (see the earlier b2b_ticketing incident).

const globalForTicket = globalThis as unknown as {
  ticketPrisma?: PrismaClient;
  adminTicketPrisma?: PrismaClient;
};

export const ticketPrisma = globalForTicket.ticketPrisma ?? new PrismaClient({
  log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
});

// Platform ADMINISTRATOR ticketing store — the SAME 14-table ticket-client schema,
// pointed at ADMIN_TICKETING_DATABASE_URL (b2b_ticketing_admin, which already holds
// the full schema + data) via a datasource override. Falls back to the shared
// b2b_ticket when the admin URL is unset, so environments without a separate admin
// store keep working (administrators simply share the main store).
export const adminTicketPrisma = globalForTicket.adminTicketPrisma ?? new PrismaClient({
  ...(env.ADMIN_TICKETING_DATABASE_URL ? { datasourceUrl: env.ADMIN_TICKETING_DATABASE_URL } : {}),
  log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
});

if (process.env['NODE_ENV'] !== 'production') {
  globalForTicket.ticketPrisma = ticketPrisma;
  globalForTicket.adminTicketPrisma = adminTicketPrisma;
}

// ─── Role-scoped client selection ────────────────────────────────────────────
// The ticketing module runs each request inside a scope derived from the caller's
// platform role (set by the middleware in ticketing.routes.ts). ADMINISTRATOR
// requests operate on the isolated admin store; everyone else on the shared
// b2b_ticket store. Outside a request (jobs/tests) it defaults to the shared store.
export type TicketDbScope = 'default' | 'admin';
const ticketDbContext = new AsyncLocalStorage<TicketDbScope>();

export function runWithTicketDb<T>(scope: TicketDbScope, fn: () => T): T {
  return ticketDbContext.run(scope, fn);
}
export function getTicketDbScope(): TicketDbScope {
  return ticketDbContext.getStore() ?? 'default';
}
export function getTicketDb(): PrismaClient {
  return getTicketDbScope() === 'admin' ? adminTicketPrisma : ticketPrisma;
}
