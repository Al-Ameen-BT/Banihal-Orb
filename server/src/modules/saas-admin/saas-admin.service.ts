import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../../config/database';
import { signImpersonationToken } from '../auth/auth.service';
import type {
  ListOrgsInput, UpdateOrgInput, ToggleFlagInput,
  ListRequestsInput, UpdateRequestInput,
  ListServicesInput, UpdateServiceInput, RenewServiceInput,
  UpdateUserInput,
} from './saas-admin.schema';

// All queries in this module bypass tenant scope intentionally (SAAS_ADMIN global access)

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
    prisma.organization.findMany({
      where, skip, take: input.limit,
      select: {
        id: true, name: true, slug: true, plan: true, suspended: true, creditLimit: true,
        createdAt: true, industry: true, contractValue: true,
        healthScore: true, csm: true,
        _count: { select: { users: true, requests: true, services: true } },
      },
      orderBy: { contractValue: 'desc' },
    }),
    prisma.organization.count({ where }),
  ]);

  return { orgs, total, page: input.page, limit: input.limit, pages: Math.ceil(total / input.limit) };
}

export async function updateOrg(orgId: string, input: UpdateOrgInput) {
  return prisma.organization.update({
    where: { id: orgId }, data: input,
    select: { id: true, name: true, slug: true, plan: true, suspended: true, creditLimit: true, updatedAt: true },
  });
}

export async function impersonateUser(targetUserId: string, adminUserId: string) {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, organizationId: true, role: true, name: true, email: true },
  });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });

  await prisma.auditLog.create({
    data: {
      action: 'IMPERSONATE', performedById: adminUserId, targetId: targetUserId,
      organizationId: target.organizationId,
      metadata: { targetEmail: target.email, targetName: target.name },
    },
  });

  const token = signImpersonationToken(target.id, target.organizationId, target.role);
  return { impersonationToken: token, expiresIn: '5m', target: { id: target.id, name: target.name, email: target.email } };
}

// ─── Platform metrics ───────────────────────────────────────────────────────
export async function getPlatformMetrics() {
  const [
    totalOrgs, orgsByPlan, totalUsers, totalAdmins,
    openRequests, criticalRequests,
    contractAgg, servicesActive, servicesExpiring, servicesExpired,
  ] = await Promise.all([
    prisma.organization.count({ where: { suspended: false, slug: { not: 'tech-internal' } } }),
    prisma.organization.groupBy({ by: ['plan'], _count: { id: true }, where: { slug: { not: 'tech-internal' } } }),
    prisma.user.count({ where: { role: 'USER' } }),
    prisma.user.count({ where: { role: 'ORG_ADMIN' } }),
    prisma.serviceRequest.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] } } }),
    prisma.serviceRequest.count({ where: { priority: 'CRITICAL', status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
    prisma.organization.aggregate({ _sum: { contractValue: true }, where: { suspended: false } }),
    prisma.organizationService.count({ where: { status: 'ACTIVE', enabled: true } }),
    prisma.organizationService.count({ where: { status: 'EXPIRING' } }),
    prisma.organizationService.count({ where: { status: { in: ['EXPIRED', 'SUSPENDED'] } } }),
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
  const orgs = await prisma.organization.findMany({
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
      services: { select: { status: true, enabled: true } },
      requests: {
        where: { status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] } },
        select: { priority: true },
      },
    },
    orderBy: [{ suspended: 'asc' }, { contractValue: 'desc' }],
  });

  const enriched = orgs.map((o) => {
    const servicesActive    = o.services.filter((s) => s.status === 'ACTIVE' && s.enabled).length;
    const servicesExpiring  = o.services.filter((s) => s.status === 'EXPIRING').length;
    const servicesExpired   = o.services.filter((s) => s.status === 'EXPIRED').length;
    const servicesSuspended = o.services.filter((s) => s.status === 'SUSPENDED' || !s.enabled).length;
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
  const orgs = await prisma.organization.findMany({
    where: { suspended: false, contractValue: { gt: 0 } },
    select: {
      id: true, name: true, slug: true, plan: true, industry: true,
      contractValue: true, healthScore: true, csm: true, createdAt: true, suspended: true,
      _count: { select: { users: true, requests: true, services: true } },
      requests: { where: { status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] } }, select: { id: true, priority: true, status: true } },
      services: { select: { id: true, name: true } },
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
      organization: {
        select: {
          id: true, name: true, slug: true, plan: true, industry: true,
          contractValue: true, healthScore: true, suspended: true,
          _count: { select: { users: true } },
        },
      },
    },
    orderBy: [{ organization: { contractValue: 'desc' } }, { name: 'asc' }],
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
    ...(input.orgId ? { organizationId: input.orgId } : {}),
  };

  const [requests, total] = await Promise.all([
    prisma.serviceRequest.findMany({
      where, skip, take: input.limit,
      include: { organization: { select: { id: true, name: true, industry: true, plan: true } } },
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
      organizationId: existing.organizationId,
      metadata: { changes: input, previous: { status: existing.status, priority: existing.priority } },
    },
  });

  return prisma.serviceRequest.update({ where: { id: requestId }, data, include: { organization: { select: { id: true, name: true } } } });
}

// ─── Organization Services ──────────────────────────────────────────────────
export async function listAllServices(input: ListServicesInput) {
  const skip = (input.page - 1) * input.limit;
  const where = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.orgId ? { organizationId: input.orgId } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  };

  const [services, total] = await Promise.all([
    prisma.organizationService.findMany({
      where, skip, take: input.limit,
      include: { organization: { select: { id: true, name: true, plan: true, industry: true } } },
      orderBy: [{ status: 'asc' }, { renewsAt: 'asc' }],
    }),
    prisma.organizationService.count({ where }),
  ]);

  return { services, total, page: input.page, limit: input.limit, pages: Math.ceil(total / input.limit) };
}

export async function updateService(serviceId: string, adminUserId: string, input: UpdateServiceInput) {
  const existing = await prisma.organizationService.findUnique({ where: { id: serviceId } });
  if (!existing) throw Object.assign(new Error('Service not found'), { status: 404, code: 'NOT_FOUND' });

  // Auto-derive status when renewsAt changes and no explicit status override given
  const data: Record<string, unknown> = { ...input };
  if (input.renewsAt && !input.status) {
    data['status'] = deriveStatus(input.renewsAt);
  }

  await prisma.auditLog.create({
    data: {
      action: input.enabled === false ? 'SERVICE_DISABLED' : input.enabled === true ? 'SERVICE_ENABLED' : 'SERVICE_UPDATED',
      performedById: adminUserId,
      targetId: serviceId,
      organizationId: existing.organizationId,
      metadata: { service: existing.name, changes: input },
    },
  });

  return prisma.organizationService.update({
    where: { id: serviceId },
    data,
    include: { organization: { select: { id: true, name: true } } },
  });
}

export async function renewService(serviceId: string, adminUserId: string, input: RenewServiceInput) {
  const existing = await prisma.organizationService.findUnique({ where: { id: serviceId } });
  if (!existing) throw Object.assign(new Error('Service not found'), { status: 404, code: 'NOT_FOUND' });

  // Renew from later of (today, current renewsAt) so renewals stack correctly
  const baseTime = Math.max(Date.now(), existing.renewsAt.getTime());
  const newRenewsAt = new Date(baseTime + input.months * 30 * 86400_000);

  await prisma.auditLog.create({
    data: {
      action: 'SERVICE_RENEWED', performedById: adminUserId, targetId: serviceId,
      organizationId: existing.organizationId,
      metadata: { service: existing.name, months: input.months, previousRenewsAt: existing.renewsAt, newRenewsAt },
    },
  });

  return prisma.organizationService.update({
    where: { id: serviceId },
    data: { renewsAt: newRenewsAt, status: 'ACTIVE', enabled: true, lastBilledAt: new Date() },
    include: { organization: { select: { id: true, name: true } } },
  });
}

// ─── Org detail (deep view for Super Admin drill-down) ─────────────────────
export async function getOrgDetail(orgId: string) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    include: {
      _count: { select: { users: true, services: true, requests: true } },
      users: {
        select: { id: true, name: true, email: true, role: true, mfaEnabled: true, lastLoginAt: true, createdAt: true },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
      },
      services: {
        orderBy: [{ status: 'asc' }, { renewsAt: 'asc' }],
        select: { id: true, name: true, description: true, status: true, enabled: true, monthlyPrice: true, purchasedAt: true, renewsAt: true, lastBilledAt: true },
      },
      requests: {
        where: { status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] } },
        take: 10,
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
        select: { id: true, type: true, subject: true, status: true, priority: true, service: true, assignedTo: true, createdAt: true },
      },
    },
  });
  if (!org) throw Object.assign(new Error('Organization not found'), { status: 404, code: 'NOT_FOUND' });

  const admin = org.users.find((u) => u.role === 'ORG_ADMIN') ?? null;
  const monthlyRevenue = org.services
    .filter((s) => s.enabled && (s.status === 'ACTIVE' || s.status === 'EXPIRING'))
    .reduce((sum, s) => sum + s.monthlyPrice, 0);

  return { org, admin, monthlyRevenue };
}

// ─── User management (SAAS_ADMIN — any user across any org) ────────────────
const userSelect = {
  id: true, email: true, name: true, role: true, mfaEnabled: true,
  lastLoginAt: true, createdAt: true, organizationId: true,
} as const;

export async function updateUser(targetUserId: string, adminUserId: string, input: UpdateUserInput) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, organizationId: true, role: true, email: true } });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  if (target.role === 'SAAS_ADMIN') throw Object.assign(new Error('SAAS_ADMIN accounts cannot be modified via this endpoint'), { status: 403, code: 'PROTECTED_ACCOUNT' });

  await prisma.auditLog.create({
    data: {
      action: 'SAAS_ADMIN_USER_UPDATE', performedById: adminUserId, targetId: targetUserId,
      organizationId: target.organizationId,
      metadata: { changes: input, targetEmail: target.email, previousRole: target.role },
    },
  });

  return prisma.user.update({ where: { id: targetUserId }, data: input, select: userSelect });
}

export async function removeUser(targetUserId: string, adminUserId: string) {
  if (targetUserId === adminUserId) throw Object.assign(new Error('Cannot remove yourself'), { status: 400, code: 'SELF_REMOVE' });
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, organizationId: true, role: true, email: true, name: true } });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  if (target.role === 'SAAS_ADMIN') throw Object.assign(new Error('SAAS_ADMIN accounts cannot be removed via this endpoint'), { status: 403, code: 'PROTECTED_ACCOUNT' });

  await prisma.auditLog.create({
    data: {
      action: 'SAAS_ADMIN_USER_REMOVE', performedById: adminUserId, targetId: targetUserId,
      organizationId: target.organizationId,
      metadata: { targetEmail: target.email, targetName: target.name, targetRole: target.role },
    },
  });

  await prisma.user.delete({ where: { id: targetUserId } });
}

export async function resetUserPassword(targetUserId: string, adminUserId: string) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, organizationId: true, role: true, email: true } });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  if (target.role === 'SAAS_ADMIN') throw Object.assign(new Error('SAAS_ADMIN passwords cannot be reset via this endpoint'), { status: 403, code: 'PROTECTED_ACCOUNT' });

  const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '') + 'A1!';
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  await prisma.user.update({ where: { id: targetUserId }, data: { passwordHash } });
  await prisma.refreshToken.deleteMany({ where: { userId: targetUserId } });  // force re-auth everywhere

  await prisma.auditLog.create({
    data: {
      action: 'SAAS_ADMIN_PASSWORD_RESET', performedById: adminUserId, targetId: targetUserId,
      organizationId: target.organizationId,
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
