import type { Request, Response } from 'express';
import { chatPrisma } from '../../config/chatDatabase';
import { agentChat, agentRoleFor } from '../../services/agentApi';
import type { ChatMessage } from './chat.schema';

export interface ChatContext {
  userId: string;
  customerId: string;
  role: string;
  sessionId?: string | undefined;
}

// The agent's signed /v1/chat is stateless — it takes one message and no history.
// Prior turns are folded into that message as a short transcript so follow-ups
// ("what about last month?") still resolve. Capped at the last 3 exchanges: the
// model runs on CPU with an 8192-token context, and older turns buy little.
function withHistory(message: string, history: ChatMessage[]): string {
  const recent = history.slice(-6);
  if (recent.length === 0) return message;
  const transcript = recent
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
  return `${transcript}\nUser: ${message}`;
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
 * Run one chat turn against the Analytics Agent and emit it to the client as SSE.
 *
 * The agent's unsigned streaming endpoint (`POST /api/chat`) answers 401 on the
 * remote deployment — with or without a valid signature — so this goes through
 * the documented, HMAC-signed `/v1/chat` surface via services/agentApi. That
 * surface is one-shot rather than token-streamed; replies land in ~1s, so the
 * whole answer is emitted as a single token frame and the client's existing
 * incremental rendering is unchanged.
 *
 * The user message and the assistant reply are persisted to the resolved
 * ChatSession so the conversation appears in dashboard chat history.
 *
 * SSE frames emitted (unchanged contract):
 *   data: {"sessionId":"..."}   ← first frame, so the client can resume
 *   data: {"token": "..."}      ← the reply
 *   data: {"error": "..."}      ← on failure, followed by [DONE]
 *   data: [DONE]                ← always last
 */
export async function streamToResponse(
  message: string,
  history: ChatMessage[],
  _req: Request,
  res: Response,
  ctx: ChatContext,
): Promise<void> {
  // Resolve session + persist the user turn before calling the agent so the
  // message is saved even if the agent errors.
  const sessionId = await resolveSession(ctx, message);
  res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);
  await chatPrisma.chatMessage.create({
    data: { customerId: ctx.customerId, sessionId, role: 'USER', content: message },
  });

  try {
    const { reply } = await agentChat(withHistory(message, history), agentRoleFor(ctx.role));

    res.write(`data: ${JSON.stringify({ token: reply })}\n\n`);

    if (reply.trim()) {
      await chatPrisma.chatMessage.create({
        data: { customerId: ctx.customerId, sessionId, role: 'ASSISTANT', content: reply },
      });
      // Touch updatedAt so recent conversations sort first in history.
      await chatPrisma.chatSession.update({
        where: { id: sessionId }, data: { updatedAt: new Date() },
      });
    }
  } catch (err) {
    // Log before the error is swallowed into the SSE frame: otherwise a failed
    // turn leaves only an orphan USER row in ChatMessage and nothing in the
    // journal, so there is no way to tell afterwards WHY the assistant went quiet.
    console.error(`[chat] agent call failed (session ${sessionId}, user ${ctx.userId}, ${(err as { code?: string }).code ?? 'no-code'}):`, err);
    // agentApi throws with the agent's own machine code attached; surfacing its
    // message beats a generic "unavailable" for server_busy / rate_limited.
    const msg = err instanceof Error ? err.message : 'The assistant is unavailable';
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
  } finally {
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
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
