import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../config/database';
import {
  CreateProxySchema, UpdateProxySchema, ListProxiesSchema, VerifyTokenSchema,
  CreateBranchSchema, UpdateBranchSchema, SetBranchListsSchema, SetPortsSchema, SetFullAccessSchema,
  ActivityQuerySchema, ReportQuerySchema, DependencyScanSchema,
  BandwidthQuerySchema, GenerateCaSchema, ImportCertificateSchema, GenerateCsrSchema,
  CreateBackupSchema, RestoreBackupSchema,
} from './squid.schema';
import * as service from './squid.service';

// Org-facing squid proxy management. Tenant isolation comes from the tenant
// middleware + prisma extension — handlers just pass ids through.

export async function listProxies(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.listProxies(ListProxiesSchema.parse(req.query))); } catch (e) { next(e); }
}

export async function getProxy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.getProxy(req.params['proxyId']!)); } catch (e) { next(e); }
}

export async function listChangeRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Sync approvals from any door before rendering so the list is never stale (P5).
    const { syncBotChangeRequests } = await import('./squidBot.service');
    await syncBotChangeRequests({ proxyId: req.params['proxyId']! }).catch(() => undefined);
    res.json(await service.listChangeRequests(req.params['proxyId']!));
  } catch (e) { next(e); }
}

export async function createChangeRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refineBotChange } = await import('./squid.schema');
    const { requestProxyChange } = await import('./squidBot.service');
    const body = (req.body ?? {}) as { action: string; ip: string; domain?: string; hours?: number };
    const rawAction = String(body.action ?? '');
    const norm = rawAction.replace(/^BOT_/i, '').replace(/_/g, '-').toLowerCase();
    const issues: { message: string; path?: (string | number)[] }[] = [];
    refineBotChange(
      { action: norm, ip: body.ip ?? '', domain: body.domain, hours: body.hours },
      { addIssue: (i: { code: 'custom'; message: string; path?: (string | number)[] }) => { issues.push(i); } },
    );
    if (issues.length) {
      res.status(400).json({ error: issues[0]!.message, code: 'VALIDATION_ERROR', issues });
      return;
    }
    const actionMap: Record<string, 'allow' | 'deny' | 'extend' | 'full-net' | 'lock-net'> = {
      'allow': 'allow', 'deny': 'deny', 'extend': 'extend',
      'full-net': 'full-net', 'lock-net': 'lock-net',
    };
    const action = actionMap[norm];
    if (!action) {
      res.status(400).json({ error: `Unknown action: ${rawAction}`, code: 'VALIDATION_ERROR' });
      return;
    }
    const result = await requestProxyChange(
      req.params['proxyId']!,
      { id: req.user.userId!, customerId: req.user.customerId! },
      { action, ip: body.ip, domain: body.domain, hours: body.hours },
    );
    res.status(201).json(result);
  } catch (e) { next(e); }
}

export async function getBotStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const proxyId = req.params['proxyId']!;
    const link = await prisma.slackBotOrg.findFirst({
      where: { squidProxyId: proxyId },
      select: { botId: true, customerId: true },
    });
    if (!link) {
      res.json({ linked: false, bot: null, commands: { dispatched: 0 }, rules: { active: 0, expiringIn24h: 0 } });
      return;
    }
    const [bot, dispatched, active, expiring] = await Promise.all([
      prisma.slackBot.findUnique({ where: { id: link.botId } }),
      prisma.squidBotCommand.count({ where: { proxyId, status: 'DISPATCHED' } }),
      prisma.squidBotRule.count({ where: { proxyId } }),
      prisma.squidBotRule.count({ where: { proxyId, expiresAt: { lt: new Date(Date.now() + 24 * 3600_000) } } }),
    ]);
    res.json({ linked: true, bot, commands: { dispatched }, rules: { active, expiringIn24h: expiring } });
  } catch (e) { next(e); }
}

export async function streamChangeRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const proxyId = req.params['proxyId']!;
    const customerId = req.user.customerId!;
    
    // Verify proxy belongs to customer
    const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId }, select: { customerId: true } });
    if (!proxy || proxy.customerId !== customerId) {
      res.status(404).json({ error: 'Proxy not found', code: 'NOT_FOUND' });
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ proxyId, timestamp: Date.now() })}\n\n`);

    // Track active connections for this proxy
    const clients = service.getChangeRequestClients(proxyId);
    clients.add(res);

    // Cleanup on disconnect
    req.on('close', () => {
      clients.delete(res);
    });

  } catch (e) { next(e); }
}

export async function createProxy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = CreateProxySchema.parse(req.body);
    res.status(201).json(await service.createProxy(req.user.customerId!, input));
  } catch (e) { next(e); }
}

export async function updateProxy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateProxySchema.parse(req.body);
    res.json(await service.updateProxy(req.params['proxyId']!, input));
  } catch (e) { next(e); }
}

export async function deleteProxy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await service.deleteProxy(req.params['proxyId']!, req.user.userId, req.user.customerId!));
  } catch (e) { next(e); }
}

export async function rotateKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await service.rotateAgentKey(req.params['proxyId']!, req.user.userId, req.user.customerId!));
  } catch (e) { next(e); }
}

export async function verifyToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = VerifyTokenSchema.parse(req.body);
    res.json(await service.verifyRegistrationToken(req.params['proxyId']!, req.user.userId, req.user.customerId!, input.token));
  } catch (e) { next(e); }
}

export async function linkExternalApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { externalApiKeyId } = req.body;
    if (!externalApiKeyId) {
      res.status(400).json({ error: 'externalApiKeyId is required', code: 'VALIDATION_ERROR' });
      return;
    }
    res.json(await service.linkExternalApiKey(req.params['proxyId']!, req.user.userId, req.user.customerId!, externalApiKeyId));
  } catch (e) { next(e); }
}

export async function unlinkExternalApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await service.unlinkExternalApiKey(req.params['proxyId']!, req.user.userId, req.user.customerId!));
  } catch (e) { next(e); }
}

export async function listBranches(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json({ branches: await service.listBranches(req.params['proxyId']!) }); } catch (e) { next(e); }
}

export async function createBranch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = CreateBranchSchema.parse(req.body);
    res.status(201).json(await service.createBranch(req.params['proxyId']!, req.user.userId, req.user.customerId!, input));
  } catch (e) { next(e); }
}

export async function updateBranch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateBranchSchema.parse(req.body);
    res.json(await service.updateBranch(req.params['proxyId']!, req.params['branchId']!, req.user.userId, req.user.customerId!, input));
  } catch (e) { next(e); }
}

export async function deleteBranch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await service.deleteBranch(req.params['proxyId']!, req.params['branchId']!, req.user.userId, req.user.customerId!));
  } catch (e) { next(e); }
}

export async function setBranchLists(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = SetBranchListsSchema.parse(req.body);
    res.json(await service.setBranchLists(req.params['proxyId']!, req.params['branchId']!, req.user.userId, req.user.customerId!, input));
  } catch (e) { next(e); }
}

export async function setPorts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = SetPortsSchema.parse(req.body);
    res.json(await service.setPorts(req.params['proxyId']!, req.user.userId, req.user.customerId!, input));
  } catch (e) { next(e); }
}

export async function setFullAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = SetFullAccessSchema.parse(req.body);
    res.json(await service.setFullAccess(req.params['proxyId']!, req.user.userId, req.user.customerId!, input));
  } catch (e) { next(e); }
}

export async function getBundleKey(_req: Request, res: Response): Promise<void> {
  res.json({ publicKey: service.agentBundlePublicKey() });
}

// ─── Ops surface: telemetry dashboard, live activity, reports, dep finder ─────
export async function getTelemetry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.getTelemetrySummary(req.params['proxyId']!)); } catch (e) { next(e); }
}

export async function listActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.listActivity(req.params['proxyId']!, ActivityQuerySchema.parse(req.query))); } catch (e) { next(e); }
}

export async function getHostConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await service.getHostConfig(req.params['proxyId']!)); } catch (e) { next(e); }
}

export async function report(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { days } = ReportQuerySchema.parse(req.query);
    const csv = await service.reportCsv(req.params['proxyId']!, days);
    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="squid-report-${req.params['proxyId']!.slice(0, 8)}.csv"` });
    res.send(csv);
  } catch (e) { next(e); }
}

export async function runDependencyScan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = DependencyScanSchema.parse(req.body);
    res.json(await service.dependencyScan(req.params['proxyId']!, req.user.userId, req.user.customerId!, input));
  } catch (e) { next(e); }
}

// ─── Service Lifecycle Controls ──────────────────────────────────────────────
export async function reloadProxyConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await service.reloadProxyConfig(req.params['proxyId']!, req.user.userId, req.user.customerId!));
  } catch (e) { next(e); }
}

export async function restartProxy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await service.restartProxy(req.params['proxyId']!, req.user.userId, req.user.customerId!));
  } catch (e) { next(e); }
}

export async function rescanProxyAcl(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await service.rescanProxyAcl(req.params['proxyId']!, req.user.userId, req.user.customerId!));
  } catch (e) { next(e); }
}

// ─── Bandwidth Metrics ───────────────────────────────────────────────────────
export async function getBandwidthMetrics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { minutes } = BandwidthQuerySchema.parse(req.query);
    res.json(await service.getBandwidthMetrics(req.params['proxyId']!, minutes));
  } catch (e) { next(e); }
}

// ─── Certificate Management ──────────────────────────────────────────────────
export async function getCertificateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await service.getCertificateStatus(req.params['proxyId']!));
  } catch (e) { next(e); }
}

export async function generateCa(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = GenerateCaSchema.parse(req.body);
    res.json(await service.generateCa(req.params['proxyId']!, req.user.userId, req.user.customerId!, input));
  } catch (e) { next(e); }
}

export async function importCertificate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ImportCertificateSchema.parse(req.body);
    res.json(await service.importCertificate(req.params['proxyId']!, req.user.userId, req.user.customerId!, input));
  } catch (e) { next(e); }
}

export async function generateCsr(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = GenerateCsrSchema.parse(req.body);
    // Ensure optional fields are passed as strings or undefined
    const serviceInput = {
      commonName: input.commonName,
      organization: input.organization ?? '',
      locality: input.locality ?? '',
      state: input.state ?? '',
      country: input.country ?? '',
      san: input.san,
    };
    res.json(await service.generateCsr(req.params['proxyId']!, req.user.userId, req.user.customerId!, serviceInput));
  } catch (e) { next(e); }
}

// ─── Backup & Restore ────────────────────────────────────────────────────────
export async function createBackup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = CreateBackupSchema.parse(req.body);
    res.json(await service.createBackup(req.params['proxyId']!, req.user.userId, req.user.customerId!, input));
  } catch (e) { next(e); }
}

export async function listBackups(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await service.listBackups(req.params['proxyId']!));
  } catch (e) { next(e); }
}

export async function restoreBackup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = RestoreBackupSchema.parse(req.body);
    res.json(await service.restoreBackup(req.params['proxyId']!, req.user.userId, req.user.customerId!, input));
  } catch (e) { next(e); }
}

export async function factoryReset(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await service.factoryReset(req.params['proxyId']!, req.user.userId, req.user.customerId!));
  } catch (e) { next(e); }
}

// ─── Package Status ──────────────────────────────────────────────────────────
export async function getPackageStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await service.getPackageStatus(req.params['proxyId']!));
  } catch (e) { next(e); }
}