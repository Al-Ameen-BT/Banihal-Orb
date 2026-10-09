import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { corsOptions } from './config/security';
import { env } from './config/env';
import { prisma } from './config/database';
import { chatPrisma } from './config/chatDatabase';
import { ticketPrisma, adminTicketPrisma } from './config/ticketDatabase';
import { globalRateLimiter } from './middleware/rateLimiter';
import { authMiddleware } from './middleware/auth.middleware';
import { tenantMiddleware } from './middleware/tenant.middleware';
import { requireRole } from './middleware/rbac.middleware';
import { errorHandler } from './middleware/errorHandler';

import authRoutes from './modules/auth/auth.routes';
import usersRoutes from './modules/users/users.routes';
import orgsRoutes from './modules/organizations/organizations.routes';
import saasAdminRoutes from './modules/saas-admin/saas-admin.routes';
import chatRoutes from './modules/chat/chat.routes';
import requestsRoutes from './modules/requests/requests.routes';
import announcementsRoutes from './modules/announcements/announcements.routes';
import ticketingRoutes from './modules/ticketing/ticketing.routes';
import slackBotsRoutes from './modules/slack-bots/slackBots.routes';
import slackLinkRoutes from './modules/slack-bots/slackLink.routes';
import botsRoutes from './modules/bots/bots.routes';
import adIngestRoutes from './modules/ad-secrets/adIngest.routes';
import adSecretsRoutes from './modules/ad-secrets/adSecrets.routes';
import externalRoutes from './modules/external-api/external.routes';
import externalAdminRoutes from './modules/external-api/external-admin.routes';
import pushRoutes from './modules/push/push.routes';
import notificationsRoutes from './modules/notifications/notifications.routes';
import agentRoutes from './modules/agent/agent.routes';
import proxyAgentRoutes from './modules/squid/squid-agent.routes';
import botWorkerRoutes from './modules/slack-bots/botWorker.routes';
import squidRoutes from './modules/squid/squid.routes';
import squidAdminRoutes from './modules/squid/squid-admin.routes';

const app = express();

// Trust the reverse proxy (Nginx) so req.ip reflects the real client via
// X-Forwarded-For — otherwise every request appears to come from the proxy and
// the IP-keyed rate limiters collapse into a single shared bucket.
//
// Configurable because the proxy's address depends on the deployment: 'loopback'
// (the default) is correct for nginx on the same host, but under Podman nginx
// reaches the API from its address on the container network, which is not
// loopback — leave it at the default there and every limiter silently degrades
// with nothing in the logs. See TRUST_PROXY in config/env.ts.
app.set('trust proxy', env.TRUST_PROXY);

// ─── Global security middleware ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
}));
app.use(cors(corsOptions));
app.use(globalRateLimiter);
app.use(cookieParser());
// verify() keeps the raw body bytes around so the squid agent's per-request
// HMAC can cover the exact payload (the agent signs sha256(rawBody)); a parsed
// JSON re-serialization would not be stable between signer and verifier.
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; } }));

// ─── Public routes (no auth required) ───────────────────────────────────────
app.use('/api/auth', authRoutes);
// AD-automation machine ingest — authenticated by a per-bot API key (NOT a
// session), so it is mounted before the cookie auth middleware.
app.use('/api/ad-ingest', adIngestRoutes);
// External ticketing API — machine clients authenticate with OAuth client
// credentials (Bearer JWTs), so this must sit outside the cookie session wall.
app.use('/api/external', externalRoutes);
// Squid per-proxy agents — machines authenticate per request with an HMAC signed
// off their raw registration key; like /api/external this predates the session wall.
app.use('/api/proxy-agent', proxyAgentRoutes);
// Remote Slack bot host-workers — machines authenticate per request with their
// `wrk_` worker key (Bearer + HMAC). Same rationale: a machine, not a session.
app.use('/api/bot-worker', botWorkerRoutes);

// ─── Health check ────────────────────────────────────────────────────────────
// Pings the stores the app actually SERVES FROM. It used to ping b2b_ticketing —
// which nothing but this line and the boot $connect still reads — while the two
// stores every ticketing request depends on (b2b_ticket and b2b_ticketing_admin)
// went unmonitored, so the whole ticketing module could be down and /health green.
app.get('/health', async (_req, res) => {
  const ping = async (fn: () => Promise<unknown>): Promise<'connected' | 'down'> => {
    try { await fn(); return 'connected'; } catch { return 'down'; }
  };
  const [main, chat, ticket, ticketAdmin] = await Promise.all([
    ping(() => prisma.$queryRaw`SELECT 1`),
    ping(() => chatPrisma.$queryRaw`SELECT 1`),
    ping(() => ticketPrisma.$queryRaw`SELECT 1`),
    ping(() => adminTicketPrisma.$queryRaw`SELECT 1`),
  ]);
  const databases = { main, chat, ticket, ticketAdmin };
  const ok = Object.values(databases).every((s) => s === 'connected');
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', databases });
});

// ─── Protected routes ────────────────────────────────────────────────────────
app.use('/api', authMiddleware as express.RequestHandler);

// Tenant-scoped routes: inject orgId into Prisma context
const withTenant = tenantMiddleware as express.RequestHandler;
app.use('/api/users', withTenant, usersRoutes);
app.use('/api/organizations', withTenant, orgsRoutes);
app.use('/api/chat', withTenant, chatRoutes);
// Signed /v1 agent API (one-shot role-scoped chat + complaint analytics). Distinct
// from /api/chat above, which streams the agent's unsigned SSE endpoint.
app.use('/api/agent', withTenant, agentRoutes);
app.use('/api/requests', withTenant, requestsRoutes);
app.use('/api/announcements', withTenant, announcementsRoutes);
app.use('/api/ticketing', withTenant, ticketingRoutes);
// Org-facing Slack bots — this org's assigned bots + create bot-assigned tickets.
app.use('/api/bots', withTenant, botsRoutes);
// Secure AD credential reveal — target user or requesting org-admin only.
app.use('/api/ad-secrets', withTenant, adSecretsRoutes);
// Web Push subscriptions — auth only (scoped explicitly by userId/tenantId, so no
// tenant middleware; PushSubscription is excluded from the tenant Prisma extension).
app.use('/api/push', pushRoutes);
// Durable per-user notifications (read state lives in the DB, not localStorage).
// withTenant so the tenant extension scopes reads; the service additionally
// filters by userId, which is what keeps one member out of another's list.
app.use('/api/notifications', withTenant, notificationsRoutes);
// Org-facing squid proxy management — tenant-scoped; per-route role guards inside.
app.use('/api/squid', withTenant, squidRoutes);

// Sadmin / Administrator — platform-level access, no tenant scope
app.use('/api/saas-admin', requireRole('ADMINISTRATOR'), saasAdminRoutes);
// Slack bot registry — administrators manage bots cross-tenant (no tenant scope).
app.use('/api/slack-bots', requireRole('ADMINISTRATOR'), slackBotsRoutes);
// User-facing Slack identity link — any authenticated member can issue a
// one-time code for their own profile.
app.use('/api/slack/link', slackLinkRoutes);
// External ticketing API key/webhook registry — administrators manage machine
// credentials cross-tenant (no tenant scope; same mount pattern as slack-bots).
app.use('/api/external-admin', requireRole('ADMINISTRATOR'), externalAdminRoutes);
// Steam squid management — Administrators view/edit any org's squid config
// cross-tenant (no tenant scope). Guarded per-route by squid.view / squid.manage.
app.use('/api/saas-admin/squid', requireRole('ADMINISTRATOR'), squidAdminRoutes);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use(errorHandler as express.ErrorRequestHandler);

export default app;
