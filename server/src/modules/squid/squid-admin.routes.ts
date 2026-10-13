import { Router, Request, Response, NextFunction } from 'express';
import { prisma, customerContext } from '../../config/database';
import { requirePermission } from '../../middleware/rbac.middleware';
import { audit } from '../../lib/audit';
import { rotateAgentKey, provisionSquidProxy, disableSquidProxy } from './squid.service';
import { notify } from '../notifications/notifications.service';

// ─── Staff squid console (mounted at /api/saas-admin/squid) ─────────────────
// Cross-tenant by design: ADMINISTRATOR staff view/edit ANY org's squid. All
// reads/mutations escape the tenant scope via customerContext.exit — the tenant
// extension would otherwise quietly filter to the caller's own (provider) org.
// Guards: squid.view reads, squid.manage mutations.
// Access: ADMINISTRATION and EMPLOYEE roles (excludes INTERN and HR_ADMIN)

const router = Router();

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
          _count: { select: { branches: true } },
        },
      })),
      customerContext.exit(() => prisma.squidProxy.count({ where })),
    ]);
    res.json({ proxies, total });
  } catch (e) { next(e); }
});

router.get('/:proxyId', requirePermission('squid.view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const proxy = await customerContext.exit(() => prisma.squidProxy.findUnique({
      where: { id: req.params['proxyId']! },
      include: {
        customer: { select: { id: true, name: true, slug: true } },
        branches: { orderBy: { createdAt: 'asc' } },
        customerService: { select: { id: true, name: true, endDate: true, monthlyPrice: true } },
      },
    }));
    if (!proxy) { res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' }); return; }
    const { regKeyEncrypted: _forbidden, regKeyHash: _forbidden2, ...safe } = proxy;
    res.json(safe);
  } catch (e) { next(e); }
});

// Read-only host config mirror (the squid config actually applied on the bot
// host). Cross-tenant — no tenant scope on this mount, just squid.view.
router.get('/:proxyId/host-config', requirePermission('squid.view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cfg = await customerContext.exit(() => prisma.squidHostConfig.findUnique({ where: { proxyId: req.params['proxyId']! } }));
    if (!cfg) { res.status(404).json({ error: 'No host config reported yet', code: 'NOT_FOUND' }); return; }
    res.json({ hash: cfg.hash, capturedAt: cfg.capturedAt.toISOString(), files: cfg.files });
  } catch (e) { next(e); }
});

// Telemetry for platform admin view
router.get('/:proxyId/telemetry', requirePermission('squid.view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await customerContext.exit(() => prisma.squidTelemetry.findFirst({
      where: { proxyId: req.params['proxyId']! },
      orderBy: { observedAt: 'desc' },
    }));
    res.json(summary ?? { message: 'No telemetry yet' });
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

// Lock/unlock proxy config (suspend/resume)
router.post('/:proxyId/lock', requirePermission('squid.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const proxy = await customerContext.exit(() => prisma.squidProxy.findUnique({ where: { id: req.params['proxyId']! }, select: { id: true, customerId: true, name: true, locked: true } }));
    if (!proxy) { res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' }); return; }
    const locked = req.body?.locked === true;
    await customerContext.exit(() => prisma.squidProxy.update({ where: { id: proxy.id }, data: { locked: req.body?.locked === true } }));
    await audit({ action: 'SQUID_CONFIG_LOCKED', performedById: req.user.userId, customerId: proxy.customerId, targetId: proxy.id, metadata: { proxy: proxy.name, locked } });
    res.json({ ok: true, locked });
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
    const { customerId, name, customerServiceId } = req.body as { customerId: string; name: string; customerServiceId?: string };
    
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
      proxy: result.proxy, 
      key: result.key, 
      hint: result.hint,
      message: 'Proxy provisioned. Provide the registration key to the organization to install the agent.'
    });
  } catch (e) { next(e); }
});

// Reassign proxy to a different organization
router.post('/:proxyId/reassign', requirePermission('squid.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { customerId } = req.body as { customerId: string };
    
    if (!customerId) {
      res.status(400).json({ error: 'customerId is required', code: 'VALIDATION_ERROR' });
      return;
    }

    const proxy = await customerContext.exit(() => prisma.squidProxy.findUnique({ 
      where: { id: req.params['proxyId']! },
      select: { id: true, customerId: true, name: true, customerServiceId: true }
    }));
    if (!proxy) { res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' }); return; }

    // Verify new customer exists
    const customer = await customerContext.exit(() => prisma.customer.findUnique({ where: { id: customerId } }));
    if (!customer) {
      res.status(404).json({ error: 'Organization not found', code: 'NOT_FOUND' });
      return;
    }

    // If proxy is service-managed, prevent reassignment
    if (proxy.customerServiceId) {
      res.status(409).json({ 
        error: 'Cannot reassign a service-managed proxy. Disable the service first.', 
        code: 'SQUID_MANAGED' 
      });
      return;
    }

    await customerContext.exit(() => prisma.squidProxy.update({ 
      where: { id: proxy.id }, 
      data: { customerId } 
    }));

    await audit({ 
      action: 'SQUID_PROXY_REASSIGNED', 
      performedById: req.user.userId, 
      customerId: proxy.customerId, 
      targetId: proxy.id, 
      metadata: { 
        proxy: proxy.name, 
        fromCustomerId: proxy.customerId, 
        toCustomerId: customerId 
      } 
    });

    // Notify both organizations
    const adminsFrom = await customerContext.exit(() => prisma.user.findMany({ 
      where: { customerId: proxy.customerId, role: 'ORG_ADMIN' }, 
      select: { id: true } 
    }));
    const adminsTo = await customerContext.exit(() => prisma.user.findMany({ 
      where: { customerId, role: 'ORG_ADMIN' }, 
      select: { id: true } 
    }));
    
    for (const a of [...adminsFrom, ...adminsTo]) {
      await notify({ 
        userId: a.id, 
        customerId: a.id === adminsFrom[0]?.id ? proxy.customerId : customerId, 
        kind: 'squid_proxy', 
        title: `Proxy “${proxy.name}” reassigned to ${customer.name}.`, 
        url: '/squid' 
      }).catch(() => {});
    }

    res.json({ ok: true, message: `Proxy reassigned to ${customer.name}` });
  } catch (e) { next(e); }
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

// Service lifecycle controls from platform admin
router.post('/:proxyId/reload', requirePermission('squid.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const proxy = await customerContext.exit(() => prisma.squidProxy.findUnique({ where: { id: req.params['proxyId']! }, select: { customerId: true } }));
    if (!proxy) { res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' }); return; }
    
    const { bumpRevision } = await import('./squid.service');
    await bumpRevision(req.params['proxyId']!);
    
    await audit({ action: 'SQUID_RELOAD_REQUESTED', performedById: req.user.userId, customerId: proxy.customerId, targetId: req.params['proxyId']!, metadata: { triggeredBy: 'platform_admin' } });
    
    res.json({ ok: true, message: 'Config reload triggered — agent will pull on next poll' });
  } catch (e) { next(e); }
});

router.post('/:proxyId/restart', requirePermission('squid.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const proxy = await customerContext.exit(() => prisma.squidProxy.findUnique({ where: { id: req.params['proxyId']! }, select: { customerId: true } }));
    if (!proxy) { res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' }); return; }
    
    const { bumpRevision } = await import('./squid.service');
    await bumpRevision(req.params['proxyId']!);
    
    await audit({ action: 'SQUID_RESTART_REQUESTED', performedById: req.user.userId, customerId: proxy.customerId, targetId: req.params['proxyId']!, metadata: { triggeredBy: 'platform_admin' } });
    
    res.json({ ok: true, message: 'Restart triggered — agent will restart squid on next poll' });
  } catch (e) { next(e); }
});

router.post('/:proxyId/rescan', requirePermission('squid.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const proxy = await customerContext.exit(() => prisma.squidProxy.findUnique({ where: { id: req.params['proxyId']! }, select: { customerId: true } }));
    if (!proxy) { res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' }); return; }
    
    const { bumpRevision } = await import('./squid.service');
    await bumpRevision(req.params['proxyId']!);
    
    await audit({ action: 'SQUID_RESCAN_REQUESTED', performedById: req.user.userId, customerId: proxy.customerId, targetId: req.params['proxyId']!, metadata: { triggeredBy: 'platform_admin' } });
    
    res.json({ ok: true, message: 'ACL rescan triggered — agent will re-read config files on next poll' });
  } catch (e) { next(e); }
});

// Bandwidth metrics for platform admin
router.get('/:proxyId/bandwidth', requirePermission('squid.view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const minutes = req.query.minutes ? parseInt(req.query.minutes as string, 10) : 60;
    const { getBandwidthMetrics } = await import('./squid.service');
    const result = await getBandwidthMetrics(req.params['proxyId']!, minutes);
    res.json(result);
  } catch (e) { next(e); }
});

// Certificate status for platform admin
router.get('/:proxyId/certificates', requirePermission('squid.view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getCertificateStatus } = await import('./squid.service');
    const result = await getCertificateStatus(req.params['proxyId']!);
    res.json(result);
  } catch (e) { next(e); }
});

// Certificate management
router.post('/:proxyId/certificates/ca', requirePermission('squid.manage'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Delegate to org controller which has the implementation
    res.json({ message: 'Use org-facing endpoint for CA generation' });
  } catch (e) { next(e); }
});

router.post('/:proxyId/certificates/import', requirePermission('squid.manage'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ message: 'Use org-facing endpoint for certificate import' });
  } catch (e) { next(e); }
});

router.post('/:proxyId/certificates/csr', requirePermission('squid.manage'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ message: 'Use org-facing endpoint for CSR generation' });
  } catch (e) { next(e); }
});

// Backup & Restore
router.post('/:proxyId/backups', requirePermission('squid.manage'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ message: 'Use org-facing endpoint for backup creation' });
  } catch (e) { next(e); }
});

router.get('/:proxyId/backups', requirePermission('squid.view'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ message: 'Use org-facing endpoint for backup listing' });
  } catch (e) { next(e); }
});

router.post('/:proxyId/backups/:backupId/restore', requirePermission('squid.manage'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ message: 'Use org-facing endpoint for backup restore' });
  } catch (e) { next(e); }
});

router.post('/:proxyId/factory-reset', requirePermission('squid.manage'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ message: 'Use org-facing endpoint for factory reset' });
  } catch (e) { next(e); }
});

// Package status
router.get('/:proxyId/package-status', requirePermission('squid.view'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ message: 'Use org-facing endpoint for package status' });
  } catch (e) { next(e); }
});

export default router;