import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../config/database';
import { createKey, revokeKey, listKeys } from './external-keys';
import { createWebhook, listWebhooks, removeWebhook } from './external-webhooks';
import { listCustomers } from '../slack-bots/slackBots.service';
import {
  CreateExternalKeySchema,
  CreateExternalWebhookSchema,
} from './external-admin.schema';

// HTTP surface for the admin UI (was CLI-only). Auditing lives in the service
// layer, so a panel call and a CLI call write the same trail.

const actor = (req: Request) => ({ userId: req.user?.userId ?? '', customerId: req.user?.customerId ?? '' });
const notFound = () => Object.assign(new Error('Key not found'), { status: 404, code: 'NOT_FOUND' });

/** Resolve a key by its public clientId OR internal db id to its db id. */
async function keyIdOf(ref: string): Promise<string> {
  const key = await prisma.externalApiKey.findFirst({
    where: { OR: [{ clientId: ref }, { id: ref }] },
    select: { id: true },
  });
  if (!key) throw notFound();
  return key.id;
}

export async function list(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ keys: await listKeys(), customers: await listCustomers() });
  } catch (err) { next(err); }
}

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = CreateExternalKeySchema.parse(req.body);
    const issued = await createKey({
      ...input,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    }, actor(req));
    res.status(201).json(issued);
  } catch (err) { next(err); }
}

export async function revoke(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await revokeKey(req.params['clientId']!, actor(req));
    res.status(204).end();
  } catch (err) { next(err); }
}

export async function listHooks(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ webhooks: await listWebhooks(await keyIdOf(req.params['clientId']!)) });
  } catch (err) { next(err); }
}

export async function addHook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = CreateExternalWebhookSchema.parse(req.body);
    const created = await createWebhook(await keyIdOf(req.params['clientId']!), input, actor(req));
    res.status(201).json(created);
  } catch (err) { next(err); }
}

export async function removeHook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await removeWebhook(req.params['id']!, actor(req));
    res.status(204).end();
  } catch (err) { next(err); }
}