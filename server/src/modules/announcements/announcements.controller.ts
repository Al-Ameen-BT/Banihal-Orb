import { Request, Response, NextFunction } from 'express';
import * as announcementsService from './announcements.service';

export async function listAnnouncements(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const announcements = await announcementsService.listForCustomer(req.user.customerId);
    res.json({ announcements });
  } catch (err) { next(err); }
}
