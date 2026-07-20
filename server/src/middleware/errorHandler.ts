import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { env } from '../config/env';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.flatten() });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'A record with this value already exists', code: 'CONFLICT' });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'Record not found', code: 'NOT_FOUND' });
      return;
    }
    // P2021: table missing, P2010/P2022: raw query / column errors that usually
    // mean the schema hasn't been applied to this datasource. Report as an
    // upstream/service problem rather than an opaque 500.
    if (err.code === 'P2021' || err.code === 'P2010' || err.code === 'P2022') {
      res.status(503).json({ error: 'A required data store is unavailable', code: 'DATABASE_UNAVAILABLE' });
      return;
    }
  }

  // Can't reach a database server (e.g. an unreachable ticketing store). This is
  // a transient infrastructure outage, not a bug in the request — a 503 lets
  // clients back off instead of surfacing a generic 500 error page.
  if (err instanceof Prisma.PrismaClientInitializationError) {
    res.status(503).json({ error: 'A required data store is unavailable', code: 'DATABASE_UNAVAILABLE' });
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
