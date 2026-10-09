import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as service from './adSecrets.service';
import type { AdBot } from './adKeyAuth.middleware';

const DeliverSchema = z.object({
  ticketNumber: z.string().min(1).max(64),
  secret: z.string().min(1).max(512),
  targetEmail: z.string().email().optional(),
});

// Machine ingest (bearer key). No user session — req.bot is set by adKeyAuth.
export async function deliver(req: Request & { bot?: AdBot }, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = DeliverSchema.parse(req.body);
    res.status(201).json(await service.deliverSecret(req.bot!, input));
  } catch (err) { next(err); }
}

// Org side (cookie auth + tenant).
export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ deliveries: await service.listForUser(req.user.userId) }); } catch (err) { next(err); }
}
export async function reveal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.reveal(req.user.userId, req.params['id']!));
  } catch (err) { next(err); }
}
