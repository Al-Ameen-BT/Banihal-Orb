import { Router, Request, Response, NextFunction } from 'express';
import { prisma, customerContext } from '../../config/database';
import { requirePermission } from '../../middleware/rbac.middleware';
import { audit } from '../../lib/audit';
import { rotateAgentKey } from './squid.service';
import { notify } from '../notifications/notifications.service';

// ─── Staff squid console (mounted at /api/saas-admin/squid) ─────────────────
// Cross-tenant by design: ADMINISTRATOR staff view/edit ANY org's squid. All
// reads/mutations escape the tenant scope via customerContext.exit — the tenant
// extension would otherwise quietly filter to the caller's own (provider) org.
// Guards: squid.view reads, squid.manage mutations.

const router = Router();

const whereFromQuery = (q: Request['query']) => ({
  ...(typeof q.customerId === 'string' && q.customerId ? { customerId: q.customerId } : {}),
  ...(typeof q.status === 'string' && q.status
    ? { status: q.status as 'UNPROVISIONED' | 'PENDING' | 'CONNECTED' | 'OFFLINE' | 'DISABLED' | 'ERROR' }
    : {}),
  ...(typeof q.search === 'string' && q.search ? { name: { contains: q.search, mode: 'insensitive' as const } } : {}),
});

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

// ─── Mutations (squid.manage) ────────────────────────────────────────────────
router.post('/:proxyId/rotate-key', requirePermission('squid.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const proxy = await customerContext.exit(() => prisma.squidProxy.findUnique({ where: { id: req.params['proxyId']! }, select: { customerId: true } }));
    if (!proxy) { res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' }); return; }
    const { raw, hint } = await rotateAgentKey(req.params['proxyId']!, req.user.userId, proxy.customerId);
    res.json({ raw, hint });
  } catch (e) { next(e); }
});

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

export default router;