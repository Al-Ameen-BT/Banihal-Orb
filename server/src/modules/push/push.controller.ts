import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../config/database';
import { isPushConfigured } from '../../lib/webpush';
import { SubscribeSchema, UnsubscribeSchema } from './push.schema';

// GET /api/push/vapid-public-key — lets the client fetch the applicationServerKey
// without hardcoding it. The PUBLIC key only; the private key never leaves the server.
export async function getVapidPublicKey(_req: Request, res: Response): Promise<void> {
  res.json({ publicKey: process.env['VAPID_PUBLIC_KEY'] ?? null, configured: isPushConfigured() });
}

// POST /api/push/subscribe — upsert on the unique endpoint. userId + tenantId are
// taken from the authenticated session (req.user), never from the request body.
export async function subscribe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = SubscribeSchema.parse(req.body);
    const userId = req.user.userId;
    const tenantId = req.user.customerId; // the app's tenant key
    const userAgent = input.userAgent ?? (typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 512) : undefined);

    await prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userId,
        tenantId,
        userAgent: userAgent ?? null,
      },
      update: {
        // Re-bind the endpoint to the current owner + refresh keys/freshness. This
        // makes re-subscribe (and pushsubscriptionchange re-POST) idempotent.
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userId,
        tenantId,
        userAgent: userAgent ?? null,
        lastUsedAt: new Date(),
      },
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// POST /api/push/unsubscribe — delete the row, scoped to the calling owner so one
// user can never remove another user's subscription by guessing an endpoint.
export async function unsubscribe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UnsubscribeSchema.parse(req.body);
    const result = await prisma.pushSubscription.deleteMany({
      where: { endpoint: input.endpoint, userId: req.user.userId },
    });
    res.json({ ok: true, removed: result.count });
  } catch (err) {
    next(err);
  }
}
