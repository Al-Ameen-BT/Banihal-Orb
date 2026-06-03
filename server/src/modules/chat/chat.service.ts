import type { Request, Response } from 'express';
import { env } from '../../config/env';
import type { ChatMessage } from './chat.schema';

interface AgentEvent {
  token?: string;
  error?: string;
}

/**
 * Proxy a chat turn to the Analytics Agent's SSE endpoint and pipe the token
 * stream directly to the Express response so the client sees tokens progressively.
 *
 * Agent SSE protocol:
 *   data: {"token": "..."}        ← forwarded to client
 *   data: {"error": "..."}        ← forwarded as error event, then [DONE]
 *   data: [DONE]                  ← forwarded to client, stream ends
 */
export async function streamToResponse(
  message: string,
  history: ChatMessage[],
  req: Request,
  res: Response,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  // Clean up when the client disconnects early
  req.on('close', () => controller.abort());

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
            return;
          }

          if (event.token) {
            res.write(`data: ${JSON.stringify({ token: event.token })}\n\n`);
          }
        }
      }

      // Stream ended without an explicit [DONE] frame
      res.write('data: [DONE]\n\n');
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timeout);
    if (!res.writableEnded) res.end();
  }
}
