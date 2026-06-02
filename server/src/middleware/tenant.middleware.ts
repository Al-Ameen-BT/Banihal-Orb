import { Request, Response, NextFunction } from 'express';
import { customerContext } from '../config/database';

export function tenantMiddleware(req: Request, _res: Response, next: NextFunction): void {
  customerContext.run({ customerId: req.user.customerId }, next);
}
