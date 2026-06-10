import { Request, Response, NextFunction } from 'express';
import { ChatRequestSchema, type ChatMessage } from './chat.schema';
import * as chatService from './chat.service';

export async function sendMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Validate before committing to SSE so validation errors return normal JSON
  let message: string;
  let history: ChatMessage[];
  let sessionId: string | undefined;
  try {
    const parsed = ChatRequestSchema.parse(req.body);
    message = parsed.message;
    history = parsed.history;
    sessionId = parsed.sessionId;
  } catch (err) {
    next(err);
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx proxy buffering

  try {
    await chatService.streamToResponse(message, history, req, res, {
      userId: req.user.userId,
      customerId: req.user.customerId,
      sessionId,
    });
  } catch (err) {
    if (!res.writableEnded) {
      const msg = err instanceof Error ? err.message : 'The assistant is unavailable';
      res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}

export async function listSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessions = await chatService.listSessions(req.user.userId);
    res.json({ sessions });
  } catch (err) { next(err); }
}

export async function getSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await chatService.getSession(req.params['id']!, req.user.userId);
    res.json(session);
  } catch (err) { next(err); }
}

export async function deleteSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await chatService.deleteSession(req.params['id']!, req.user.userId);
    res.status(204).end();
  } catch (err) { next(err); }
}
