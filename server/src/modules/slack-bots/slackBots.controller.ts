import { Request, Response, NextFunction } from 'express';
import { CreateBotSchema, UpdateBotSchema, FieldSchema, UpdateFieldSchema, AssignOrgSchema } from './slackBots.schema';
import * as service from './slackBots.service';

export async function list(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ bots: await service.listBots() }); } catch (err) { next(err); }
}
export async function get(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.getBot(req.params['id']!)); } catch (err) { next(err); }
}
export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(201).json(await service.createBot(CreateBotSchema.parse(req.body))); } catch (err) { next(err); }
}
export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.updateBot(req.params['id']!, UpdateBotSchema.parse(req.body))); } catch (err) { next(err); }
}
export async function remove(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { await service.deleteBot(req.params['id']!); res.status(204).end(); } catch (err) { next(err); }
}
export async function connect(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.setEnabled(req.params['id']!, true)); } catch (err) { next(err); }
}
export async function disconnect(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.setEnabled(req.params['id']!, false)); } catch (err) { next(err); }
}
export async function generateApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.generateApiKey(req.params['id']!, { userId: req.user.userId, customerId: req.user.customerId })); } catch (err) { next(err); }
}

// ─── Form fields ────────────────────────────────────────────────────────────
export async function listFields(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ fields: await service.listFields(req.params['id']!) }); } catch (err) { next(err); }
}
export async function addField(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(201).json(await service.addField(req.params['id']!, FieldSchema.parse(req.body))); } catch (err) { next(err); }
}
export async function updateField(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.updateField(req.params['fieldId']!, UpdateFieldSchema.parse(req.body))); } catch (err) { next(err); }
}
export async function deleteField(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { await service.deleteField(req.params['fieldId']!); res.status(204).end(); } catch (err) { next(err); }
}

// ─── Org assignment ─────────────────────────────────────────────────────────
export async function listOrgs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ orgIds: await service.listBotOrgs(req.params['id']!) }); } catch (err) { next(err); }
}
export async function assignOrg(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { await service.assignOrg(req.params['id']!, AssignOrgSchema.parse(req.body).customerId); res.status(204).end(); } catch (err) { next(err); }
}
export async function unassignOrg(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { await service.unassignOrg(req.params['id']!, req.params['customerId']!); res.status(204).end(); } catch (err) { next(err); }
}
export async function customers(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ customers: await service.listCustomers() }); } catch (err) { next(err); }
}
