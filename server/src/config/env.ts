import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  // Dedicated databases: chat history and the ticketing tool each get their own
  // PostgreSQL database, linked to the main DB via customerId/userId keys.
  CHAT_DATABASE_URL: z.string().url(),
  TICKETING_DATABASE_URL: z.string().url(),
  // Platform ADMINISTRATOR ticketing uses its own database (same schema).
  // Optional: when unset, administrators fall back to TICKETING_DATABASE_URL.
  ADMIN_TICKETING_DATABASE_URL: z.string().url().optional(),
  // Full Ticketing Platform schema (14-table b2b_ticket) backing the rebuilt module.
  TICKET_DATABASE_URL: z.string().url(),
  // Directory for ticket/comment attachment uploads (local disk). Relative to cwd.
  // NOTE: persist this path in production — the systemd deploy rebuilds the tree.
  UPLOAD_DIR: z.string().default('uploads'),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  IMPERSONATION_SECRET: z.string().min(32),
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  // Public URL of the frontend — used to build links in emails (password reset).
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  // Comma-separated work-email domains allowed to hold the ADMINISTRATOR (software
  // provider) role. REQUIRED for admin login — when empty, admin login is disabled.
  ADMIN_DOMAINS: z.string().default(''),
  // Single-session enforcement: a session idle longer than this no longer blocks
  // a new login (prevents 7-day lockout when a browser closes without logout).
  SESSION_INACTIVITY_MINUTES: z.coerce.number().min(1).default(30),
  // External ticketing API (mirror + sync). The integration is fully disabled
  // while TICKETING_API_URL is unset — local tickets keep working standalone.
  TICKETING_API_URL: z.string().url().optional(),
  TICKETING_API_KEY: z.string().optional(),
  COOKIE_SECURE: z.preprocess((val) => {
    if (val === 'true') return true;
    if (val === 'false') return false;
    return undefined;
  }, z.boolean().optional()),
  // Chatbot backend — Analytics Agent (SSE streaming) on the same host.
  // The agent wraps the LLM + knowledge base; /api/chat proxies to it.
  AGENT_URL: z.string().url().default('http://localhost:8001'),
  // Secret for encrypting Slack bot tokens at rest (AES-256-GCM). Falls back to
  // JWT_ACCESS_SECRET when unset so no extra config is required in dev.
  SLACK_TOKEN_SECRET: z.string().optional(),
  // Legacy Ollama settings (the agent manages its own model now; kept for the deploy preflight)
  OLLAMA_URL: z.string().url().default('http://localhost:11435'),
  OLLAMA_MODEL: z.string().default('qwen2.5:3b'),
  // SMTP settings for mailing system
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('noreply@b2bsaas.com'),
  // Email MFA: a 6-digit code is required on every login. TTL, max wrong-code
  // attempts before the challenge is burned, and a resend cooldown (anti-spam).
  MFA_CODE_TTL_MINUTES: z.coerce.number().min(1).default(10),
  MFA_MAX_ATTEMPTS: z.coerce.number().min(1).default(5),
  MFA_RESEND_COOLDOWN_SECONDS: z.coerce.number().min(0).default(30),
});

const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:\n', result.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = result.data;
export type Env = typeof env;
