import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  IMPERSONATION_SECRET: z.string().min(32),
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  COOKIE_SECURE: z.preprocess((val) => {
    if (val === 'true') return true;
    if (val === 'false') return false;
    return undefined;
  }, z.boolean().optional()),
  // Chatbot backend — Analytics Agent (SSE streaming) on the same host.
  // The agent wraps the LLM + knowledge base; /api/chat proxies to it.
  AGENT_URL: z.string().url().default('http://localhost:8001'),
  // Legacy Ollama settings (the agent manages its own model now; kept for the deploy preflight)
  OLLAMA_URL: z.string().url().default('http://localhost:11435'),
  OLLAMA_MODEL: z.string().default('qwen2.5:3b'),
});

const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:\n', result.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
