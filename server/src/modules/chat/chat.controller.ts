import { Request, Response, NextFunction } from 'express';
import { ChatRequestSchema } from './chat.schema';
import * as chatService from './chat.service';

export async function sendMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { message, history } = ChatRequestSchema.parse(req.body);
    const reply = await chatService.generateReply(req.user.orgId, message, history);
    res.json({ reply });
  } catch (err) { next(err); }
}
