import { PrismaClient } from '@prisma/ticket-client';

// Full Ticketing Platform database (TICKET_DATABASE_URL → b2b_ticket). Backs the
// rebuilt ticketing module: the 14-table schema (Users/Customers/Projects/Tickets/
// SLAs/Comments/Activities/…). Connection is lazy — we deliberately do NOT add a
// hard $connect() at server startup so a missing/unreachable ticket DB can never
// crash boot (see the earlier b2b_ticketing incident).

const globalForTicket = globalThis as unknown as { ticketPrisma?: PrismaClient };

export const ticketPrisma = globalForTicket.ticketPrisma ?? new PrismaClient({
  log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
});

if (process.env['NODE_ENV'] !== 'production') {
  globalForTicket.ticketPrisma = ticketPrisma;
}
