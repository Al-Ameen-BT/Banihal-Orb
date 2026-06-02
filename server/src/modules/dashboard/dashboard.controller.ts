import { Request, Response, NextFunction } from 'express';
import { QueueQuerySchema } from './dashboard.schema';
import * as dashboardService from './dashboard.service';

export async function getKpis(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const kpis = await dashboardService.getKpis(req.user.customerId);
    res.json(kpis);
  } catch (err) { next(err); }
}

export async function getQueue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = QueueQuerySchema.parse(req.query);
    const queue = await dashboardService.getQueue(req.user.customerId, query);
    res.json(queue);
  } catch (err) { next(err); }
}
