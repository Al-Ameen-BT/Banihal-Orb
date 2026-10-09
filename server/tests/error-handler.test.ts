import { describe, it, expect } from 'vitest';
import { Prisma as TicketPrisma } from '@prisma/ticket-client';
import { errorHandler } from '../src/middleware/errorHandler';

// The ticket stores run their OWN generated Prisma client, so its error classes are
// NOT the ones `@prisma/client` exports. An errorHandler that matched with
// `instanceof` therefore missed every ticket-store failure and answered 500 — worst
// for the admin store, which lives on its own (remote) database.
const run = (err: unknown) => {
  const res = { code: 0, body: {} as Record<string, unknown> };
  errorHandler(err, {} as never, {
    status(c: number) { res.code = c; return this; },
    json(b: Record<string, unknown>) { res.body = b; return this; },
  } as never, (() => {}) as never);
  return res;
};

describe('errorHandler — errors from a non-default Prisma client', () => {
  it('maps an unreachable ticket store to 503, not 500', () => {
    const err = new TicketPrisma.PrismaClientInitializationError("Can't reach database server", '5.10.2', 'P1001');
    expect(run(err)).toMatchObject({ code: 503, body: { code: 'DATABASE_UNAVAILABLE' } });
  });

  it('maps a connection-pool timeout (P2024) to 503', () => {
    const err = new TicketPrisma.PrismaClientKnownRequestError('Timed out fetching a connection', { code: 'P2024', clientVersion: '5.10.2' });
    expect(run(err)).toMatchObject({ code: 503, body: { code: 'DATABASE_UNAVAILABLE' } });
  });

  it('maps a blocked delete (P2003) to 409 with a message, not a bare 500', () => {
    const err = new TicketPrisma.PrismaClientKnownRequestError('Foreign key constraint violated', {
      code: 'P2003', clientVersion: '5.10.2', meta: { field_name: 'Tickets_assigneeId_fkey (index)' },
    });
    const res = run(err);
    expect(res).toMatchObject({ code: 409, body: { code: 'FK_CONSTRAINT' } });
    // The constraint name is schema detail — it belongs in the log, not the response.
    expect(JSON.stringify(res.body)).not.toContain('assigneeId');
  });

  it('still maps a unique violation to 409', () => {
    const err = new TicketPrisma.PrismaClientKnownRequestError('Unique constraint', { code: 'P2002', clientVersion: '5.10.2' });
    expect(run(err)).toMatchObject({ code: 409, body: { code: 'CONFLICT' } });
  });
});
