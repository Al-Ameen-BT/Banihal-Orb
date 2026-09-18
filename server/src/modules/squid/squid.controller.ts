import { Request, Response, NextFunction } from 'express';
import {
  CreateProxySchema, UpdateProxySchema, ListProxiesSchema, VerifyTokenSchema,
  CreateBranchSchema, UpdateBranchSchema, SetBranchListsSchema, SetPortsSchema, SetFullAccessSchema,
  ActivityQuerySchema, ReportQuerySchema, DependencyScanSchema,
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
  try { res.json(await service.listChangeRequests(req.params['proxyId']!)); } catch (e) { next(e); }
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