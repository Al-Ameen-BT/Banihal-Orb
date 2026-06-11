import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { corsOptions } from './config/security';
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

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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

// Sadmin / Administrator — platform-level access, no tenant scope
app.use('/api/saas-admin', requireRole('ADMINISTRATOR'), saasAdminRoutes);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use(errorHandler as express.ErrorRequestHandler);

export default app;
