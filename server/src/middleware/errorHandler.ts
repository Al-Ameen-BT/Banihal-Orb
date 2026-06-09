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
