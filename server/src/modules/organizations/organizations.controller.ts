import { Request, Response, NextFunction } from 'express';
import { UpdateOrgSchema, SecuritySettingsSchema } from './organizations.schema';
import * as orgsService from './organizations.service';

export async function getMyOrg(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const org = await orgsService.getMyOrg(req.user.orgId);
    res.json(org);
  } catch (err) { next(err); }
}

export async function updateMyOrg(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateOrgSchema.parse(req.body);
    const org = await orgsService.updateMyOrg(req.user.orgId, input);
    res.json(org);
  } catch (err) { next(err); }
}

export async function updateSecurity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = SecuritySettingsSchema.parse(req.body);
    const org = await orgsService.updateSecuritySettings(req.user.orgId, input);
    res.json(org);
  } catch (err) { next(err); }
}

export async function getUsage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const usage = await orgsService.getUsage(req.user.orgId);
    res.json(usage);
  } catch (err) { next(err); }
}

export async function getMyServices(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await orgsService.getMyServices(req.user.orgId);
    res.json(result);
  } catch (err) { next(err); }
}
