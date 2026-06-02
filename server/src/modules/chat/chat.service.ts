import { env } from '../../config/env';
import type { ChatMessage } from './chat.schema';

interface AgentEvent {
  token?: string;
  error?: string;
}

/**
 * Proxy a chat turn to the Analytics Agent's SSE endpoint, consume the token
 * stream server-side, and return the full assembled reply.
 *
 * The agent always streams (`text/event-stream`) with events of the form:
 *   data: {"token": "..."}        ← appended to the answer
 *   data: {"error": "..."}        ← surfaced as a failure
 *   data: [DONE]                  ← end of stream
 *
 * We buffer the whole stream (read it to completion) and return one reply, so
 * the client `/api/chat` contract ({ reply }) is unchanged.
 */
export async function generateReply(message: string, history: ChatMessage[]): Promise<string> {
  // Abort if the agent is slow/unreachable so the request doesn't hang.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  let res: globalThis.Response;
  try {
    res = await fetch(`${env.AGENT_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw Object.assign(new Error(aborted ? 'The assistant timed out' : 'The assistant is unavailable'), {
      status: 503,
      code: 'AGENT_UNAVAILABLE',
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw Object.assign(new Error(`Assistant backend error (${res.status})`), {
      status: 503,
      code: 'AGENT_ERROR',
    });
  }

  // Buffered: wait for the full event-stream, then parse every `data:` line.
  const raw = await res.text();
  let reply = '';

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.startsWith('data:')) continue;

    const dataStr = line.slice(5).trim();
    if (!dataStr) continue;
    if (dataStr === '[DONE]') break;

    let event: AgentEvent;
    try {
      event = JSON.parse(dataStr) as AgentEvent;
    } catch {
      continue; // ignore keep-alives / non-JSON frames
    }

    if (event.error) {
      throw Object.assign(new Error('The assistant returned an error'), { status: 502, code: 'AGENT_STREAM_ERROR' });
    }
    if (event.token) reply += event.token;
  }

  reply = reply.trim();
  if (!reply) {
    throw Object.assign(new Error('The assistant returned an empty response'), { status: 502, code: 'AGENT_EMPTY' });
  }

  return reply;
}
