import { Router, Request, Response, NextFunction } from 'express';
import { prisma, customerContext } from '../../config/database';
import { requirePermission } from '../../middleware/rbac.middleware';
import { audit } from '../../lib/audit';
import { rotateAgentKey, provisionSquidProxy, disableSquidProxy } from './squid.service';
import { notify } from '../notifications/notifications.service';
import { squidControlRoutes } from './squidControl.routes';
import { z } from 'zod';

// ─── Staff squid console (mounted at /api/saas-admin/squid) ─────────────────
// Cross-tenant connection management and ticket requests only. All
// reads/mutations escape the tenant scope via customerContext.exit — the tenant
// extension would otherwise quietly filter to the caller's own (provider) org.
// Guards: squid.view reads, squid.manage mutations.
// Access: ADMINISTRATION and EMPLOYEE roles (excludes INTERN and HR_ADMIN)

const router = Router();
router.use(squidControlRoutes(true));

const whereFromQuery = (q: Request['query']) => ({
  ...(typeof q.customerId === 'string' && q.customerId ? { customerId: q.customerId } : {}),
  ...(typeof q.status === 'string' && q.status
    ? { status: q.status as 'UNPROVISIONED' | 'PENDING' | 'CONNECTED' | 'OFFLINE' | 'DISABLED' | 'ERROR' }
    : {}),
  ...(typeof q.search === 'string' && q.search ? { name: { contains: q.search, mode: 'insensitive' as const } } : {}),
});

// ─── Read operations (squid.view) ────────────────────────────────────────────

router.get('/', requirePermission('squid.view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const where = whereFromQuery(req.query);
    const [proxies, total] = await Promise.all([
      customerContext.exit(() => prisma.squidProxy.findMany({
        where, orderBy: { createdAt: 'desc' }, take: 200,
        select: {
          id: true, name: true, customerId: true, status: true, lastSeenAt: true,
          revision: true, appliedSeq: true, locked: true, registrationHint: true, createdAt: true,
          customer: { select: { name: true, slug: true } },
        },
      })),
      customerContext.exit(() => prisma.squidProxy.count({ where })),
    ]);
    res.json({ proxies, total });
  } catch (e) { next(e); }
});

// Change requests for platform admin view
router.get('/:proxyId/change-requests', requirePermission('squid.view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await customerContext.exit(() => prisma.squidChangeRequest.findMany({
      where: { proxyId: req.params['proxyId']! },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }));
    res.json({ changeRequests: rows });
  } catch (e) { next(e); }
});

// ─── Mutations (squid.manage) ────────────────────────────────────────────────

// Rotate agent registration key
router.post('/:proxyId/rotate-key', requirePermission('squid.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const proxy = await customerContext.exit(() => prisma.squidProxy.findUnique({ where: { id: req.params['proxyId']! }, select: { customerId: true } }));
    if (!proxy) { res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' }); return; }
    const { raw, hint } = await rotateAgentKey(req.params['proxyId']!, req.user.userId, proxy.customerId);
    res.json({ raw, hint });
  } catch (e) { next(e); }
});

// Enable/disable proxy
router.post('/:proxyId/enable', requirePermission('squid.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const proxy = await customerContext.exit(() => prisma.squidProxy.findUnique({ where: { id: req.params['proxyId']! }, select: { id: true, customerId: true, name: true } }));
    if (!proxy) { res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' }); return; }
    await customerContext.exit(() => prisma.squidProxy.update({ where: { id: proxy.id }, data: { status: 'PENDING', locked: false, lastError: null } }));
    await audit({ action: 'SQUID_PROXY_ENABLED', performedById: req.user.userId, customerId: proxy.customerId, targetId: proxy.id, metadata: { proxy: proxy.name } });
    const admins = await customerContext.exit(() => prisma.user.findMany({ where: { customerId: proxy.customerId, role: 'ORG_ADMIN' }, select: { id: true } }));
    for (const a of admins) {
      await notify({ userId: a.id, customerId: proxy.customerId, kind: 'squid_proxy', title: `Proxy “${proxy.name}” re-enabled.`, url: '/squid' }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Provision a new squid proxy for an organization (platform admin action)
router.post('/provision', requirePermission('squid.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { customerId, name, customerServiceId } = z.object({ customerId: z.string().min(1).max(100), name: z.string().trim().min(2).max(32).regex(/^[a-zA-Z0-9_-]+$/), customerServiceId: z.string().min(1).optional() }).strict().parse(req.body);
    
    if (!customerId || !name) {
      res.status(400).json({ error: 'customerId and name are required', code: 'VALIDATION_ERROR' });
      return;
    }

    // Verify customer exists
    const customer = await customerContext.exit(() => prisma.customer.findUnique({ where: { id: customerId } }));
    if (!customer) {
      res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
      return;
    }

    if (customerServiceId && !await prisma.customerService.findFirst({ where: { id: customerServiceId, customerId } })) {
      res.status(400).json({ error: 'Service does not belong to this client', code: 'SERVICE_CUSTOMER_MISMATCH' }); return;
    }

    const result = await provisionSquidProxy(customerId, customerServiceId ?? '', name, req.user.userId);
    
    await audit({
      action: 'SQUID_PROXY_PROVISIONED',
      performedById: req.user.userId,
      customerId,
      targetId: result.proxy.id,
      metadata: { 
        proxy: result.proxy.name, 
        hint: result.hint,
        customerServiceId: customerServiceId ?? null 
      },
    });

    res.json({ 
      proxy: { id: result.proxy.id, name: result.proxy.name, customerId: result.proxy.customerId, status: result.proxy.status },
      key: result.key, 
      hint: result.hint,
      message: 'Proxy provisioned. Provide the registration key to the organization to install the agent.'
    });
  } catch (e) { next(e); }
});

// Reassign proxy to a different organization
router.post('/:proxyId/reassign', requirePermission('squid.manage'), (_req: Request, res: Response) => {
  res.status(409).json({ error: 'Provision a new proxy identity for the receiving organisation; existing identities retain their client history.', code: 'SQUID_REENROLL_REQUIRED' });
});

// Disable proxy (soft delete - marks as DISABLED and LOCKED)
router.post('/:proxyId/disable', requirePermission('squid.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = req.body as { reason?: string };
    
    const proxy = await customerContext.exit(() => prisma.squidProxy.findUnique({ 
      where: { id: req.params['proxyId']! },
      select: { id: true, customerId: true, name: true, customerServiceId: true }
    }));
    if (!proxy) { res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' }); return; }

    await disableSquidProxy(proxy.id, req.user.userId, proxy.customerId, reason ?? 'Disabled by platform admin');
    
    res.json({ ok: true, message: 'Proxy disabled and config locked' });
  } catch (e) { next(e); }
});

// Delete proxy (only if not service-managed)
router.delete('/:proxyId', requirePermission('squid.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const proxy = await customerContext.exit(() => prisma.squidProxy.findUnique({ 
      where: { id: req.params['proxyId']! },
      select: { id: true, customerId: true, name: true, customerServiceId: true }
    }));
    if (!proxy) { res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' }); return; }

    if (proxy.customerServiceId) {
      res.status(409).json({ 
        error: 'This proxy is provisioned by a purchased service. Remove the service to disable it, then delete.', 
        code: 'SQUID_MANAGED' 
      });
      return;
    }

    await customerContext.exit(() => prisma.squidProxy.delete({ where: { id: proxy.id } }));
    
    await audit({ 
      action: 'SQUID_PROXY_DELETED', 
      performedById: req.user.userId, 
      customerId: proxy.customerId, 
      targetId: proxy.id, 
      metadata: { proxy: proxy.name } 
    });

    res.json({ ok: true, message: 'Proxy deleted' });
  } catch (e) { next(e); }
});

export default router;
