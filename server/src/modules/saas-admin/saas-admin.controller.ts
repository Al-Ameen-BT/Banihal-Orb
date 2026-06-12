import { Request, Response, NextFunction } from 'express';
import {
  ListOrgsSchema, UpdateOrgSchema, ToggleFlagSchema,
  ListRequestsSchema, UpdateRequestSchema,
  ListServicesSchema, UpdateServiceSchema, RenewServiceSchema,
  AssignServiceSchema,
  CreateCatalogServiceSchema, UpdateCatalogServiceSchema,
  UpdateUserSchema, SystemActivitySchema,
  CreateAnnouncementSchema, UpdateAnnouncementSchema,
  ListEscalationsSchema, UpdateEscalationSchema,
} from './saas-admin.schema';
import * as saasAdminService from './saas-admin.service';

export async function listOrgs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ListOrgsSchema.parse(req.query);
    const result = await saasAdminService.listAllOrgs(input);
    res.json(result);
  } catch (err) { next(err); }
}

export async function updateOrg(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateOrgSchema.parse(req.body);
    const org = await saasAdminService.updateOrg(req.params['id']!, input);
    res.json(org);
  } catch (err) { next(err); }
}

export async function impersonateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await saasAdminService.impersonateUser(req.params['userId']!, req.user.userId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getMetrics(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const metrics = await saasAdminService.getPlatformMetrics();
    res.json(metrics);
  } catch (err) { next(err); }
}

export async function getOrgsOverview(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await saasAdminService.getOrgsOverview();
    res.json(result);
  } catch (err) { next(err); }
}

export async function getTopClients(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(parseInt(req.query['limit'] as string ?? '10', 10) || 10, 20);
    const clients = await saasAdminService.getTopClients(limit);
    res.json({ clients });
  } catch (err) { next(err); }
}

export async function listOrgAdmins(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const admins = await saasAdminService.listOrgAdmins();
    res.json({ admins });
  } catch (err) { next(err); }
}

export async function listAllOrgUsers(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const users = await saasAdminService.listAllOrgUsers();
    res.json({ users });
  } catch (err) { next(err); }
}

export async function listRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ListRequestsSchema.parse(req.query);
    const result = await saasAdminService.listServiceRequests(input);
    res.json(result);
  } catch (err) { next(err); }
}

export async function updateRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateRequestSchema.parse(req.body);
    const result = await saasAdminService.updateServiceRequest(req.params['id']!, req.user.userId, input);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listServices(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ListServicesSchema.parse(req.query);
    const result = await saasAdminService.listAllServices(input);
    res.json(result);
  } catch (err) { next(err); }
}

export async function updateService(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateServiceSchema.parse(req.body);
    const service = await saasAdminService.updateService(req.params['id']!, req.user.userId, input);
    res.json(service);
  } catch (err) { next(err); }
}

export async function renewService(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = RenewServiceSchema.parse(req.body);
    const service = await saasAdminService.renewService(req.params['id']!, req.user.userId, input);
    res.json(service);
  } catch (err) { next(err); }
}

export async function assignService(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = AssignServiceSchema.parse(req.body);
    const result = await saasAdminService.assignCustomerService(req.params['customerId']!, req.user.userId, input);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function removeService(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await saasAdminService.removeCustomerService(req.params['id']!, req.user.userId);
    res.status(200).json({ success: true });
  } catch (err) { next(err); }
}

export async function getOrgDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const detail = await saasAdminService.getOrgDetail(req.params['id']!);
    res.json(detail);
  } catch (err) { next(err); }
}

export async function updateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateUserSchema.parse(req.body);
    const user = await saasAdminService.updateUser(req.params['id']!, req.user.userId, input);
    res.json(user);
  } catch (err) { next(err); }
}

export async function removeUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await saasAdminService.removeUser(req.params['id']!, req.user.userId);
    res.status(200).json({ success: true });
  } catch (err) { next(err); }
}

export async function resetUserPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await saasAdminService.resetUserPassword(req.params['id']!, req.user.userId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function listFlags(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await saasAdminService.listFlags()); } catch (err) { next(err); }
}

export async function toggleFlag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ToggleFlagSchema.parse(req.body);
    const flag = await saasAdminService.upsertFlag(req.params['key']!, input);
    res.json(flag);
  } catch (err) { next(err); }
}

// ─── Service catalog ────────────────────────────────────────────────────────
export async function listCatalog(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await saasAdminService.listCatalogServices()); } catch (err) { next(err); }
}

export async function createCatalogItem(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = CreateCatalogServiceSchema.parse(req.body);
    const item = await saasAdminService.createCatalogService(input);
    res.status(201).json(item);
  } catch (err) { next(err); }
}

export async function updateCatalogItem(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateCatalogServiceSchema.parse(req.body);
    const item = await saasAdminService.updateCatalogService(req.params['id']!, input);
    res.json(item);
  } catch (err) { next(err); }
}

export async function deleteCatalogItem(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await saasAdminService.deleteCatalogService(req.params['id']!);
    res.status(200).json({ success: true });
  } catch (err) { next(err); }
}

// ─── Administrator: Sadmin management ───────────────────────────────────────
export async function listSadmins(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sadmins = await saasAdminService.listSadmins();
    res.json({ sadmins });
  } catch (err) { next(err); }
}

export async function updateSadmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateUserSchema.parse(req.body);
    const user = await saasAdminService.updateSadmin(req.params['id']!, req.user.userId, input);
    res.json(user);
  } catch (err) { next(err); }
}

export async function removeSadmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await saasAdminService.removeSadmin(req.params['id']!, req.user.userId);
    res.status(200).json({ success: true });
  } catch (err) { next(err); }
}

export async function resetSadminPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await saasAdminService.resetSadminPassword(req.params['id']!, req.user.userId);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getSadminActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(Number(req.query['limit'] ?? 60), 100);
    const result = await saasAdminService.getSadminActivity(limit);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getSystemActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = SystemActivitySchema.parse(req.query);
    const result = await saasAdminService.getSystemActivity(input);
    res.json(result);
  } catch (err) { next(err); }
}

// ─── SLA breach monitor ──────────────────────────────────────────────────────
export async function getSlaBreaches(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await saasAdminService.getSlaBreaches();
    res.json(result);
  } catch (err) { next(err); }
}

// ─── Chat analytics ──────────────────────────────────────────────────────────
export async function getChatAnalytics(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await saasAdminService.getChatAnalytics();
    res.json(result);
  } catch (err) { next(err); }
}

// ─── Ticket escalations ──────────────────────────────────────────────────────
export async function listEscalations(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ListEscalationsSchema.parse(req.query);
    res.json(await saasAdminService.listEscalations(input));
  } catch (err) { next(err); }
}

export async function updateEscalation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateEscalationSchema.parse(req.body);
    const escalation = await saasAdminService.updateEscalation(req.params['id']!, req.user.userId, input);
    res.json(escalation);
  } catch (err) { next(err); }
}

// ─── Announcements ───────────────────────────────────────────────────────────
export async function listAnnouncements(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const announcements = await saasAdminService.listAnnouncements();
    res.json({ announcements });
  } catch (err) { next(err); }
}

export async function createAnnouncement(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = CreateAnnouncementSchema.parse(req.body);
    const announcement = await saasAdminService.createAnnouncement(req.user.userId, req.user.customerId, input);
    res.status(201).json(announcement);
  } catch (err) { next(err); }
}

export async function updateAnnouncement(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpdateAnnouncementSchema.parse(req.body);
    const announcement = await saasAdminService.updateAnnouncement(req.params['id']!, input);
    res.json(announcement);
  } catch (err) { next(err); }
}

export async function deleteAnnouncement(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await saasAdminService.deleteAnnouncement(req.params['id']!, req.user.userId, req.user.customerId);
    res.status(204).end();
  } catch (err) { next(err); }
}
