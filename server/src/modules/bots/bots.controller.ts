import { Request, Response, NextFunction } from 'express';
import { CreateBotTicketSchema } from './bots.schema';
import * as service from './bots.service';

export async function list(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ bots: await service.listOrgBots() }); } catch (err) { next(err); }
}

export async function createTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = CreateBotTicketSchema.parse(req.body);
    const result = await service.createBotTicket(
      { userId: req.user.userId, role: req.user.role, customerId: req.user.customerId },
      req.params['id']!,
      input,
    );
    res.status(201).json(result);
  } catch (err) { next(err); }
}
