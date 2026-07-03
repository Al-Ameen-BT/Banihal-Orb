import { env } from '../config/env';

interface AgentEvent { token?: string; error?: string }
export interface AgentHistoryItem { role: 'USER' | 'ASSISTANT'; content: string }

// Ask the Analytics Agent (Ollama-backed) for a full reply, aggregating its SSE
// `token` frames into a single string. Mirrors the frame protocol consumed by
// chat.service.ts streamToResponse, but buffers the whole answer (used by the
// Slack bridge, which posts one complete message back to Slack).
export async function askAgent(message: string, history: AgentHistoryItem[] = []): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${env.AGENT_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Assistant backend error (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reply = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trimEnd();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') { if (data === '[DONE]') return reply.trim(); continue; }
        let event: AgentEvent;
        try { event = JSON.parse(data) as AgentEvent; } catch { continue; }
        if (event.error) return reply.trim() || `⚠️ ${event.error}`;
        if (event.token) reply += event.token;
      }
    }
    return reply.trim();
  } finally {
    clearTimeout(timeout);
  }
}
