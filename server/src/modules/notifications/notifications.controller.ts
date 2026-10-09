import { Request, Response, NextFunction } from 'express';
import { ListNotificationsSchema } from './notifications.schema';
import * as service from './notifications.service';

// Every handler reads req.user.userId and never a client-supplied id: a caller can
// only ever see, or clear, their own notifications.

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { limit, before } = ListNotificationsSchema.parse(req.query);
    res.json(await service.listForUser(req.user.userId, { limit, before }));
  } catch (err) { next(err); }
}

export async function markRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await service.markRead(req.user.userId, req.params['id']!);
    // 204 whether or not a row matched: marking an already-read (or someone
    // else's) notification is a no-op, not an error worth leaking existence over.
    res.status(204).end();
  } catch (err) { next(err); }
}

export async function markAllRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ cleared: await service.markAllRead(req.user.userId) });
  } catch (err) { next(err); }
}
