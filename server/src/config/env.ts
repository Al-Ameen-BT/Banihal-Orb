import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  // Dedicated databases: chat history and the ticketing tool each get their own
  // PostgreSQL database, linked to the main DB via customerId/userId keys.
  CHAT_DATABASE_URL: z.string().url(),
  TICKETING_DATABASE_URL: z.string().url(),
  // Platform ADMINISTRATOR ticketing uses its OWN database (b2b_ticketing_admin;
  // schema loaded from the `ticketingDB` pg dump). REQUIRED — there is NO fallback:
  // if this DB is unset or unreachable, admin ticketing fails loudly rather than
  // silently reading/writing the shared b2b_ticket store.
  ADMIN_TICKETING_DATABASE_URL: z.string().url(),
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

  // ─── Agent signed /v1 API (services/agentApi.ts) ──────────────────────────
  // The SAME agent server as AGENT_URL above, reached through its documented,
  // HMAC-signed surface instead of the unsigned /api/chat stream. Everything the
  // agent exposes lives on one port (8001), so this is one base URL; it is named
  // AGENT_BASE_URL because that is what the agent's own useAPI.md tells
  // integrators to set. Falls back to AGENT_URL so a deployment that only set the
  // older name does not silently sign requests against localhost.
  AGENT_BASE_URL: z.string().url().optional(),

  // Chat credential (`ext-*`). Both halves must be set or the /v1 chat route
  // reports 503 rather than sending an unsigned request that would 401 anyway.
  // How long a single /v1/chat call may run before we give up on it, in ms.
  // The agent's own guide asks for >= 180s (its upstream ceiling) — this default is
  // deliberately far below that: the product requirement is an answer inside 15s,
  // and a reply still generating at that point is worth abandoning with a clear
  // message rather than making the user watch a spinner. Raise it here (no code
  // change) if long, thorough answers matter more than the deadline.
  AGENT_CHAT_TIMEOUT_MS: z.coerce.number().min(1000).default(15_000),
  AGENT_CHAT_CLIENT_ID: z.string().optional(),
  AGENT_CHAT_SECRET: z.string().optional(),

  // Top-complaints credential (`dc-*`) — issued SEPARATELY from the chat one;
  // a chat credential will not authenticate against /v1/top-complaints.
  AGENT_COMPLAINTS_CLIENT_ID: z.string().optional(),
  AGENT_COMPLAINTS_SECRET: z.string().optional(),
  // Secret for encrypting Slack bot tokens at rest (AES-256-GCM). Falls back to
  // JWT_ACCESS_SECRET when unset so no extra config is required in dev.
  SLACK_TOKEN_SECRET: z.string().optional(),
  // Pepper for the password-reuse fingerprint (HMAC-SHA256). Keep it OUT of the database
  // and back it up: change it and every stored fingerprint stops matching, so reuse
  // detection silently degrades until users next set a password. Falls back to
  // JWT_ACCESS_SECRET so no extra config is required in dev.
  PASSWORD_PEPPER: z.string().optional(),
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
  // Web Push (VAPID, RFC 8292). Optional: when unset, push sending is disabled and
  // the API responds 503 PUSH_NOT_CONFIGURED. Generate with:
  //   npx web-push generate-vapid-keys
  // VAPID_PRIVATE_KEY is a SECRET — it is never sent to the client or logged.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@banihal.in'),
});

const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:\n', result.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = result.data;
