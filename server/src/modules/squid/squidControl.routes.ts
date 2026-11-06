import { Router } from 'express';
import { z } from 'zod';
import { prisma, customerContext } from '../../config/database';
import { requirePermission, requirePermissionIfPlatform, requireRole } from '../../middleware/rbac.middleware';
import { audit } from '../../lib/audit';
import { automationState, setAutomationPause } from './squidAutomation';
import { BotChangeRequestSchema } from './squid.schema';
import { requestProxyChange } from './squidBot.service';

const PauseSchema = z.object({ paused: z.boolean(), reason: z.string().trim().min(3).max(300) }).strict();
const EnrollmentSchema = z.object({ certificateSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).transform(s => s.toLowerCase()), enabled: z.boolean().default(true) }).strict();

export function squidControlRoutes(platform: boolean): Router {
  const router = Router();
  const view = platform ? [requireRole('ADMINISTRATOR'), requirePermission('squid.view')] : [requireRole('ORG_ADMIN'), requirePermissionIfPlatform('squid.view')];
  const manage = platform ? [requireRole('ADMINISTRATOR'), requirePermission('squid.manage')] : [requireRole('ORG_ADMIN'), requirePermissionIfPlatform('squid.manage')];
  const ownedProxy = async (id: string, customerId: string) => {
    const proxy = await prisma.squidProxy.findUnique({ where: { id }, select: { id: true, name: true, customerId: true } });
    return proxy && (platform || proxy.customerId === customerId) ? proxy : null;
  };
  if (platform) {
    router.get('/clients', ...view, async (_req, res, next) => {
      try { res.json({ clients: await customerContext.exit(() => prisma.customer.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 })) }); } catch (e) { next(e); }
    });
    router.post('/automation/global', requireRole('ADMINISTRATOR'), requirePermission('squid.pause.global'), async (req, res, next) => {
      try {
        const data = PauseSchema.parse(req.body);
        await setAutomationPause('global', data.paused, data.reason, req.user.userId);
        await audit({ action: 'SQUID_CONFIG_LOCKED', performedById: req.user.userId, customerId: req.user.customerId, metadata: { automationScope: 'global', ...data } });
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    router.post('/clients/:customerId/automation', ...manage, async (req, res, next) => {
      try {
        const data = PauseSchema.parse(req.body);
        const customerId = req.params['customerId']!;
        if (!await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } })) { res.sendStatus(404); return; }
        await setAutomationPause(`client:${customerId}`, data.paused, data.reason, req.user.userId);
        await audit({ action: 'SQUID_CONFIG_LOCKED', performedById: req.user.userId, customerId, metadata: { automationScope: 'client', ...data } });
        res.json({ ok: true });
      } catch (e) { next(e); }
    });
    router.post('/:proxyId/machine-identity', ...manage, async (req, res, next) => {
      try {
        const proxy = await ownedProxy(req.params['proxyId']!, req.user.customerId);
        if (!proxy) { res.sendStatus(404); return; }
        const data = EnrollmentSchema.parse(req.body);
        const identity = await prisma.machineIdentity.upsert({ where: { id: `proxy:${proxy.id}` }, create: { id: `proxy:${proxy.id}`, ...data, minVersion: 2 }, update: { ...data, minVersion: 2 } });
        await audit({ action: 'SQUID_PROXY_KEY_GENERATED', performedById: req.user.userId, customerId: proxy.customerId, targetId: proxy.id, metadata: { machineEnrollment: true, certificateSha256: identity.certificateSha256, enabled: data.enabled } });
        res.json(identity);
      } catch (e) { next(e); }
    });
    router.post('/:proxyId/workers/:botId/machine-identity', ...manage, async (req, res, next) => {
      try {
        const proxy = await ownedProxy(req.params['proxyId']!, req.user.customerId);
        const botId = req.params['botId']!;
        const link = proxy && await prisma.slackBotOrg.findFirst({ where: { botId, customerId: proxy.customerId, squidProxyId: proxy.id } });
        if (!proxy || !link) { res.sendStatus(404); return; }
        const data = EnrollmentSchema.parse(req.body);
        const identity = await prisma.machineIdentity.upsert({ where: { id: `worker:${botId}` }, create: { id: `worker:${botId}`, ...data, minVersion: 2 }, update: { ...data, minVersion: 2 } });
        await audit({ action: 'SQUID_PROXY_KEY_GENERATED', performedById: req.user.userId, customerId: proxy.customerId, targetId: proxy.id, metadata: { workerEnrollment: botId, enabled: data.enabled } });
        res.json(identity);
      } catch (e) { next(e); }
    });
    router.post('/:proxyId/change-requests', ...manage, requirePermission('tickets.write'), async (req, res, next) => {
      try {
        const proxy = await ownedProxy(req.params['proxyId']!, req.user.customerId);
        if (!proxy) { res.sendStatus(404); return; }
        const body = BotChangeRequestSchema.parse(req.body);
        res.status(201).json(await requestProxyChange(proxy.id, { id: req.user.userId, customerId: proxy.customerId }, body));
      } catch (e) { next(e); }
    });
  }
  router.get('/:proxyId/automation', ...view, async (req, res, next) => {
    try {
      const proxy = await ownedProxy(req.params['proxyId']!, req.user.customerId);
      if (!proxy) { res.sendStatus(404); return; }
      res.json(await automationState(proxy.id, proxy.customerId));
    } catch (e) { next(e); }
  });
  router.post('/:proxyId/automation', ...manage, async (req, res, next) => {
    try {
      const proxy = await ownedProxy(req.params['proxyId']!, req.user.customerId);
      if (!proxy) { res.sendStatus(404); return; }
      const data = PauseSchema.parse(req.body);
      await setAutomationPause(`proxy:${proxy.id}`, data.paused, data.reason, req.user.userId);
      await audit({ action: 'SQUID_CONFIG_LOCKED', performedById: req.user.userId, customerId: proxy.customerId, targetId: proxy.id, metadata: { automationScope: 'proxy', ...data } });
      res.json(await automationState(proxy.id, proxy.customerId));
    } catch (e) { next(e); }
  });
  return router;
}
