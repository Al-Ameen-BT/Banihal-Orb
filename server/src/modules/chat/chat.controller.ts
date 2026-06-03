import { Request, Response, NextFunction } from 'express';
import { ChatRequestSchema, type ChatMessage } from './chat.schema';
import * as chatService from './chat.service';

export async function sendMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Validate before committing to SSE so validation errors return normal JSON
  let message: string;
  let history: ChatMessage[];
  try {
    const parsed = ChatRequestSchema.parse(req.body);
    message = parsed.message;
    history = parsed.history;
  } catch (err) {
    next(err);
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx proxy buffering

  try {
    await chatService.streamToResponse(message, history, req, res);
  } catch (err) {
    if (!res.writableEnded) {
      const msg = err instanceof Error ? err.message : 'The assistant is unavailable';
      res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}
