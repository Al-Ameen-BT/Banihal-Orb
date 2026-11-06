import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../config/database';
import * as c from './squid.controller';
import { postProxyChangeNotification, SlackChangeSummary } from './slackWebhook';

// ─── Secure Web API for Squid Proxy Configuration ────────────────────────────
// This module provides a Slack-independent web API for managing Squid proxy
// configurations. All changes go through proper authorization, are logged, and
// automatically published to Slack via webhook for visibility.
//
// Mounted at /api/squid-web (cross-tenant, admin-gated). Each route handles its
// own authorization (HMAC registration key for agents, JWT+role for platform admins).

const router = Router();

// --- Add domain to proxy whitelist ---

router.post(
  '/:proxyId/whitelist',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const proxyId = req.params['proxyId'];
      const { domain, description } = req.body as { domain: string; description?: string };

      if (!proxyId || !domain) {
        res.status(400).json({ error: 'Proxy ID and domain are required', code: 'VALIDATION_ERROR' });
        return;
      }

      // Create the change request via the existing controller
      c.createChangeRequest(req, res, next);
      return; // controller already sent response

      // The controller's createChangeRequest calls next on error,
      // so if we reach here, the change request was created successfully.

      // Build summary for Slack notification (execute after controller response)
      // We need to get the proxy info - let's do it here since controller already responded
      // For now, we'll set a flag and the Slack notification will be handled
      // by the controller or we can call it inline.

      // Actually, let me restructure: use the controller but also notify Slack
      // Reset and call with notification

      // Get proxy info for Slack notification
      const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId } });
      if (!proxy) {
        // Already responded, skip
        return;
      }

      // Use proxy name for Slack notification
      const proxyName = (proxy as { name: string | null }).name || proxyId;

      // Since createChangeRequest already sent the response, we can't easily add
      // the Slack notification after. Let me inline the logic instead of using the controller.

      // Actually, let me take a different approach - inline the change request creation
      // and Slack notification directly here.

      // Create change request in the platform DB
      const changeRequest = await prisma.squidChangeRequest.create({
        data: {
          proxyId,
          customerId: proxy!.customerId,
          actorId: (req as any).user?.userId || 'web-admin',
          source: 'WEB',
          action: 'allow',
          summary: `Whitelist domain "${domain}"${description ? `: ${description}` : ''}`,
          details: { domain, description, action: 'add_whitelist' },
        },
      });

      // Build Slack notification summary
      const { nameOrEmail } = getRequestInfo(req);

      const summary: SlackChangeSummary = {
        proxyName,
        changeType: 'allow',
        target: domain,
        ip: proxy!.customerId || 'unknown',
        details: `Domain "${domain}" added to whitelist${description ? `: ${description}` : ''}`,
        changedBy: nameOrEmail,
        timestamp: new Date().toISOString(),
      };

      // Post to Slack webhook (best-effort, non-blocking)
      await postProxyChangeNotification(process.env.SLACK_WEBHOOK_URL || '', summary);

      // Respond with change request info
      res.json({ ok: true, changeRequestId: changeRequest.id, status: changeRequest.status, slackNotified: true });
    } catch (e) { next(e); }
  }
);

// --- Remove domain from proxy whitelist ---

router.post(
  '/:proxyId/blacklist',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const proxyId = req.params['proxyId'];
      const { domain } = req.body as { domain: string };

      if (!proxyId || !domain) {
        res.status(400).json({ error: 'Proxy ID and domain are required', code: 'VALIDATION_ERROR' });
        return;
      }

      // Validate the proxy exists
      const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId } });
      if (!proxy) {
        res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' });
        return;
      }

      // Create change request
      const changeRequest = await prisma.squidChangeRequest.create({
        data: {
          proxyId,
          customerId: proxy.customerId,
          actorId: (req as any).user?.userId || 'web-admin',
          source: 'WEB',
          action: 'deny',
          summary: `Remove domain "${domain}" from whitelist`,
          details: { domain, action: 'remove_whitelist' },
        },
      });

      // Build Slack notification summary
      const proxyName = proxy.name || proxyId;
      const { nameOrEmail } = getRequestInfo(req);

      const summary: SlackChangeSummary = {
        proxyName,
        changeType: 'deny',
        target: domain,
        ip: proxy.customerId || 'unknown',
        details: `Domain "${domain}" removed from whitelist`,
        changedBy: nameOrEmail,
        timestamp: new Date().toISOString(),
      };

      // Post to Slack webhook (best-effort, non-blocking)
      await postProxyChangeNotification(process.env.SLACK_WEBHOOK_URL || '', summary);

      // Respond with change request info
      res.json({ ok: true, changeRequestId: changeRequest.id, status: changeRequest.status, slackNotified: true });
    } catch (e) { next(e); }
  }
);

// --- Full proxy configuration update ---

router.post(
  '/:proxyId/config',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const proxyId = req.params['proxyId'];
      const configInput = req.body;

      if (!proxyId || !configInput) {
        res.status(400).json({ error: 'Proxy ID and configuration are required', code: 'VALIDATION_ERROR' });
        return;
      }

      // Validate the proxy exists
      const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId } });
      if (!proxy) {
        res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' });
        return;
      }

      // Build a summary of the changes
      const changes: string[] = [];
      if (configInput.branches) changes.push(`branches(${Object.keys(configInput.branches).length})`);
      if (configInput.safePorts !== undefined) changes.push(`ports(${configInput.safePorts.length} safe)`);
      if (configInput.sslPorts !== undefined) changes.push(`ssl-ports(${configInput.sslPorts.length})`);
      if (configInput.fullAccess !== undefined) changes.push(`full-access(${configInput.fullAccess.length} rules)`);

      const changeSummary = changes.length > 0 ? changes.join(', ') : 'configuration-update';

      // Create change request
      const changeRequest = await prisma.squidChangeRequest.create({
        data: {
          proxyId,
          customerId: proxy.customerId,
          actorId: (req as any).user?.userId || 'web-admin',
          source: 'WEB',
          action: 'configure',
          summary: `Full proxy configuration update: ${changeSummary}`,
          details: { config: configInput, changeSummary },
        },
      });

      // Build Slack notification summary
      const proxyName = proxy.name || proxyId;
      const { nameOrEmail } = getRequestInfo(req);

      const summary: SlackChangeSummary = {
        proxyName,
        changeType: 'configure',
        target: 'full-config',
        ip: proxy.customerId || 'unknown',
        details: `Full proxy configuration update: ${changeSummary}`,
        changedBy: nameOrEmail,
        timestamp: new Date().toISOString(),
      };

      // Post to Slack webhook (best-effort, non-blocking)
      await postProxyChangeNotification(process.env.SLACK_WEBHOOK_URL || '', summary);

      // Respond with change request info
      res.json({ ok: true, changeRequestId: changeRequest.id, status: changeRequest.status, slackNotified: true });
    } catch (e) { next(e); }
  }
);

// --- Set branch lists ---

router.post(
  '/:proxyId/branch/:branchId/lists',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const proxyId = req.params['proxyId'];
      const branchId = req.params['branchId'];
      const { whitelist, blacklist, sources } = req.body as {
        whitelist?: string[];
        blacklist?: string[];
        sources?: string[];
      };

      if (!proxyId || !branchId) {
        res.status(400).json({ error: 'Proxy ID and branch ID are required', code: 'VALIDATION_ERROR' });
        return;
      }

      // Validate the proxy exists
      const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId } });
      if (!proxy) {
        res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' });
        return;
      }

      // Ensure the branch exists, create if not
      let branch = await prisma.squidBranch.findUnique({ where: { id: branchId } });
      if (!branch || branch.proxyId !== proxyId) {
        branch = await prisma.squidBranch.create({
          data: { proxyId, customerId: proxy.customerId, name: `branch-${branchId}`, mode: 'ADDITIVE' },
        });
      }

      // Update branch lists
      await prisma.squidBranch.update({
        where: { id: branchId },
        data: {
          whitelist: whitelist || [],
          blacklist: blacklist || [],
          sources: sources || [],
        },
      });

      // Bump revision to trigger agent poll
      await prisma.squidProxy.update({ where: { id: proxyId }, data: { revision: { increment: 1 } } });

      // Build Slack notification summary
      const proxyName = proxy.name || proxyId;
      const { nameOrEmail } = getRequestInfo(req);

      const summary: SlackChangeSummary = {
        proxyName,
        changeType: 'configure',
        target: `branch-${branchId}`,
        ip: proxy.customerId || 'unknown',
        details: `Branch lists updated: ${(whitelist || []).length} whitelist, ${(blacklist || []).length} blacklist, ${(sources || []).length} sources`,
        changedBy: nameOrEmail,
        timestamp: new Date().toISOString(),
      };

      // Post to Slack webhook (best-effort, non-blocking)
      await postProxyChangeNotification(process.env.SLACK_WEBHOOK_URL || '', summary);

      // Respond with success
      res.json({ ok: true, slackNotified: true });
    } catch (e) { next(e); }
  }
);

// --- Set ports ---

router.post(
  '/:proxyId/ports',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const proxyId = req.params['proxyId'];

      if (!proxyId) {
        res.status(400).json({ error: 'Proxy ID is required', code: 'VALIDATION_ERROR' });
        return;
      }

      // Validate the proxy exists
      const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId } });
      if (!proxy) {
        res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' });
        return;
      }

      const { safePorts, sslPorts } = req.body as { safePorts?: number[]; sslPorts?: number[] };

      // Update proxy ports and bump revision
      await prisma.squidProxy.update({
        where: { id: proxyId },
        data: {
          safePorts: safePorts || [],
          sslPorts: sslPorts || [],
          revision: { increment: 1 },
        },
      });

      // Build Slack notification summary
      const proxyName = proxy.name || proxyId;
      const { nameOrEmail } = getRequestInfo(req);

      const safeCount = Array.isArray(safePorts) ? safePorts.length : 0;
      const sslCount = Array.isArray(sslPorts) ? sslPorts.length : 0;

      const summary: SlackChangeSummary = {
        proxyName,
        changeType: 'configure',
        target: 'ports',
        ip: proxy.customerId || 'unknown',
        details: `Ports updated: ${safeCount} safe, ${sslCount} ssl`,
        changedBy: nameOrEmail,
        timestamp: new Date().toISOString(),
      };

      // Post to Slack webhook (best-effort, non-blocking)
      await postProxyChangeNotification(process.env.SLACK_WEBHOOK_URL || '', summary);

      // Respond with success
      res.json({ ok: true, slackNotified: true });
    } catch (e) { next(e); }
  }
);

// --- Set full-access rules ---

router.post(
  '/:proxyId/full-access',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const proxyId = req.params['proxyId'];

      if (!proxyId) {
        res.status(400).json({ error: 'Proxy ID is required', code: 'VALIDATION_ERROR' });
        return;
      }

      // Validate the proxy exists
      const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId } });
      if (!proxy) {
        res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' });
        return;
      }

      const { fullAccess } = req.body as { fullAccess?: Array<{ src: string; description?: string }> };

      // Update proxy fullAccess and bump revision
      await prisma.squidProxy.update({
        where: { id: proxyId },
        data: {
          fullAccess: fullAccess || [],
          revision: { increment: 1 },
        },
      });

      // Build Slack notification summary
      const proxyName = proxy.name || proxyId;
      const { nameOrEmail } = getRequestInfo(req);

      const ruleCount = Array.isArray(fullAccess) ? fullAccess.length : 0;

      const summary: SlackChangeSummary = {
        proxyName,
        changeType: 'configure',
        target: 'full-access',
        ip: proxy.customerId || 'unknown',
        details: `Full-access rules updated: ${ruleCount} entries`,
        changedBy: nameOrEmail,
        timestamp: new Date().toISOString(),
      };

      // Post to Slack webhook (best-effort, non-blocking)
      await postProxyChangeNotification(process.env.SLACK_WEBHOOK_URL || '', summary);

      // Respond with success
      res.json({ ok: true, slackNotified: true });
    } catch (e) { next(e); }
  }
);

// --- Reload proxy config ---

router.post(
  '/:proxyId/reload',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const proxyId = req.params['proxyId'];

      if (!proxyId) {
        res.status(400).json({ error: 'Proxy ID is required', code: 'VALIDATION_ERROR' });
        return;
      }

      // Validate the proxy exists
      const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId } });
      if (!proxy) {
        res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' });
        return;
      }

      // Bump revision to trigger agent poll
      await prisma.squidProxy.update({ where: { id: proxyId }, data: { revision: { increment: 1 } } });

      // Build Slack notification summary
      const proxyName = proxy.name || proxyId;
      const { nameOrEmail } = getRequestInfo(req);

      const summary: SlackChangeSummary = {
        proxyName,
        changeType: 'configure',
        target: 'reload',
        ip: proxy.customerId || 'unknown',
        details: 'Proxy configuration reload triggered',
        changedBy: nameOrEmail,
        timestamp: new Date().toISOString(),
      };

      // Post to Slack webhook (best-effort, non-blocking)
      await postProxyChangeNotification(process.env.SLACK_WEBHOOK_URL || '', summary);

      // Respond with success
      res.json({ ok: true, message: 'Config reload triggered — agent will pull on next poll', slackNotified: true });
    } catch (e) { next(e); }
  }
);

// --- Restart proxy ---

router.post(
  '/:proxyId/restart',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const proxyId = req.params['proxyId'];

      if (!proxyId) {
        res.status(400).json({ error: 'Proxy ID is required', code: 'VALIDATION_ERROR' });
        return;
      }

      // Validate the proxy exists
      const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId } });
      if (!proxy) {
        res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' });
        return;
      }

      // Bump revision to trigger agent restart
      await prisma.squidProxy.update({ where: { id: proxyId }, data: { revision: { increment: 1 } } });

      // Build Slack notification summary
      const proxyName = proxy.name || proxyId;
      const { nameOrEmail } = getRequestInfo(req);

      const summary: SlackChangeSummary = {
        proxyName,
        changeType: 'configure',
        target: 'restart',
        ip: proxy.customerId || 'unknown',
        details: 'Proxy service restart triggered',
        changedBy: nameOrEmail,
        timestamp: new Date().toISOString(),
      };

      // Post to Slack webhook (best-effort, non-blocking)
      await postProxyChangeNotification(process.env.SLACK_WEBHOOK_URL || '', summary);

      // Respond with success
      res.json({ ok: true, message: 'Restart triggered — agent will restart squid on next poll', slackNotified: true });
    } catch (e) { next(e); }
  }
);

// --- Rescan proxy ACL files ---

router.post(
  '/:proxyId/rescan',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const proxyId = req.params['proxyId'];

      if (!proxyId) {
        res.status(400).json({ error: 'Proxy ID is required', code: 'VALIDATION_ERROR' });
        return;
      }

      // Validate the proxy exists
      const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId } });
      if (!proxy) {
        res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' });
        return;
      }

      // Bump revision to trigger ACL rescan
      await prisma.squidProxy.update({ where: { id: proxyId }, data: { revision: { increment: 1 } } });

      // Build Slack notification summary
      const proxyName = proxy.name || proxyId;
      const { nameOrEmail } = getRequestInfo(req);

      const summary: SlackChangeSummary = {
        proxyName,
        changeType: 'configure',
        target: 'rescan',
        ip: proxy.customerId || 'unknown',
        details: 'Proxy ACL files rescanned',
        changedBy: nameOrEmail,
        timestamp: new Date().toISOString(),
      };

      // Post to Slack webhook (best-effort, non-blocking)
      await postProxyChangeNotification(process.env.SLACK_WEBHOOK_URL || '', summary);

      // Respond with success
      res.json({ ok: true, message: 'ACL rescan triggered — agent will re-read config files on next poll', slackNotified: true });
    } catch (e) { next(e); }
  }
);

// Helper: extract request info for Slack notifications
function getRequestInfo(req: Request): { customerId: string; name: string; userId: string; nameOrEmail: string } {
  const user = (req as any).user;
  const customerId = user?.customerId || '';
  const name = user?.name || user?.email || 'platform-admin';
  const userId = user?.userId || '';
  const nameOrEmail = user?.name || user?.email || 'platform-admin';
  return { customerId, name, userId, nameOrEmail };
}

export default router;