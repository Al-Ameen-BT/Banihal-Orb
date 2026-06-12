import { PrismaClient } from '@prisma/ticketing-client';

// Dedicated ticketing database (TICKETING_DATABASE_URL → b2b_ticketing).
// Backs the Ticketing Tool's fallback mode persistently (replaces the old
// in-memory store) until the external ticketing API is connected. Every query
// in ticketing.client.ts scopes by customerId explicitly.

const globalForTicketing = globalThis as unknown as { ticketingPrisma?: PrismaClient };

export const ticketingPrisma = globalForTicketing.ticketingPrisma ?? new PrismaClient({
  log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
});

if (process.env['NODE_ENV'] !== 'production') {
  globalForTicketing.ticketingPrisma = ticketingPrisma;
}
