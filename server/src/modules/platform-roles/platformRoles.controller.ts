import { Request, Response, NextFunction } from 'express';
import * as service from './platformRoles.service';
import { PERMISSIONS } from '../../config/permissions';

// The roles matrix needs both halves: the catalogue of keys that exist (code) and
// which keys each role currently holds (data).

export async function listRoles(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ roles: await service.listRoles() });
  } catch (err) { next(err); }
}

export function permissionCatalog(_req: Request, res: Response): void {
  res.json({ permissions: PERMISSIONS });
}
