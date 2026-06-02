import { env } from '../../config/env';
import { getMyOrg, getMyServices } from '../organizations/organizations.service';
import type { ChatMessage } from './chat.schema';

interface OllamaChatResponse {
  message?: { role: string; content: string; thinking?: string };
  error?: string;
}

const SYSTEM_PROMPT = `You are the "Tech Assistant", an in-app support assistant for a B2B security-services SaaS platform.

Your job:
- Answer concise, practical questions about the customer's subscribed services, renewals, billing, and how to use the platform.
- Help users decide when and how to open a support ticket, and point them to the right team (Org Admin for account/access issues, CSM/SOC team for security investigations).

Rules:
- Be concise and professional. Prefer 1-3 short sentences. Use **bold** sparingly for key terms.
- Only use the organization context provided below — never invent service names, prices, dates, or people.
- You cannot perform actions (create tickets, change settings, query SIEM/EDR data). Guide the user to the right place instead.
- For account access problems (login, MFA, password, locked accounts), direct users to their Org Admin or a HIGH-priority ticket.
- If you don't know something or it's outside the provided context, say so and suggest opening a ticket.`;

/** Builds a grounding block from the caller's real org + service data. */
async function buildContext(orgId: string): Promise<string> {
  try {
    const [org, { services, monthlyTotal }] = await Promise.all([
      getMyOrg(orgId),
      getMyServices(orgId),
    ]);

    const serviceLines = services.length
      ? services
          .map((s) => {
            const renews = s.renewsAt ? new Date(s.renewsAt).toISOString().slice(0, 10) : 'n/a';
            return `- ${s.name} | status: ${s.status} | renews: ${renews} | $${s.monthlyPrice}/mo`;
          })
          .join('\n')
      : '- (no services subscribed)';

    return [
      `Organization: ${org.name} (plan: ${org.plan})`,
      `Monthly spend: $${monthlyTotal}/mo`,
      `Subscribed services:`,
      serviceLines,
    ].join('\n');
  } catch {
    // Context is best-effort; the assistant still works without it.
    return 'Organization context is currently unavailable.';
  }
}

export async function generateReply(
  orgId: string,
  message: string,
  history: ChatMessage[],
): Promise<string> {
  const context = await buildContext(orgId);

  const messages = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n--- ORGANIZATION CONTEXT ---\n${context}` },
    ...history,
    { role: 'user', content: message },
  ];

  // Abort if Ollama is slow/unreachable so the request doesn't hang.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let res: globalThis.Response;
  try {
    res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.OLLAMA_MODEL,
        messages,
        stream: false,
        options: { temperature: 0.4, num_predict: 512 },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw Object.assign(new Error(aborted ? 'The assistant timed out' : 'The assistant is unavailable'), {
      status: 503,
      code: 'LLM_UNAVAILABLE',
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw Object.assign(new Error(`Assistant backend error (${res.status})`), {
      status: 503,
      code: 'LLM_ERROR',
    });
  }

  const data = (await res.json()) as OllamaChatResponse;
  // qwen2.5 fills `content`. Fall back to `thinking` only if a reasoning model
  // (e.g. qwen3.x) ever leaves `content` empty, so the request never silently fails.
  const reply = data.message?.content?.trim() || data.message?.thinking?.trim();

  if (!reply) {
    throw Object.assign(new Error('The assistant returned an empty response'), {
      status: 502,
      code: 'LLM_EMPTY',
    });
  }

  return reply;
}
