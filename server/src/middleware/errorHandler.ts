import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env';

// Prisma generates its error classes PER client, and this app runs four
// (@prisma/client, ticket-client, ticketing-client, chat-client). `instanceof`
// against the main client's classes is therefore FALSE for everything thrown by
// the ticket/chat stores — including the unreachable admin ticket store the 503
// below was written for, which reached the generic branch and surfaced as a bare
// 500 (and a hard redirect to /server-error). Match the shape instead: `name` is
// stable across generated clients and every Prisma error carries its P-code.
const prismaError = (err: unknown, name: string): (Error & { code?: string }) | null =>
  err instanceof Error && err.name === name ? err : null;

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    const flat = err.flatten();
    // FIELD NAMES AND ZOD'S OWN MESSAGES ONLY — never the submitted values, which
    // are user data. Without this a 400 reported from production ("the New Ticket
    // form fails") could not be traced to a field at all: the details go to the
    // client, and the server kept no record of them.
    console.warn(`⚠️  400 VALIDATION_ERROR ${req.method} ${req.originalUrl}`,
      JSON.stringify({ ...flat.fieldErrors, ...(flat.formErrors.length ? { _form: flat.formErrors } : {}) }));
    res.status(400).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: flat });
    return;
  }

  const known = prismaError(err, 'PrismaClientKnownRequestError');
  if (known) {
    if (known.code === 'P2002') {
      res.status(409).json({ error: 'A record with this value already exists', code: 'CONFLICT' });
      return;
    }
    if (known.code === 'P2025') {
      res.status(404).json({ error: 'Record not found', code: 'NOT_FOUND' });
      return;
    }
    // P2003: something else still points at the row. Reached the generic branch
    // before, so a blocked delete surfaced as a bare 500 "Internal server error"
    // — the org-deletion dialog could not say what was holding the record. The
    // constraint name goes to the server log, never to the client: it is schema
    // detail, and this handler serves every route.
    if (known.code === 'P2003') {
      const meta = (known as Error & { meta?: Record<string, unknown> }).meta;
      console.warn(`⚠️  409 FK_CONSTRAINT ${req.method} ${req.originalUrl}`, JSON.stringify(meta ?? {}));
      res.status(409).json({
        error: 'Other records still reference this data, so it could not be removed. Check the server log for the blocking constraint.',
        code: 'FK_CONSTRAINT',
      });
      return;
    }
    // P2021: table missing, P2010/P2022: raw query / column errors that usually
    // mean the schema hasn't been applied to this datasource. P2024: pool timeout —
    // what a store on a distant link produces once RTT eats the pool. Report as an
    // upstream/service problem rather than an opaque 500.
    if (known.code === 'P2021' || known.code === 'P2010' || known.code === 'P2022' || known.code === 'P2024') {
      res.status(503).json({ error: 'A required data store is unavailable', code: 'DATABASE_UNAVAILABLE' });
      return;
    }
  }

  // Can't reach a database server (e.g. an unreachable ticketing store). This is
  // a transient infrastructure outage, not a bug in the request — a 503 lets
  // clients back off instead of surfacing a generic 500 error page.
  if (prismaError(err, 'PrismaClientInitializationError')) {
    res.status(503).json({ error: 'A required data store is unavailable', code: 'DATABASE_UNAVAILABLE' });
    return;
  }

  // Multer rejects (file too large, too many files) carry a `code` but no `status`,
  // so without this they'd surface as a 500 and bounce the client to /server-error.
  if (err instanceof Error && err.name === 'MulterError') {
    res.status(400).json({ error: err.message, code: (err as Error & { code?: string }).code ?? 'UPLOAD_REJECTED' });
    return;
  }

  if (err instanceof Error) {
    const status = (err as Error & { status?: number }).status ?? 500;
    const code = (err as Error & { code?: string }).code;
    res.status(status).json({
      error: status === 500 ? 'Internal server error' : err.message,
      code: status === 500 ? 'INTERNAL_ERROR' : (code ?? 'ERROR'),
      ...(env.NODE_ENV !== 'production' && status === 500 ? { stack: err.stack } : {}),
    });
    return;
  }

  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}
