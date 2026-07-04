import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { corsOptions } from './config/security';
import { prisma } from './config/database';
import { chatPrisma } from './config/chatDatabase';
import { ticketingPrisma } from './config/ticketingDatabase';
import { globalRateLimiter } from './middleware/rateLimiter';
import { authMiddleware } from './middleware/auth.middleware';
import { tenantMiddleware } from './middleware/tenant.middleware';
import { requireRole } from './middleware/rbac.middleware';
import { errorHandler } from './middleware/errorHandler';

import authRoutes from './modules/auth/auth.routes';
import usersRoutes from './modules/users/users.routes';
import orgsRoutes from './modules/organizations/organizations.routes';
import dashboardRoutes from './modules/dashboard/dashboard.routes';
import saasAdminRoutes from './modules/saas-admin/saas-admin.routes';
import chatRoutes from './modules/chat/chat.routes';
import requestsRoutes from './modules/requests/requests.routes';
import announcementsRoutes from './modules/announcements/announcements.routes';
import ticketingRoutes from './modules/ticketing/ticketing.routes';
import slackBotsRoutes from './modules/slack-bots/slackBots.routes';
import botsRoutes from './modules/bots/bots.routes';
import adIngestRoutes from './modules/ad-secrets/adIngest.routes';
import adSecretsRoutes from './modules/ad-secrets/adSecrets.routes';

const app = express();

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
app.use(express.json({ limit: '1mb' }));

// ─── Public routes (no auth required) ───────────────────────────────────────
app.use('/api/auth', authRoutes);
// AD-automation machine ingest — authenticated by a per-bot API key (NOT a
// session), so it is mounted before the cookie auth middleware.
app.use('/api/ad-ingest', adIngestRoutes);

// ─── Health check (verifies all three databases) ─────────────────────────────
app.get('/health', async (_req, res) => {
  const ping = async (fn: () => Promise<unknown>): Promise<'connected' | 'down'> => {
    try { await fn(); return 'connected'; } catch { return 'down'; }
  };
  const [main, chat, ticketing] = await Promise.all([
    ping(() => prisma.$queryRaw`SELECT 1`),
    ping(() => chatPrisma.$queryRaw`SELECT 1`),
    ping(() => ticketingPrisma.$queryRaw`SELECT 1`),
  ]);
  const ok = main === 'connected' && chat === 'connected' && ticketing === 'connected';
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    databases: { main, chat, ticketing },
  });
});

// ─── Protected routes ────────────────────────────────────────────────────────
app.use('/api', authMiddleware as express.RequestHandler);

// Tenant-scoped routes: inject orgId into Prisma context
const withTenant = tenantMiddleware as express.RequestHandler;
app.use('/api/users', withTenant, usersRoutes);
app.use('/api/organizations', withTenant, orgsRoutes);
app.use('/api/dashboard', withTenant, dashboardRoutes);
app.use('/api/chat', withTenant, chatRoutes);
app.use('/api/requests', withTenant, requestsRoutes);
app.use('/api/announcements', withTenant, announcementsRoutes);
app.use('/api/ticketing', withTenant, ticketingRoutes);
// Org-facing Slack bots — this org's assigned bots + create bot-assigned tickets.
app.use('/api/bots', withTenant, botsRoutes);
// Secure AD credential reveal — target user or requesting org-admin only.
app.use('/api/ad-secrets', withTenant, adSecretsRoutes);

// Sadmin / Administrator — platform-level access, no tenant scope
app.use('/api/saas-admin', requireRole('ADMINISTRATOR'), saasAdminRoutes);
// Slack bot registry — administrators manage bots cross-tenant (no tenant scope).
app.use('/api/slack-bots', requireRole('ADMINISTRATOR'), slackBotsRoutes);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use(errorHandler as express.ErrorRequestHandler);

export default app;
