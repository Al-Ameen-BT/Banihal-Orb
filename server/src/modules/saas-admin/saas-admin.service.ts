import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../../config/database';
import { signImpersonationToken } from '../auth/auth.service';
import type {
  ListOrgsInput, UpdateOrgInput, ToggleFlagInput,
  ListRequestsInput, UpdateRequestInput,
  ListServicesInput, UpdateServiceInput, RenewServiceInput,
  AssignServiceInput, CreateCatalogInput, UpdateCatalogInput,
  UpdateUserInput,
} from './saas-admin.schema';

// All queries in this module bypass tenant scope intentionally (SADMIN / ADMINISTRATOR global access)

// ─── Derive service status from renewal date ────────────────────────────────
function deriveStatus(renewsAt: Date): 'ACTIVE' | 'EXPIRING' | 'EXPIRED' {
  const days = (renewsAt.getTime() - Date.now()) / 86400_000;
  if (days < 0) return 'EXPIRED';
  if (days < 30) return 'EXPIRING';
  return 'ACTIVE';
}

// ─── Orgs ───────────────────────────────────────────────────────────────────
export async function listAllOrgs(input: ListOrgsInput) {
  const skip = (input.page - 1) * input.limit;
  const where = {
    ...(input.plan ? { plan: input.plan } : {}),
    ...(input.suspended !== undefined ? { suspended: input.suspended } : {}),
    ...(input.search ? { OR: [{ name: { contains: input.search, mode: 'insensitive' as const } }, { slug: { contains: input.search, mode: 'insensitive' as const } }] } : {}),
  };

  const [orgs, total] = await Promise.all([
    prisma.customer.findMany({
      where, skip, take: input.limit,
      select: {
        id: true, name: true, slug: true, plan: true, suspended: true, creditLimit: true,
        createdAt: true, industry: true, contractValue: true,
        healthScore: true, csm: true,
        _count: { select: { users: true, requests: true, services: true } },
      },
      orderBy: { contractValue: 'desc' },
    }),
    prisma.customer.count({ where }),
  ]);

  return { orgs, total, page: input.page, limit: input.limit, pages: Math.ceil(total / input.limit) };
}

export async function updateOrg(orgId: string, input: UpdateOrgInput) {
  return prisma.customer.update({
    where: { id: orgId }, data: input,
    select: { id: true, name: true, slug: true, plan: true, suspended: true, creditLimit: true, updatedAt: true },
  });
}

export async function impersonateUser(targetUserId: string, adminUserId: string) {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, customerId: true, role: true, name: true, email: true },
  });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });

  await prisma.auditLog.create({
    data: {
      action: 'IMPERSONATE', performedById: adminUserId, targetId: targetUserId,
      customerId: target.customerId,
      metadata: { targetEmail: target.email, targetName: target.name },
    },
  });

  const token = signImpersonationToken(target.id, target.customerId, target.role);
  return { impersonationToken: token, expiresIn: '5m', target: { id: target.id, name: target.name, email: target.email } };
}

// ─── Platform metrics ───────────────────────────────────────────────────────
export async function getPlatformMetrics() {
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86400_000);
  const [
    totalOrgs, orgsByPlan, totalUsers, totalAdmins,
    openRequests, criticalRequests,
    contractAgg, servicesActive, servicesExpiring, servicesExpired,
  ] = await Promise.all([
    prisma.customer.count({ where: { suspended: false, slug: { not: 'tech-internal' } } }),
    prisma.customer.groupBy({ by: ['plan'], _count: { id: true }, where: { slug: { not: 'tech-internal' } } }),
    prisma.user.count({ where: { role: 'USER' } }),
    prisma.user.count({ where: { role: 'ORG_ADMIN' } }),
    prisma.serviceRequest.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] } } }),
    prisma.serviceRequest.count({ where: { priority: 'CRITICAL', status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
    prisma.customer.aggregate({ _sum: { contractValue: true }, where: { suspended: false } }),
    prisma.customerService.count({ where: { endDate: { gte: in30 } } }),
    prisma.customerService.count({ where: { endDate: { gte: now, lt: in30 } } }),
    prisma.customerService.count({ where: { endDate: { lt: now } } }),
  ]);

  const totalACV = contractAgg._sum.contractValue ?? 0;

  return {
    totalOrgs,
    totalUsers,
    totalAdmins,
    openRequests,
    criticalRequests,
    planBreakdown: orgsByPlan.reduce<Record<string, number>>((acc, item) => { acc[item.plan] = item._count.id; return acc; }, {}),
    mrr: Math.round(totalACV / 12),
    arr: totalACV,
    servicesActive,
    servicesExpiring,
    servicesExpired,
    churnRate: 0,
  };
}

// ─── Organizations Overview ─────────────────────────────────────────────────
// Single comprehensive list for the rebuilt SaaS Admin landing page:
// every client org + their admin + service status breakdown + open request counts.
export async function getOrgsOverview() {
  const orgs = await prisma.customer.findMany({
    where: { slug: { not: 'tech-internal' } },
    select: {
      id: true, name: true, slug: true, plan: true, suspended: true,
      industry: true, contractValue: true, healthScore: true, csm: true,
      ssoEnabled: true, mfaRequired: true, createdAt: true,
      _count: { select: { users: true, requests: true, services: true } },
      users: {
        where: { role: 'ORG_ADMIN' },
        select: { id: true, name: true, email: true, mfaEnabled: true, lastLoginAt: true },
        take: 1,
      },
      services: { select: { endDate: true } },
      requests: {
        where: { status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] } },
        select: { priority: true },
      },
    },
    orderBy: [{ suspended: 'asc' }, { contractValue: 'desc' }],
  });

  const enriched = orgs.map((o) => {
    const statuses = o.services.map((s) => deriveStatus(s.endDate));
    const servicesActive    = statuses.filter((st) => st === 'ACTIVE').length;
    const servicesExpiring  = statuses.filter((st) => st === 'EXPIRING').length;
    const servicesExpired   = statuses.filter((st) => st === 'EXPIRED').length;
    const servicesSuspended = 0;
    const openRequests      = o.requests.length;
    const criticalRequests  = o.requests.filter((r) => r.priority === 'CRITICAL').length;
    return {
      id: o.id, name: o.name, slug: o.slug, plan: o.plan, suspended: o.suspended,
      industry: o.industry, contractValue: o.contractValue, healthScore: o.healthScore,
      csm: o.csm, ssoEnabled: o.ssoEnabled, mfaRequired: o.mfaRequired, createdAt: o.createdAt,
      _count: o._count,
      admin: o.users[0] ?? null,
      mrr: Math.round(o.contractValue / 12),
      servicesActive, servicesExpiring, servicesExpired, servicesSuspended,
      openRequests, criticalRequests,
    };
  });

  return { orgs: enriched, total: enriched.length };
}

// ─── Top clients ────────────────────────────────────────────────────────────
export async function getTopClients(limit = 10) {
  const orgs = await prisma.customer.findMany({
    where: { suspended: false, contractValue: { gt: 0 } },
    select: {
      id: true, name: true, slug: true, plan: true, industry: true,
      contractValue: true, healthScore: true, csm: true, createdAt: true, suspended: true,
      _count: { select: { users: true, requests: true, services: true } },
      requests: { where: { status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] } }, select: { id: true, priority: true, status: true } },
      services: { select: { id: true } },
    },
    orderBy: { contractValue: 'desc' },
    take: limit,
  });

  return orgs.map((org) => ({
    ...org,
    mrr: Math.round(org.contractValue / 12),
    openRequests: org.requests.length,
    criticalRequests: org.requests.filter((r) => r.priority === 'CRITICAL').length,
  }));
}

// ─── Org admins list (for Super Admin overview) ─────────────────────────────
export async function listOrgAdmins() {
  const admins = await prisma.user.findMany({
    where: { role: 'ORG_ADMIN' },
    select: {
      id: true, name: true, email: true, mfaEnabled: true, lastLoginAt: true, createdAt: true,
      customer: {
        select: {
          id: true, name: true, slug: true, plan: true, industry: true,
          contractValue: true, healthScore: true, suspended: true,
          _count: { select: { users: true } },
        },
      },
    },
    orderBy: [{ customer: { contractValue: 'desc' } }, { name: 'asc' }],
  });
  return admins;
}

// ─── Service requests ───────────────────────────────────────────────────────
export async function listServiceRequests(input: ListRequestsInput) {
  const skip = (input.page - 1) * input.limit;
  const where = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.type ? { type: input.type } : {}),
    ...(input.orgId ? { customerId: input.orgId } : {}),
  };

  const [requests, total] = await Promise.all([
    prisma.serviceRequest.findMany({
      where, skip, take: input.limit,
      include: { customer: { select: { id: true, name: true, industry: true, plan: true } } },
      orderBy: [{ priority: 'asc' }, { status: 'asc' }, { createdAt: 'desc' }],
    }),
    prisma.serviceRequest.count({ where }),
  ]);

  return { requests, total, page: input.page, limit: input.limit, pages: Math.ceil(total / input.limit) };
}

export async function updateServiceRequest(requestId: string, adminUserId: string, input: UpdateRequestInput) {
  const existing = await prisma.serviceRequest.findUnique({ where: { id: requestId } });
  if (!existing) throw Object.assign(new Error('Request not found'), { status: 404, code: 'NOT_FOUND' });

  const data: Record<string, unknown> = { ...input };
  if (input.status === 'RESOLVED' && existing.status !== 'RESOLVED') data['resolvedAt'] = new Date();

  await prisma.auditLog.create({
    data: {
      action: 'UPDATE_SERVICE_REQUEST', performedById: adminUserId, targetId: requestId,
      customerId: existing.customerId,
      metadata: { changes: input, previous: { status: existing.status, priority: existing.priority } },
    },
  });

  return prisma.serviceRequest.update({ where: { id: requestId }, data, include: { customer: { select: { id: true, name: true } } } });
}

// ─── Customer services (purchased) — list / manage expiry ───────────────────
function serviceLabel(s: { name: string; parent?: { name: string } | null }): string {
  return s.parent ? `${s.parent.name} — ${s.name}` : s.name;
}

export async function listAllServices(input: ListServicesInput) {
  const skip = (input.page - 1) * input.limit;
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 86400_000);
  const statusWhere =
    input.status === 'ACTIVE'   ? { endDate: { gte: in30 } } :
    input.status === 'EXPIRING' ? { endDate: { gte: now, lt: in30 } } :
    input.status === 'EXPIRED'  ? { endDate: { lt: now } } : {};
  const where = {
    ...statusWhere,
    ...(input.orgId ? { customerId: input.orgId } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.customerService.findMany({
      where, skip, take: input.limit,
      include: {
        customer: { select: { id: true, name: true, plan: true, industry: true } },
        service: { select: { id: true, name: true, monthlyPrice: true, parent: { select: { id: true, name: true } } } },
      },
      orderBy: { endDate: 'asc' },
    }),
    prisma.customerService.count({ where }),
  ]);

  const services = rows.map((r) => ({
    id: r.id,
    customerId: r.customerId,
    serviceId: r.serviceId,
    serviceName: serviceLabel(r.service),
    monthlyPrice: r.service.monthlyPrice,
    purchaseDate: r.purchaseDate,
    endDate: r.endDate,
    status: deriveStatus(r.endDate),
    notes: r.notes,
    customer: r.customer,
  }));

  return { services, total, page: input.page, limit: input.limit, pages: Math.ceil(total / input.limit) };
}

export async function updateService(serviceId: string, adminUserId: string, input: UpdateServiceInput) {
  const existing = await prisma.customerService.findUnique({
    where: { id: serviceId }, include: { service: { select: { name: true } } },
  });
  if (!existing) throw Object.assign(new Error('Service not found'), { status: 404, code: 'NOT_FOUND' });

  const data: Record<string, unknown> = {};
  if (input.endDate) data['endDate'] = input.endDate;
  if (input.notes !== undefined) data['notes'] = input.notes;

  await prisma.auditLog.create({
    data: {
      action: 'CUSTOMER_SERVICE_UPDATED', performedById: adminUserId, targetId: serviceId,
      customerId: existing.customerId,
      metadata: { service: existing.service.name, changes: input },
    },
  });

  return prisma.customerService.update({
    where: { id: serviceId }, data,
    include: { customer: { select: { id: true, name: true } }, service: { select: { id: true, name: true } } },
  });
}

export async function renewService(serviceId: string, adminUserId: string, input: RenewServiceInput) {
  const existing = await prisma.customerService.findUnique({
    where: { id: serviceId }, include: { service: { select: { name: true } } },
  });
  if (!existing) throw Object.assign(new Error('Service not found'), { status: 404, code: 'NOT_FOUND' });

  // Extend from the later of (today, current endDate) so renewals stack correctly
  const baseTime = Math.max(Date.now(), existing.endDate.getTime());
  const newEndDate = new Date(baseTime + input.months * 30 * 86400_000);

  await prisma.auditLog.create({
    data: {
      action: 'SERVICE_RENEWED', performedById: adminUserId, targetId: serviceId,
      customerId: existing.customerId,
      metadata: { service: existing.service.name, months: input.months, previousEndDate: existing.endDate, newEndDate },
    },
  });

  return prisma.customerService.update({
    where: { id: serviceId }, data: { endDate: newEndDate },
    include: { customer: { select: { id: true, name: true } }, service: { select: { id: true, name: true } } },
  });
}

// ─── Assign / remove a customer's purchased service ──────────────────────────
export async function assignCustomerService(customerId: string, adminUserId: string, input: AssignServiceInput) {
  const [customer, service] = await Promise.all([
    prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true } }),
    prisma.service.findUnique({ where: { id: input.serviceId }, select: { id: true, name: true } }),
  ]);
  if (!customer) throw Object.assign(new Error('Customer not found'), { status: 404, code: 'NOT_FOUND' });
  if (!service) throw Object.assign(new Error('Service not found'), { status: 404, code: 'NOT_FOUND' });

  const created = await prisma.customerService.create({
    data: {
      customerId,
      serviceId: input.serviceId,
      purchaseDate: input.purchaseDate ?? new Date(),
      endDate: input.endDate,
      notes: input.notes ?? null,
    },
    include: { customer: { select: { id: true, name: true } }, service: { select: { id: true, name: true } } },
  });

  await prisma.auditLog.create({
    data: {
      action: 'SERVICE_ASSIGNED', performedById: adminUserId, targetId: created.id,
      customerId,
      metadata: { service: service.name, customer: customer.name, endDate: input.endDate },
    },
  });

  return created;
}

export async function removeCustomerService(id: string, adminUserId: string) {
  const existing = await prisma.customerService.findUnique({
    where: { id }, include: { service: { select: { name: true } } },
  });
  if (!existing) throw Object.assign(new Error('Service not found'), { status: 404, code: 'NOT_FOUND' });

  await prisma.auditLog.create({
    data: {
      action: 'SERVICE_REMOVED', performedById: adminUserId, targetId: id,
      customerId: existing.customerId,
      metadata: { service: existing.service.name },
    },
  });

  await prisma.customerService.delete({ where: { id } });
}

// ─── Service catalog (global, SADMIN): main services → sub-services ──────────
export async function listCatalog() {
  const services = await prisma.service.findMany({
    orderBy: [{ name: 'asc' }],
    select: {
      id: true, name: true, description: true, parentId: true, active: true, monthlyPrice: true,
      _count: { select: { purchases: true } },
    },
  });
  const mains = services
    .filter((s) => !s.parentId)
    .map((m) => ({ ...m, children: services.filter((s) => s.parentId === m.id) }));
  return { catalog: mains, total: services.length };
}

export async function createCatalogService(input: CreateCatalogInput) {
  if (input.parentId) {
    const parent = await prisma.service.findUnique({ where: { id: input.parentId }, select: { id: true, parentId: true } });
    if (!parent) throw Object.assign(new Error('Parent service not found'), { status: 404, code: 'NOT_FOUND' });
    if (parent.parentId) throw Object.assign(new Error('Sub-services cannot be nested under another sub-service'), { status: 400, code: 'INVALID_PARENT' });
  }
  return prisma.service.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      parentId: input.parentId ?? null,
      monthlyPrice: input.monthlyPrice ?? 0,
      active: input.active ?? true,
    },
  });
}

export async function updateCatalogService(id: string, input: UpdateCatalogInput) {
  const existing = await prisma.service.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error('Service not found'), { status: 404, code: 'NOT_FOUND' });
  return prisma.service.update({ where: { id }, data: input });
}

export async function deleteCatalogService(id: string) {
  const existing = await prisma.service.findUnique({
    where: { id }, include: { _count: { select: { purchases: true, children: true } } },
  });
  if (!existing) throw Object.assign(new Error('Service not found'), { status: 404, code: 'NOT_FOUND' });
  if (existing._count.purchases > 0) {
    throw Object.assign(new Error('Cannot delete a service with customer purchases'), { status: 409, code: 'SERVICE_IN_USE' });
  }
  await prisma.service.delete({ where: { id } });  // sub-services cascade
}

// ─── Org detail (deep view for Super Admin drill-down) ─────────────────────
export async function getOrgDetail(orgId: string) {
  const org = await prisma.customer.findUnique({
    where: { id: orgId },
    include: {
      _count: { select: { users: true, services: true, requests: true } },
      users: {
        select: { id: true, name: true, email: true, role: true, mfaEnabled: true, lastLoginAt: true, createdAt: true },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
      },
      services: {
        orderBy: { endDate: 'asc' },
        select: {
          id: true, purchaseDate: true, endDate: true, notes: true,
          service: { select: { id: true, name: true, description: true, monthlyPrice: true, parent: { select: { id: true, name: true } } } },
        },
      },
      requests: {
        where: { status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] } },
        take: 10,
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
        select: { id: true, type: true, subject: true, status: true, priority: true, service: true, assignedTo: true, createdAt: true },
      },
    },
  });
  if (!org) throw Object.assign(new Error('Customer not found'), { status: 404, code: 'NOT_FOUND' });

  // Flatten purchased services into the shape the client expects (derived status).
  const services = org.services.map((s) => ({
    id: s.id,
    name: serviceLabel(s.service),
    description: s.service.description,
    status: deriveStatus(s.endDate),
    monthlyPrice: s.service.monthlyPrice,
    purchaseDate: s.purchaseDate,
    endDate: s.endDate,
    notes: s.notes,
  }));

  const admin = org.users.find((u) => u.role === 'ORG_ADMIN') ?? null;
  const monthlyRevenue = services
    .filter((s) => s.status !== 'EXPIRED')
    .reduce((sum, s) => sum + s.monthlyPrice, 0);

  return { org: { ...org, services }, admin, monthlyRevenue };
}

// ─── User management (SADMIN — any org user across any org) ─────────────────
const userSelect = {
  id: true, email: true, name: true, role: true, mfaEnabled: true,
  lastLoginAt: true, createdAt: true, customerId: true,
} as const;

export async function updateUser(targetUserId: string, adminUserId: string, input: UpdateUserInput) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, customerId: true, role: true, email: true } });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  if (target.role === 'SADMIN' || target.role === 'ADMINISTRATOR') throw Object.assign(new Error('Platform admin accounts cannot be modified via this endpoint'), { status: 403, code: 'PROTECTED_ACCOUNT' });

  await prisma.auditLog.create({
    data: {
      action: 'ADMIN_USER_UPDATE', performedById: adminUserId, targetId: targetUserId,
      customerId: target.customerId,
      metadata: { changes: input, targetEmail: target.email, previousRole: target.role },
    },
  });

  return prisma.user.update({ where: { id: targetUserId }, data: input, select: userSelect });
}

export async function removeUser(targetUserId: string, adminUserId: string) {
  if (targetUserId === adminUserId) throw Object.assign(new Error('Cannot remove yourself'), { status: 400, code: 'SELF_REMOVE' });
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, customerId: true, role: true, email: true, name: true } });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  if (target.role === 'SADMIN' || target.role === 'ADMINISTRATOR') throw Object.assign(new Error('Platform admin accounts cannot be removed via this endpoint'), { status: 403, code: 'PROTECTED_ACCOUNT' });

  await prisma.auditLog.create({
    data: {
      action: 'ADMIN_USER_REMOVE', performedById: adminUserId, targetId: targetUserId,
      customerId: target.customerId,
      metadata: { targetEmail: target.email, targetName: target.name, targetRole: target.role },
    },
  });

  await prisma.user.delete({ where: { id: targetUserId } });
}

export async function resetUserPassword(targetUserId: string, adminUserId: string) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, customerId: true, role: true, email: true } });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  if (target.role === 'SADMIN' || target.role === 'ADMINISTRATOR') throw Object.assign(new Error('Platform admin passwords cannot be reset via this endpoint'), { status: 403, code: 'PROTECTED_ACCOUNT' });

  const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '') + 'A1!';
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  await prisma.user.update({ where: { id: targetUserId }, data: { passwordHash } });
  await prisma.refreshToken.deleteMany({ where: { userId: targetUserId } });  // force re-auth everywhere

  await prisma.auditLog.create({
    data: {
      action: 'ADMIN_PASSWORD_RESET', performedById: adminUserId, targetId: targetUserId,
      customerId: target.customerId,
      metadata: { targetEmail: target.email },
    },
  });

  return { tempPassword, message: 'Password reset. Communicate this temporary password securely; all existing sessions have been revoked.' };
}

export async function listFlags() {
  return prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
}

export async function upsertFlag(key: string, input: ToggleFlagInput) {
  return prisma.featureFlag.upsert({
    where: { key },
    create: { key, value: input.value, description: input.description },
    update: { value: input.value, ...(input.description ? { description: input.description } : {}) },
  });
}

// ─── Administrator-only: Sadmin management ───────────────────────────────────
const sadminSelect = {
  id: true, email: true, name: true, role: true, mfaEnabled: true,
  lastLoginAt: true, createdAt: true, customerId: true,
  customer: { select: { id: true, name: true, slug: true, domain: true } },
} as const;

export async function listSadmins() {
  return prisma.user.findMany({
    where: { role: 'SADMIN' },
    select: sadminSelect,
    orderBy: [{ customer: { name: 'asc' } }, { name: 'asc' }],
  });
}

export async function updateSadmin(targetUserId: string, administratorId: string, input: UpdateUserInput) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, customerId: true, role: true, email: true } });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  if (target.role !== 'SADMIN') throw Object.assign(new Error('Target is not a Sadmin'), { status: 400, code: 'INVALID_TARGET' });

  await prisma.auditLog.create({
    data: {
      action: 'ADMINISTRATOR_SADMIN_UPDATE', performedById: administratorId, targetId: targetUserId,
      customerId: target.customerId,
      metadata: { changes: input, targetEmail: target.email, previousRole: target.role },
    },
  });

  return prisma.user.update({ where: { id: targetUserId }, data: input, select: sadminSelect });
}

export async function removeSadmin(targetUserId: string, administratorId: string) {
  if (targetUserId === administratorId) throw Object.assign(new Error('Cannot remove yourself'), { status: 400, code: 'SELF_REMOVE' });
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, customerId: true, role: true, email: true, name: true } });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  if (target.role !== 'SADMIN') throw Object.assign(new Error('Target is not a Sadmin'), { status: 400, code: 'INVALID_TARGET' });

  await prisma.auditLog.create({
    data: {
      action: 'ADMINISTRATOR_SADMIN_REMOVE', performedById: administratorId, targetId: targetUserId,
      customerId: target.customerId,
      metadata: { targetEmail: target.email, targetName: target.name },
    },
  });

  await prisma.user.delete({ where: { id: targetUserId } });
}

export async function resetSadminPassword(targetUserId: string, administratorId: string) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, customerId: true, role: true, email: true } });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  if (target.role !== 'SADMIN') throw Object.assign(new Error('Target is not a Sadmin'), { status: 400, code: 'INVALID_TARGET' });

  const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '') + 'A1!';
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  await prisma.user.update({ where: { id: targetUserId }, data: { passwordHash } });
  await prisma.refreshToken.deleteMany({ where: { userId: targetUserId } });

  await prisma.auditLog.create({
    data: {
      action: 'ADMINISTRATOR_SADMIN_PASSWORD_RESET', performedById: administratorId, targetId: targetUserId,
      customerId: target.customerId,
      metadata: { targetEmail: target.email },
    },
  });

  return { tempPassword, message: 'Password reset. Communicate this temporary password securely; all existing sessions have been revoked.' };
}
