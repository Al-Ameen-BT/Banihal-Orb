import { Request, Response, NextFunction } from 'express';
import { orgContext } from '../config/database';

export function tenantMiddleware(req: Request, _res: Response, next: NextFunction): void {
  orgContext.run({ orgId: req.user.orgId }, next);
}
