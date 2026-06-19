import { PrismaClient } from '@prisma/ticketing-client';
import { env } from './env';

// Dedicated ticketing database for the platform ADMINISTRATOR role
// (ADMIN_TICKETING_DATABASE_URL). It reuses the SAME Prisma schema as the
// org/user ticketing client (Ticket/Project) but points at a different physical
// database via a datasource override, so the provider's administrators keep an
// isolated ticket store. When ADMIN_TICKETING_DATABASE_URL is not configured we
// fall back to the shared TICKETING_DATABASE_URL — so environments that haven't
// set it keep working (no separate store, no boot failure).

const adminUrl = env.ADMIN_TICKETING_DATABASE_URL ?? env.TICKETING_DATABASE_URL;

const globalForAdminTicketing = globalThis as unknown as { adminTicketingPrisma?: PrismaClient };

export const adminTicketingPrisma = globalForAdminTicketing.adminTicketingPrisma ?? new PrismaClient({
  datasourceUrl: adminUrl,
  log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
});

// True when administrators actually have a separate store configured (vs falling
// back to the shared ticketing DB).
export const adminTicketingIsolated = Boolean(env.ADMIN_TICKETING_DATABASE_URL);

if (process.env['NODE_ENV'] !== 'production') {
  globalForAdminTicketing.adminTicketingPrisma = adminTicketingPrisma;
}
