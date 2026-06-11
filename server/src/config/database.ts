import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';

export const customerContext = new AsyncLocalStorage<{ customerId: string }>();

const globalForPrisma = globalThis as unknown as { prisma: ReturnType<typeof buildPrisma> };

function buildPrisma() {
  const base = new PrismaClient({
    log: process.env['NODE_ENV'] === 'development' ? ['query', 'warn', 'error'] : ['error'],
  });

  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query, model, operation }: {
          args: Record<string, unknown>;
          query: (args: Record<string, unknown>) => Promise<unknown>;
          model: string;
          operation: string;
        }) {
          const store = customerContext.getStore();

          // Only inject on data-reading/mutating ops; skip raw/aggregate where clause injection isn't applicable
          const scopedOps = ['findFirst', 'findMany', 'findUnique', 'update', 'updateMany', 'delete', 'deleteMany', 'count'];

          // Models without customerId (global tables or tables without customerId relation).
          // Announcement is global because customerId:null means "all orgs" — auto-injecting
          // the tenant filter would hide those rows; the service scopes visibility manually.
          const globalModels = ['FeatureFlag', 'Customer', 'RefreshToken', 'Announcement'];

          if (store?.customerId && scopedOps.includes(operation) && !globalModels.includes(model)) {
            const existingWhere = (args['where'] as Record<string, unknown>) ?? {};
            args = { ...args, where: { ...existingWhere, customerId: store.customerId } };
          }

          return query(args);
        },
      },
    },
  });
}

export const prisma = globalForPrisma.prisma ?? buildPrisma();

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma;
}
