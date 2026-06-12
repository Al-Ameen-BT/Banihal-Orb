import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { chatPrisma } from '../../config/chatDatabase';
import type { ChatMessage } from './chat.schema';

interface AgentEvent {
  token?: string;
  error?: string;
}

export interface ChatContext {
  userId: string;
  customerId: string;
  sessionId?: string | undefined;
}

function deriveTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

/**
 * Resolve the target chat session — reuse an existing one owned by the user, or
 * create a fresh session titled from the opening message. customerId is set
 * explicitly because `create` is not auto-scoped by the tenant extension.
 */
async function resolveSession(ctx: ChatContext, message: string): Promise<string> {
  if (ctx.sessionId) {
    const existing = await chatPrisma.chatSession.findFirst({
      where: { id: ctx.sessionId, userId: ctx.userId },
      select: { id: true },
    });
    if (existing) return existing.id;
  }

  const created = await chatPrisma.chatSession.create({
    data: { customerId: ctx.customerId, userId: ctx.userId, title: deriveTitle(message) },
    select: { id: true },
  });
  return created.id;
}

/**
 * Proxy a chat turn to the Analytics Agent's SSE endpoint and pipe the token
 * stream directly to the Express response so the client sees tokens progressively.
 * The user message and the accumulated assistant reply are persisted to the
 * resolved ChatSession so the conversation appears in dashboard chat history.
 *
 * Agent SSE protocol:
 *   data: {"token": "..."}        ← forwarded to client
 *   data: {"error": "..."}        ← forwarded as error event, then [DONE]
 *   data: [DONE]                  ← forwarded to client, stream ends
 *
 * In addition, an initial `data: {"sessionId":"..."}` frame is emitted so the
 * client can track / resume the conversation.
 */
export async function streamToResponse(
  message: string,
  history: ChatMessage[],
  req: Request,
  res: Response,
  ctx: ChatContext,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  // Clean up when the client disconnects early
  req.on('close', () => controller.abort());

  // Resolve session + persist the user turn before streaming so the message is
  // saved even if the agent errors mid-stream.
  const sessionId = await resolveSession(ctx, message);
  res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);
  await chatPrisma.chatMessage.create({
    data: { customerId: ctx.customerId, sessionId, role: 'USER', content: message },
  });

  let fullReply = '';

  // Persist whatever assistant text we accumulated and bump the session.
  const persistReply = async (): Promise<void> => {
    if (!fullReply.trim()) return;
    await chatPrisma.chatMessage.create({
      data: { customerId: ctx.customerId, sessionId, role: 'ASSISTANT', content: fullReply },
    });
    // Touch updatedAt so recent conversations sort first in history.
    await chatPrisma.chatSession.update({ where: { id: sessionId }, data: { updatedAt: new Date() } });
  };

  try {
    let agentRes: globalThis.Response;
    try {
      agentRes = await fetch(`${env.AGENT_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history }),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw Object.assign(
        new Error(aborted ? 'The assistant timed out' : 'The assistant is unavailable'),
        { status: 503, code: 'AGENT_UNAVAILABLE' },
      );
    }

    if (!agentRes.ok) {
      throw Object.assign(new Error(`Assistant backend error (${agentRes.status})`), {
        status: 503,
        code: 'AGENT_ERROR',
      });
    }

    if (!agentRes.body) {
      throw Object.assign(new Error('Agent returned no body'), { status: 502, code: 'AGENT_EMPTY' });
    }

    const reader = agentRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line.startsWith('data:')) continue;

          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;

          if (dataStr === '[DONE]') {
            res.write('data: [DONE]\n\n');
            await persistReply();
            return;
          }

          let event: AgentEvent;
          try {
            event = JSON.parse(dataStr) as AgentEvent;
          } catch {
            continue;
          }

          if (event.error) {
            res.write(`data: ${JSON.stringify({ error: event.error })}\n\n`);
            res.write('data: [DONE]\n\n');
            await persistReply();
            return;
          }

          if (event.token) {
            fullReply += event.token;
            res.write(`data: ${JSON.stringify({ token: event.token })}\n\n`);
          }
        }
      }

      // Stream ended without an explicit [DONE] frame
      res.write('data: [DONE]\n\n');
      await persistReply();
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timeout);
    if (!res.writableEnded) res.end();
  }
}

// ─── Chat history (persisted sessions) ──────────────────────────────────────

export async function listSessions(userId: string) {
  const sessions = await chatPrisma.chatSession.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });

  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s._count.messages,
  }));
}

export async function getSession(id: string, userId: string) {
  const session = await chatPrisma.chatSession.findFirst({
    where: { id, userId },
    select: { id: true, title: true, createdAt: true, updatedAt: true },
  });
  if (!session) throw Object.assign(new Error('Conversation not found'), { status: 404, code: 'NOT_FOUND' });

  const messages = await chatPrisma.chatMessage.findMany({
    where: { sessionId: id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, content: true, createdAt: true },
  });

  return { ...session, messages };
}

export async function deleteSession(id: string, userId: string): Promise<void> {
  const session = await chatPrisma.chatSession.findFirst({ where: { id, userId }, select: { id: true } });
  if (!session) throw Object.assign(new Error('Conversation not found'), { status: 404, code: 'NOT_FOUND' });
  await chatPrisma.chatSession.delete({ where: { id } });
}
