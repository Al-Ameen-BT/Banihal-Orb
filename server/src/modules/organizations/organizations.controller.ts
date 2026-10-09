import { Request, Response, NextFunction } from 'express';
import { UpdateOrgSchema, SecuritySettingsSchema } from './organizations.schema';
import * as orgsService from './organizations.service';

export async function getMyOrg(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const org = await orgsService.getMyOrg(req.user.customerId);
    res.json(org);
  } catch (err) { next(err); }
}

export async function updateMyOrg(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateOrgSchema.parse(req.body);
    const org = await orgsService.updateMyOrg(req.user.customerId, input);
    res.json(org);
  } catch (err) { next(err); }
}

export async function updateSecurity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = SecuritySettingsSchema.parse(req.body);
    const org = await orgsService.updateSecuritySettings(req.user.customerId, input);
    res.json(org);
  } catch (err) { next(err); }
}

export async function getMyServices(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await orgsService.getMyServices(req.user.customerId);
    res.json(result);
  } catch (err) { next(err); }
}
