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
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  // Refresh tokens are NOT JWTs — they are 64 CSPRNG bytes stored SHA-256 hashed
  // (auth.service.createRefreshToken), so there is no refresh signing secret. This
  // value is the only thing that sets their lifetime, and the refresh cookie's
  // Max-Age is derived from the same number so the two cannot drift.
  JWT_REFRESH_EXPIRES_IN: z.string().regex(/^\d+[smhd]$/, 'Use a duration like 7d, 12h, 30m').default('7d'),
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
  // Matches the agent's own 180s ceiling, and for a reason beyond patience:
  // abandoning early does NOT free the agent. It keeps generating in its single
  // slot, so a short deadline turns one slow answer into 429 server_busy for
  // every user behind it. Measured 2026-09-01: ~20s for an end_user answer,
  // ~80s for an l3 one — a 15s budget failed literally every real question.
  AGENT_CHAT_TIMEOUT_MS: z.coerce.number().min(1000).default(180_000),
  AGENT_CHAT_CLIENT_ID: z.string().optional(),
  AGENT_CHAT_SECRET: z.string().optional(),

  // Top-complaints credential (`dc-*`) — issued SEPARATELY from the chat one;
  // a chat credential will not authenticate against /v1/top-complaints.
  AGENT_COMPLAINTS_CLIENT_ID: z.string().optional(),
  AGENT_COMPLAINTS_SECRET: z.string().optional(),
  // Secret for encrypting Slack bot tokens at rest (AES-256-GCM). Falls back to
  // JWT_ACCESS_SECRET when unset so no extra config is required in dev.
  SLACK_TOKEN_SECRET: z.string().optional(),
  // Ed25519 seed (64 hex chars) that signs squid config bundles for the agents.
  // Optional: derived from SLACK_TOKEN_SECRET in dev/test, but every prod
  // deployment must set its own and pin signingPublicKeyPem() into the agents.
  SQUID_SIGNING_PRIVATE_KEY: z.string().length(64).optional(),
  // Pepper for the password-reuse fingerprint (HMAC-SHA256). Keep it OUT of the database
  // and back it up: change it and every stored fingerprint stops matching, so reuse
  // detection silently degrades until users next set a password. Falls back to
  // JWT_ACCESS_SECRET so no extra config is required in dev.
  PASSWORD_PEPPER: z.string().optional(),
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
  // Organization approval: the code a staff member reads to a new org's admin.
  // The TTL is short by design — it is handed over during a live conversation, and
  // the org admin can request a fresh one (subject to the cooldown) if the call runs
  // long. Attempts are capped for the same reason MFA's are: 6 digits only resist
  // guessing while the number of guesses is bounded.
  ORG_APPROVAL_TTL_MINUTES: z.coerce.number().min(1).default(10),
  ORG_APPROVAL_MAX_ATTEMPTS: z.coerce.number().min(1).default(5),
  ORG_APPROVAL_RESEND_COOLDOWN_SECONDS: z.coerce.number().min(0).default(60),
  // Web Push (VAPID, RFC 8292). Optional: when unset, push sending is disabled and
  // the API responds 503 PUSH_NOT_CONFIGURED. Generate with:
  //   npx web-push generate-vapid-keys
  // VAPID_PRIVATE_KEY is a SECRET — it is never sent to the client or logged.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@banihal.in'),

  // ─── Redis (lib/redis.ts) ─────────────────────────────────────────────────
  // Backs three things: the aggregate-read cache, the rate-limit store, and the
  // agent's one-call-at-a-time lock. OPTIONAL by design — when unset, all three
  // fall back to their in-process behaviour (call straight through, memory store,
  // in-process lane), so dev and the test suite need no Redis and a Redis outage
  // degrades the app instead of stopping it.
  REDIS_URL: z.string().url().optional(),

  // Which upstream addresses Express may believe an `X-Forwarded-For` from.
  // Passed straight to `app.set('trust proxy', …)`, so it takes any value that
  // setting takes: 'loopback', a CIDR, or a comma-separated list.
  //
  // Default 'loopback' is today's bare-metal deployment (nginx on the same host).
  // Containerized, nginx reaches the API from its address on the podman network,
  // which is NOT loopback — leave this at the default there and Express stops
  // trusting the header, collapsing every IP-keyed rate limiter into ONE bucket
  // keyed on nginx's container IP. Set it to the podman network's CIDR.
  //
  // Never set this to 'true'. That trusts a client-supplied X-Forwarded-For and
  // makes the limiters bypassable by anyone who sends the header.
  TRUST_PROXY: z.string().default('loopback'),
});

const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:\n', result.error.flatten().fieldErrors);
  process.exit(1);
}

/**
 * Key separation, enforced in production only.
 *
 * SLACK_TOKEN_SECRET and PASSWORD_PEPPER fall back to JWT_ACCESS_SECRET so a dev
 * checkout needs no extra config. In production that fallback is a hazard rather
 * than a convenience: one key would sign JWTs, encrypt Slack bot tokens under
 * AES-256-GCM, and pepper password fingerprints — so rotating the JWT secret (a
 * routine operation) would silently make every stored Slack token undecryptable
 * and every reuse fingerprint stop matching.
 *
 * NOTE for existing deployments relying on the fallback: set these to the CURRENT
 * value of JWT_ACCESS_SECRET, or already-encrypted Slack tokens will not decrypt.
 */
if (result.data.NODE_ENV === 'production') {
  const missing = (['SLACK_TOKEN_SECRET', 'PASSWORD_PEPPER'] as const).filter((k) => !result.data[k]);
  if (missing.length) {
    console.error(
      `❌ ${missing.join(' and ')} must be set in production — they must not fall back to JWT_ACCESS_SECRET.\n` +
      '   Migrating an existing deployment? Set them to the CURRENT JWT_ACCESS_SECRET value,\n' +
      '   otherwise stored Slack tokens stop decrypting and password-reuse detection resets.',
    );
    process.exit(1);
  }
}

/** "7d" | "12h" | "30m" | "45s" → milliseconds. Format is validated by the schema. */
function durationMs(v: string): number {
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[v.slice(-1)]!;
  return parseInt(v, 10) * unit;
}

export const env = {
  ...result.data,
  /** Refresh-token lifetime in ms — drives both the DB row and the cookie Max-Age. */
  JWT_REFRESH_EXPIRES_MS: durationMs(result.data.JWT_REFRESH_EXPIRES_IN),
};
