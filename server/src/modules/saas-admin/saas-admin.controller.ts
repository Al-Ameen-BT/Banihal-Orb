import { Request, Response, NextFunction } from 'express';
import {
  ListOrgsSchema, UpdateOrgSchema, ToggleFlagSchema,
  ListRequestsSchema, UpdateRequestSchema,
  ListServicesSchema, UpdateServiceSchema, RenewServiceSchema,
  UpdateUserSchema,
} from './saas-admin.schema';
import * as saasAdminService from './saas-admin.service';

export async function listOrgs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ListOrgsSchema.parse(req.query);
    const result = await saasAdminService.listAllOrgs(input);
    res.json(result);
  } catch (err) { next(err); }
}

export async function updateOrg(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateOrgSchema.parse(req.body);
    const org = await saasAdminService.updateOrg(req.params['id']!, input);
    res.json(org);
  } catch (err) { next(err); }
}

export async function impersonateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await saasAdminService.impersonateUser(req.params['userId']!, req.user.userId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getMetrics(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const metrics = await saasAdminService.getPlatformMetrics();
    res.json(metrics);
  } catch (err) { next(err); }
}

export async function getOrgsOverview(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await saasAdminService.getOrgsOverview();
    res.json(result);
  } catch (err) { next(err); }
}

export async function getTopClients(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(parseInt(req.query['limit'] as string ?? '10', 10) || 10, 20);
    const clients = await saasAdminService.getTopClients(limit);
    res.json({ clients });
  } catch (err) { next(err); }
}

export async function listOrgAdmins(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const admins = await saasAdminService.listOrgAdmins();
    res.json({ admins });
  } catch (err) { next(err); }
}

export async function listRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ListRequestsSchema.parse(req.query);
    const result = await saasAdminService.listServiceRequests(input);
    res.json(result);
  } catch (err) { next(err); }
}

export async function updateRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateRequestSchema.parse(req.body);
    const result = await saasAdminService.updateServiceRequest(req.params['id']!, req.user.userId, input);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listServices(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ListServicesSchema.parse(req.query);
    const result = await saasAdminService.listAllServices(input);
    res.json(result);
  } catch (err) { next(err); }
}

export async function updateService(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateServiceSchema.parse(req.body);
    const service = await saasAdminService.updateService(req.params['id']!, req.user.userId, input);
    res.json(service);
  } catch (err) { next(err); }
}

export async function renewService(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = RenewServiceSchema.parse(req.body);
    const service = await saasAdminService.renewService(req.params['id']!, req.user.userId, input);
    res.json(service);
  } catch (err) { next(err); }
}

export async function getOrgDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const detail = await saasAdminService.getOrgDetail(req.params['id']!);
    res.json(detail);
  } catch (err) { next(err); }
}

export async function updateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateUserSchema.parse(req.body);
    const user = await saasAdminService.updateUser(req.params['id']!, req.user.userId, input);
    res.json(user);
  } catch (err) { next(err); }
}

export async function removeUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await saasAdminService.removeUser(req.params['id']!, req.user.userId);
    res.status(204).end();
  } catch (err) { next(err); }
}

export async function resetUserPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await saasAdminService.resetUserPassword(req.params['id']!, req.user.userId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listFlags(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await saasAdminService.listFlags()); } catch (err) { next(err); }
}

export async function toggleFlag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ToggleFlagSchema.parse(req.body);
    const flag = await saasAdminService.upsertFlag(req.params['key']!, input);
    res.json(flag);
  } catch (err) { next(err); }
}
