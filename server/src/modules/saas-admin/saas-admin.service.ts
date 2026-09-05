import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../../config/database';
import { chatPrisma } from '../../config/chatDatabase';
import { signImpersonationToken, isProviderAdminEmail } from '../auth/auth.service';
import { DEFAULT_SCOPE_ACTIONS, SADMIN_FEED_ACTIONS } from '../../config/auditActions';
import { audit } from '../../lib/audit';
import { assertRoleAssignable } from '../platform-roles/platformRoles.service';
import { sendInviteEmail } from '../mail/mail.service';
import type { PermissionKey } from '../../config/permissions';
import { passwordFingerprint } from '../auth/passwordReuse';
import { syncTicketUpdated } from '../requests/ticketing.provider';
import { getTicketNumberFormat as readTicketNumberFormat } from '../ticketing/services/numberFormat';
import type {
  ListOrgsInput, UpdateOrgInput, ToggleFlagInput,
  ListRequestsInput, UpdateRequestInput,
  ListServicesInput, UpdateServiceInput, RenewServiceInput,
  AssignServiceInput,
  CreateCatalogServiceInput, UpdateCatalogServiceInput,
  UpdateUserInput, UpdateSadminInput, InviteStaffInput, SystemActivityInput, LoginsByOrgInput,
  CreateAnnouncementInput, UpdateAnnouncementInput,
  ListEscalationsInput, UpdateEscalationInput,
  TicketNumberFormatInput,
} from './saas-admin.schema';

// All queries in this module bypass tenant scope intentionally (SADMIN / ADMINISTRATOR global access)

// ─── Derive service status from renewal date ────────────────────────────────
function deriveStatus(renewsAt: Date): 'ACTIVE' | 'EXPIRING' | 'EXPIRED' {
  const days = (renewsAt.getTime() - Date.now()) / 86400_000;
  if (days < 0) return 'EXPIRED';
  if (days < 30) return 'EXPIRING';
  return 'ACTIVE';
}

// ─── The provider's own organization ────────────────────────────────────────
// It is not a client and must not appear in client lists, counts or pickers.
//
// Identified by "holds an ADMINISTRATOR", because that is what actually makes an
// organization the provider. The previous filter hardcoded the slug
// 'platform-platform-com', but prisma/seed.ts DERIVES that slug from
// ADMIN_DOMAINS — so on any deployment configuring a real domain
// (platform-banihaltechnologies-com) the literal matched nothing and the provider
// org leaked into every list, silently. A predicate that reads the actual data
// cannot drift with configuration.
const CLIENT_ORGS_ONLY = { users: { none: { role: 'ADMINISTRATOR' as const } } };

// ─── Orgs ───────────────────────────────────────────────────────────────────
export async function listAllOrgs(input: ListOrgsInput) {
  const skip = (input.page - 1) * input.limit;
  // Deliberately NOT filtered to client orgs. This endpoint feeds only the
  // organization dropdown on System Activity / System Logs, and platform-staff
  // audit rows carry the PROVIDER org's customerId — hiding it here would make
  // every staff action unfilterable in the audit trail.
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

export async function updateOrg(orgId: string, input: UpdateOrgInput, actorId: string) {
  const before = await prisma.customer.findUnique({
    where: { id: orgId }, select: { name: true, plan: true, suspended: true, creditLimit: true },
  });
  try {
    const updated = await prisma.customer.update({
      where: { id: orgId }, data: input,
      select: { id: true, name: true, slug: true, plan: true, suspended: true, creditLimit: true, orgCode: true, updatedAt: true },
    });
    // Suspension, plan and credit limit all move through here, unlogged before.
    await audit({
      action: 'ORG_UPDATED', performedById: actorId, targetId: orgId, customerId: orgId,
      metadata: { orgName: updated.name, changes: input, previous: before ?? {} },
    });
    return updated;
  } catch (err) {
    // orgCode is @unique — surface a clean conflict instead of a 500.
    if ((err as { code?: string }).code === 'P2002') {
      throw Object.assign(new Error('That org code is already used by another organization.'), { status: 409, code: 'ORG_CODE_TAKEN' });
    }
    throw err;
  }
}

// ─── Ticket-number format (platform-wide, ADMINISTRATOR-only) ────────────────
export const getTicketNumberFormat = () => readTicketNumberFormat();

export async function updateTicketNumberFormat(input: TicketNumberFormatInput, adminUserId: string) {
  return prisma.ticketNumberSetting.upsert({
    where: { id: 'default' },
    create: { id: 'default', ...input, updatedById: adminUserId },
    update: { ...input, updatedById: adminUserId },
    select: { prefix: true, includeOrgCode: true, separator: true, padWidth: true, updatedAt: true },
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
    prisma.customer.count({ where: { suspended: false, ...CLIENT_ORGS_ONLY } }),
    prisma.customer.groupBy({ by: ['plan'], _count: { id: true }, where: CLIENT_ORGS_ONLY }),
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
    where: CLIENT_ORGS_ONLY,
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
    where: { suspended: false, contractValue: { gt: 0 }, ...CLIENT_ORGS_ONLY },
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

// ─── All Users list (for Administrator Users page) ──────────────────────────
export async function listAllOrgUsers() {
  const users = await prisma.user.findMany({
    where: { role: { not: 'ADMINISTRATOR' } },
    select: {
      id: true, name: true, email: true, role: true, mfaEnabled: true, lastLoginAt: true, createdAt: true,
      customer: {
        // mfaRequired so the directory can show EFFECTIVE MFA, not just the
        // user's opt-in — see mfaStatus() on the client.
        select: {
          id: true, name: true, slug: true, plan: true, mfaRequired: true,
        },
      },
    },
    orderBy: [{ customer: { name: 'asc' } }, { role: 'asc' }, { name: 'asc' }],
  });
  return users;
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
      include: {
        customer: { select: { id: true, name: true, industry: true, plan: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
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

  const updated = await prisma.serviceRequest.update({ where: { id: requestId }, data, include: { customer: { select: { id: true, name: true } } } });
  // Mirror workflow changes (status/priority/assignee) to the external ticketing
  // system — no-op until configured; never blocks the admin flow.
  syncTicketUpdated(updated);
  return updated;
}

// ─── Per-customer services — list / add / manage expiry ─────────────────────
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
      include: { customer: { select: { id: true, name: true, plan: true, industry: true } } },
      orderBy: { endDate: 'asc' },
    }),
    prisma.customerService.count({ where }),
  ]);

  const services = rows.map((r) => ({
    id: r.id,
    customerId: r.customerId,
    serviceName: r.name,
    monthlyPrice: r.monthlyPrice,
    purchaseDate: r.purchaseDate,
    endDate: r.endDate,
    status: deriveStatus(r.endDate),
    notes: r.notes,
    customer: r.customer,
  }));

  return { services, total, page: input.page, limit: input.limit, pages: Math.ceil(total / input.limit) };
}

export async function updateService(serviceId: string, adminUserId: string, input: UpdateServiceInput) {
  const existing = await prisma.customerService.findUnique({ where: { id: serviceId } });
  if (!existing) throw Object.assign(new Error('Service not found'), { status: 404, code: 'NOT_FOUND' });

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data['name'] = input.name;
  if (input.monthlyPrice !== undefined) data['monthlyPrice'] = input.monthlyPrice;
  if (input.endDate) data['endDate'] = input.endDate;
  if (input.notes !== undefined) data['notes'] = input.notes;

  await prisma.auditLog.create({
    data: {
      action: 'CUSTOMER_SERVICE_UPDATED', performedById: adminUserId, targetId: serviceId,
      customerId: existing.customerId,
      metadata: { service: existing.name, changes: input },
    },
  });

  return prisma.customerService.update({
    where: { id: serviceId }, data,
    include: { customer: { select: { id: true, name: true } } },
  });
}

export async function renewService(serviceId: string, adminUserId: string, input: RenewServiceInput) {
  const existing = await prisma.customerService.findUnique({ where: { id: serviceId } });
  if (!existing) throw Object.assign(new Error('Service not found'), { status: 404, code: 'NOT_FOUND' });

  // Extend from the later of (today, current endDate) so renewals stack correctly
  const baseTime = Math.max(Date.now(), existing.endDate.getTime());
  const newEndDate = new Date(baseTime + input.months * 30 * 86400_000);

  await prisma.auditLog.create({
    data: {
      action: 'SERVICE_RENEWED', performedById: adminUserId, targetId: serviceId,
      customerId: existing.customerId,
      metadata: { service: existing.name, months: input.months, previousEndDate: existing.endDate, newEndDate },
    },
  });

  return prisma.customerService.update({
    where: { id: serviceId }, data: { endDate: newEndDate },
    include: { customer: { select: { id: true, name: true } } },
  });
}

// ─── Add / remove a service for a customer (each org's own catalog) ──────────
export async function assignCustomerService(customerId: string, adminUserId: string, input: AssignServiceInput) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true } });
  if (!customer) throw Object.assign(new Error('Customer not found'), { status: 404, code: 'NOT_FOUND' });

  const created = await prisma.customerService.create({
    data: {
      customerId,
      name: input.name,
      description: input.description ?? null,
      monthlyPrice: input.monthlyPrice ?? 0,
      purchaseDate: input.purchaseDate ?? new Date(),
      endDate: input.endDate,
      notes: input.notes ?? null,
    },
    include: { customer: { select: { id: true, name: true } } },
  });

  await prisma.auditLog.create({
    data: {
      action: 'SERVICE_ASSIGNED', performedById: adminUserId, targetId: created.id,
      customerId,
      metadata: { service: input.name, customer: customer.name, endDate: input.endDate },
    },
  });

  return created;
}

export async function removeCustomerService(id: string, adminUserId: string) {
  const existing = await prisma.customerService.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error('Service not found'), { status: 404, code: 'NOT_FOUND' });

  await prisma.auditLog.create({
    data: {
      action: 'SERVICE_REMOVED', performedById: adminUserId, targetId: id,
      customerId: existing.customerId,
      metadata: { service: existing.name },
    },
  });

  await prisma.customerService.delete({ where: { id } });
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
        select: { id: true, name: true, description: true, monthlyPrice: true, purchaseDate: true, endDate: true, notes: true },
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
    name: s.name,
    description: s.description,
    status: deriveStatus(s.endDate),
    monthlyPrice: s.monthlyPrice,
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
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, customerId: true, role: true, email: true, customer: { select: { mfaRequired: true } } },
  });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  if (target.role === 'ADMINISTRATOR') throw Object.assign(new Error('Platform admin accounts cannot be modified via this endpoint'), { status: 403, code: 'PROTECTED_ACCOUNT' });

  // Same rule as the user's own profile toggle: enforcement outranks the opt-in,
  // so nobody — not even an admin — can leave the flag saying "off" while login
  // still challenges them.
  if (input.mfaEnabled === false && target.customer?.mfaRequired) {
    throw Object.assign(
      new Error("This organization requires two-factor authentication, so it cannot be turned off for its members."),
      { status: 400, code: 'MFA_REQUIRED_BY_ORG' },
    );
  }

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
  if (target.role === 'ADMINISTRATOR') throw Object.assign(new Error('Platform admin accounts cannot be removed via this endpoint'), { status: 403, code: 'PROTECTED_ACCOUNT' });

  await prisma.auditLog.create({
    data: {
      action: 'ADMIN_USER_REMOVE', performedById: adminUserId, targetId: targetUserId,
      customerId: target.customerId,
      metadata: { targetEmail: target.email, targetName: target.name, targetRole: target.role },
    },
  });

  await prisma.user.delete({ where: { id: targetUserId } });
  // Chat history lives in the dedicated chat DB — no cross-database cascade.
  await chatPrisma.chatSession.deleteMany({ where: { userId: targetUserId } }).catch(() => {});
}

export async function resetUserPassword(targetUserId: string, adminUserId: string) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, customerId: true, role: true, email: true } });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  if (target.role === 'ADMINISTRATOR') throw Object.assign(new Error('Platform admin passwords cannot be reset via this endpoint'), { status: 403, code: 'PROTECTED_ACCOUNT' });

  const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '') + 'A1!';
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  // Random temp password — reuse check unnecessary, but record the fingerprint so the
  // account stays covered by the password-reuse report.
  await prisma.user.update({ where: { id: targetUserId }, data: { passwordHash, passwordFingerprint: passwordFingerprint(tempPassword) } });
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

// ─── Service catalog (platform-level master list) ───────────────────────────
export async function listCatalogServices() {
  return prisma.serviceCatalog.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }] });
}

export async function createCatalogService(input: CreateCatalogServiceInput) {
  return prisma.serviceCatalog.create({ data: input });
}

export async function updateCatalogService(id: string, input: UpdateCatalogServiceInput) {
  const existing = await prisma.serviceCatalog.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error('Catalog service not found'), { status: 404, code: 'NOT_FOUND' });
  return prisma.serviceCatalog.update({ where: { id }, data: input });
}

export async function deleteCatalogService(id: string) {
  const existing = await prisma.serviceCatalog.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error('Catalog service not found'), { status: 404, code: 'NOT_FOUND' });
  await prisma.serviceCatalog.delete({ where: { id } });
}

// ─── Administrator-only: SADMIN activity feed ───────────────────────────────
// Derived from the registry, not hand-listed. The hand-written version omitted
// IMPERSONATE and every removal — the most destructive things staff can do were
// missing from the feed whose whole job is showing what staff do.
const TRACKED_ACTIONS = SADMIN_FEED_ACTIONS;

export async function getSadminActivity(limit = 60) {
  const logs = await prisma.auditLog.findMany({
    where: {
      action: { in: TRACKED_ACTIONS },
      performedBy: { role: 'ADMINISTRATOR' },
    },
    include: {
      performedBy: { select: { id: true, name: true, email: true, role: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return logs;
}

// ─── Administrator-only: system-wide activity log (audit console) ───────────
// Default scope is account-lifecycle + session events across ALL orgs:
// org creation, user registration, and every role's login / logout.
// Derived from the registry's `defaultScope` flag. The hand-written version held
// four actions out of 28, which is why user deletions were recorded correctly and
// then filtered out of every default view — visible only to someone who knew to
// pick "All actions".
const SYSTEM_ACTIONS = DEFAULT_SCOPE_ACTIONS;

export async function getSystemActivity(input: SystemActivityInput) {
  // action '*' = every audit action (full audit search); a specific action = exact
  // match; omitted = the default session/lifecycle scope (SYSTEM_ACTIONS).
  const where = {
    ...(input.action === '*'
      ? {}
      : input.action
        ? { action: input.action }
        : { action: { in: SYSTEM_ACTIONS } }),
    ...(input.role ? { performedBy: { role: input.role } } : {}),
    ...(input.orgId ? { customerId: input.orgId } : {}),
    ...(input.from || input.to
      ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
      : {}),
  };

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { performedBy: { select: { id: true, name: true, email: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (input.page - 1) * input.limit,
      take: input.limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  // Resolve org names in one round-trip (customerId is a scalar, not a relation here).
  const orgIds = [...new Set(logs.map((l) => l.customerId))];
  const orgs = orgIds.length
    ? await prisma.customer.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true, slug: true } })
    : [];
  const orgMap = new Map(orgs.map((o) => [o.id, o] as const));
  const items = logs.map((l) => ({ ...l, organization: orgMap.get(l.customerId) ?? null }));

  return { items, total, page: input.page, limit: input.limit };
}

// ─── Administrator-only: logins classified by organization ──────────────────
// Compliance / log-analysis view: successful LOGIN events grouped per org over
// an optional date window — total logins, distinct users, and last login. Rows
// come back sorted by login volume (busiest tenant first).
export async function getLoginsByOrg(input: LoginsByOrgInput) {
  const where = {
    action: 'LOGIN',
    ...(input.role ? { performedBy: { role: input.role } } : {}),
    ...(input.from || input.to
      ? { createdAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } }
      : {}),
  };

  // One group per org (login count + last login), and one group per
  // (org, user) so distinct users per org is just the row count.
  const [byOrg, byOrgUser] = await Promise.all([
    prisma.auditLog.groupBy({
      by: ['customerId'],
      where,
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.auditLog.groupBy({ by: ['customerId', 'performedById'], where }),
  ]);

  const userCounts = new Map<string, number>();
  for (const row of byOrgUser) {
    userCounts.set(row.customerId, (userCounts.get(row.customerId) ?? 0) + 1);
  }

  // Resolve org names in one round-trip (customerId is a scalar here, not a relation).
  const orgIds = byOrg.map((g) => g.customerId);
  const orgs = orgIds.length
    ? await prisma.customer.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true, slug: true } })
    : [];
  const orgMap = new Map(orgs.map((o) => [o.id, o] as const));

  const items = byOrg
    .map((g) => ({
      id: g.customerId,
      name: orgMap.get(g.customerId)?.name ?? 'Unknown organization',
      slug: orgMap.get(g.customerId)?.slug ?? null,
      logins: g._count._all,
      users: userCounts.get(g.customerId) ?? 0,
      lastLogin: g._max.createdAt,
    }))
    .sort((a, b) => b.logins - a.logins);

  const totalLogins = items.reduce((sum, i) => sum + i.logins, 0);
  return { items, totalLogins, orgCount: items.length };
}

// ─── Administrator-only: Sadmin management ───────────────────────────────────
const sadminSelect = {
  id: true, email: true, name: true, role: true, mfaEnabled: true,
  lastLoginAt: true, createdAt: true, customerId: true,
  // Which KIND of staff — the directory is meaningless without it now that
  // Administration is no longer the only assignable platform role.
  platformRoleId: true,
  platformRole: { select: { id: true, key: true, name: true } },
  customer: { select: { id: true, name: true, slug: true, domain: true, mfaRequired: true } },
} as const;

export async function listSadmins() {
  // All platform admins (ADMINISTRATOR) — matches the activity feed and card header.
  return prisma.user.findMany({
    where: { role: 'ADMINISTRATOR' },
    select: sadminSelect,
    orderBy: [{ customer: { name: 'asc' } }, { name: 'asc' }],
  });
}

export async function updateSadmin(
  targetUserId: string,
  administratorId: string,
  input: UpdateSadminInput,
  actorPermissions: Set<PermissionKey>,
) {
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, customerId: true, role: true, email: true, platformRoleId: true } });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  if (target.role !== 'ADMINISTRATOR') throw Object.assign(new Error('Target is not an Administrator'), { status: 400, code: 'INVALID_TARGET' });

  // A role change now ends the target's session (below). Applied to yourself that
  // signs you out instantly, and dropping roles.manage on the way would leave
  // nobody able to undo it — so refuse, the same way the UI already refuses to
  // let you remove your own account.
  if (input.platformRoleId && targetUserId === administratorId) {
    throw Object.assign(
      new Error('You cannot change your own platform role. Ask another administrator.'),
      { status: 400, code: 'SELF_ROLE_CHANGE' },
    );
  }

  // Reassigning a platform role is a privilege grant: refuse to hand out a role
  // holding keys the caller does not hold themselves. Without this an HR Admin
  // (who holds users.manage by default) could promote anyone to Administration.
  if (input.platformRoleId) await assertRoleAssignable(input.platformRoleId, actorPermissions);

  // Moving an account off the provider domain would lock it out at login
  // (initiateLogin rejects ADMINISTRATOR on a non-provider domain), so refuse
  // rather than silently bricking it.
  if (input.email && !isProviderAdminEmail(input.email)) {
    throw Object.assign(
      new Error('Platform staff must use a provider-domain email address.'),
      { status: 400, code: 'ADMIN_DOMAIN_FORBIDDEN' },
    );
  }

  await prisma.auditLog.create({
    data: {
      action: 'ADMINISTRATOR_SADMIN_UPDATE', performedById: administratorId, targetId: targetUserId,
      customerId: target.customerId,
      metadata: { changes: input, targetEmail: target.email, previousRole: target.role },
    },
  });

  const updated = await prisma.user.update({ where: { id: targetUserId }, data: input, select: sadminSelect });

  // A changed platform role must not wait for the access token to expire: the
  // permissions it grants are baked into that JWT's `prid`. Deleting the session
  // row takes effect on the NEXT request, because authMiddleware re-checks that
  // the session exists every time — so the old role stops working immediately.
  //
  // Scoped to an ACTUAL change, so a name or email edit never signs anyone out.
  // For a user who is not signed in this deletes nothing and reports false: the
  // administrator's change simply applies the next time they sign in, with no
  // interruption and no alert. That is the whole "only interrupt active users"
  // rule — enforced by there being no session to delete, not by a second check.
  let sessionEnded = false;
  if (input.platformRoleId && input.platformRoleId !== target.platformRoleId) {
    const { count } = await prisma.refreshToken.deleteMany({ where: { userId: targetUserId } });
    sessionEnded = count > 0;
  }

  return { ...updated, sessionEnded };
}

// ─── Staff invitation ────────────────────────────────────────────────────────
// The only path that mints a NON-Administration staff account, and therefore the
// thing that made HR Admin / Employee / Intern reachable at all: before this,
// every platformRoleId ever written was plr_administration.
export async function inviteStaff(input: InviteStaffInput, administratorId: string, actorPermissions: Set<PermissionKey>) {
  // An ADMINISTRATOR on a non-provider domain can never log in (initiateLogin
  // throws ADMIN_DOMAIN_FORBIDDEN), so reject here rather than create a dead row.
  if (!isProviderAdminEmail(input.email)) {
    throw Object.assign(
      new Error('Platform staff must use a provider-domain email address (see ADMIN_DOMAINS).'),
      { status: 400, code: 'ADMIN_DOMAIN_FORBIDDEN' },
    );
  }

  await assertRoleAssignable(input.platformRoleId, actorPermissions);

  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) throw Object.assign(new Error('An account with that email already exists'), { status: 409, code: 'EMAIL_TAKEN' });

  // Staff join the inviting administrator's own organization — the provider org.
  const inviter = await prisma.user.findUnique({
    where: { id: administratorId },
    select: { customerId: true, customer: { select: { name: true } } },
  });
  if (!inviter) throw Object.assign(new Error('Inviting account not found'), { status: 401, code: 'AUTH_REQUIRED' });

  const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '') + 'A1!';
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      role: 'ADMINISTRATOR',
      platformRoleId: input.platformRoleId,
      passwordHash,
      passwordFingerprint: passwordFingerprint(tempPassword),
      // Pre-verified for the same reason as the org invite in users.service.ts.
      emailVerifiedAt: new Date(),
      customerId: inviter.customerId,
    },
    select: sadminSelect,
  });

  await prisma.auditLog.create({
    data: {
      action: 'ADMINISTRATOR_STAFF_INVITED', performedById: administratorId, targetId: user.id,
      customerId: inviter.customerId,
      metadata: { targetEmail: user.email, platformRoleId: input.platformRoleId },
    },
  });

  const role = await prisma.platformRole.findUnique({ where: { id: input.platformRoleId }, select: { name: true } });
  const delivered = await sendInviteEmail(user.email, {
    name: user.name,
    tempPassword,
    roleLabel: role?.name ?? 'Platform staff',
    orgName: inviter.customer.name,
  });

  // The password is returned ONLY when the email did not go out — otherwise a
  // working mail setup would still spray credentials through the API response.
  return {
    user,
    delivered,
    ...(delivered ? {} : { tempPassword }),
    message: delivered
      ? `Invitation sent to ${user.email}.`
      : 'Email could not be sent. Communicate this temporary password securely.',
  };
}

export async function removeSadmin(targetUserId: string, administratorId: string) {
  if (targetUserId === administratorId) throw Object.assign(new Error('Cannot remove yourself'), { status: 400, code: 'SELF_REMOVE' });
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, customerId: true, role: true, email: true, name: true } });
  if (!target) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  if (target.role !== 'ADMINISTRATOR') throw Object.assign(new Error('Target is not an Administrator'), { status: 400, code: 'INVALID_TARGET' });

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
  if (target.role !== 'ADMINISTRATOR') throw Object.assign(new Error('Target is not an Administrator'), { status: 400, code: 'INVALID_TARGET' });

  const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '') + 'A1!';
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  // Random temp password — reuse check unnecessary, but record the fingerprint so the
  // account stays covered by the password-reuse report.
  await prisma.user.update({ where: { id: targetUserId }, data: { passwordHash, passwordFingerprint: passwordFingerprint(tempPassword) } });
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

// ─── SLA breach monitor ──────────────────────────────────────────────────────
// Response-SLA windows by priority (hours) — mirrors the client-facing SLA table.
const SLA_HOURS: Record<string, number> = { CRITICAL: 1, HIGH: 4, MEDIUM: 24, LOW: 72 };

export async function getSlaBreaches() {
  const open = await prisma.serviceRequest.findMany({
    where: { status: { in: ['OPEN', 'IN_PROGRESS', 'ESCALATED'] } },
    include: {
      customer: { select: { id: true, name: true, plan: true } },
      createdBy: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const now = Date.now();
  const enriched = open.map((r) => {
    const slaHours = SLA_HOURS[r.priority] ?? 72;
    const deadline = new Date(r.createdAt.getTime() + slaHours * 3600_000);
    return { ...r, slaHours, slaDeadline: deadline, overdueMs: now - deadline.getTime() };
  });

  const breached = enriched.filter((r) => r.overdueMs > 0).sort((a, b) => b.overdueMs - a.overdueMs);
  // Not yet breached but less than 25% of the SLA window remains.
  const approaching = enriched
    .filter((r) => r.overdueMs <= 0 && -r.overdueMs < r.slaHours * 3600_000 * 0.25)
    .sort((a, b) => b.overdueMs - a.overdueMs);

  const counts = breached.reduce<Record<string, number>>((acc, r) => {
    acc[r.priority] = (acc[r.priority] ?? 0) + 1;
    return acc;
  }, {});

  return { breached, approaching, counts, totalOpen: open.length };
}

// ─── Chat / assistant analytics ──────────────────────────────────────────────
export async function getChatAnalytics() {
  const since = new Date(Date.now() - 14 * 86400_000);
  // Chat data lives in the dedicated chat DB; org names are joined from the
  // main DB below (cross-database join happens in code).
  const [totalSessions, totalMessages, sessionsByOrg, messagesByOrg, userGroups, recentMessages] = await Promise.all([
    chatPrisma.chatSession.count(),
    chatPrisma.chatMessage.count(),
    chatPrisma.chatSession.groupBy({ by: ['customerId'], _count: { _all: true } }),
    chatPrisma.chatMessage.groupBy({ by: ['customerId'], _count: { _all: true } }),
    chatPrisma.chatSession.groupBy({ by: ['userId'], _count: { _all: true } }),
    chatPrisma.chatMessage.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
  ]);

  const orgIds = [...new Set(sessionsByOrg.map((g) => g.customerId))];
  const orgs = orgIds.length
    ? await prisma.customer.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
    : [];
  const nameMap = new Map(orgs.map((o) => [o.id, o.name] as const));
  const msgMap = new Map(messagesByOrg.map((g) => [g.customerId, g._count._all] as const));

  const perOrg = sessionsByOrg
    .map((g) => ({
      customerId: g.customerId,
      name: nameMap.get(g.customerId) ?? 'Unknown',
      sessions: g._count._all,
      messages: msgMap.get(g.customerId) ?? 0,
    }))
    .sort((a, b) => b.messages - a.messages);

  // Daily message volume, last 14 days (bucketed in code — tiny result set).
  const daily: Array<{ date: string; messages: number }> = [];
  for (let i = 13; i >= 0; i--) {
    daily.push({ date: new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10), messages: 0 });
  }
  const dayIndex = new Map(daily.map((d, i) => [d.date, i] as const));
  for (const m of recentMessages) {
    const i = dayIndex.get(m.createdAt.toISOString().slice(0, 10));
    if (i !== undefined) daily[i]!.messages++;
  }

  return { totalSessions, totalMessages, activeChatUsers: userGroups.length, perOrg, daily };
}

// ─── Ticket escalations (forwarded by org admins) ────────────────────────────
const escalationInclude = {
  customer: { select: { id: true, name: true, plan: true } },
  escalatedBy: { select: { id: true, name: true, email: true } },
} as const;

export async function listEscalations(input: ListEscalationsInput) {
  const where = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.since ? { createdAt: { gt: input.since } } : {}),
  };
  const escalations = await prisma.ticketEscalation.findMany({
    where,
    include: escalationInclude,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  // `now` is the polling watermark for Administrator notifications.
  return { escalations, total: escalations.length, now: new Date().toISOString() };
}

export async function updateEscalation(id: string, adminUserId: string, input: UpdateEscalationInput) {
  const existing = await prisma.ticketEscalation.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error('Escalation not found'), { status: 404, code: 'NOT_FOUND' });

  await prisma.auditLog.create({
    data: {
      action: 'ESCALATION_UPDATED', performedById: adminUserId, targetId: id,
      customerId: existing.customerId,
      metadata: { subject: existing.subject, from: existing.status, to: input.status },
    },
  }).catch(() => {});

  return prisma.ticketEscalation.update({ where: { id }, data: { status: input.status }, include: escalationInclude });
}

// ─── Announcements (platform broadcasts) ─────────────────────────────────────
const announcementInclude = { customer: { select: { id: true, name: true } } } as const;

export async function listAnnouncements() {
  return prisma.announcement.findMany({
    include: announcementInclude,
    orderBy: { createdAt: 'desc' },
  });
}

export async function createAnnouncement(adminUserId: string, adminCustomerId: string, input: CreateAnnouncementInput) {
  const announcement = await prisma.announcement.create({
    data: {
      title: input.title,
      message: input.message,
      level: input.level,
      customerId: input.customerId ?? null,
      expiresAt: input.expiresAt ?? null,
      createdById: adminUserId,
    },
    include: announcementInclude,
  });

  await prisma.auditLog.create({
    data: {
      action: 'ANNOUNCEMENT_CREATED', performedById: adminUserId, targetId: announcement.id,
      customerId: input.customerId ?? adminCustomerId,
      metadata: { title: input.title, level: input.level, scope: input.customerId ? 'org' : 'all-orgs' },
    },
  }).catch(() => {});

  return announcement;
}

export async function updateAnnouncement(id: string, input: UpdateAnnouncementInput) {
  const existing = await prisma.announcement.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error('Announcement not found'), { status: 404, code: 'NOT_FOUND' });
  return prisma.announcement.update({ where: { id }, data: input, include: announcementInclude });
}

export async function deleteAnnouncement(id: string, adminUserId: string, adminCustomerId: string) {
  const existing = await prisma.announcement.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error('Announcement not found'), { status: 404, code: 'NOT_FOUND' });

  await prisma.announcement.delete({ where: { id } });
  await prisma.auditLog.create({
    data: {
      action: 'ANNOUNCEMENT_DELETED', performedById: adminUserId, targetId: id,
      customerId: existing.customerId ?? adminCustomerId,
      metadata: { title: existing.title },
    },
  }).catch(() => {});
}

// ─── Password-reuse report (ADMINISTRATOR) ───────────────────────────────────
// Lists groups of accounts that share the SAME password, platform-wide. Detection relies
// on the keyed fingerprint written when a password is set (see auth/passwordReuse.ts) —
// bcrypt hashes cannot reveal reuse because each one is randomly salted.
//
// Coverage is intentionally partial: accounts that have not set a password since the
// feature shipped have no fingerprint, so they cannot be evaluated. The response reports
// that explicitly rather than implying a clean bill of health.
//
// Raw SQL on purpose: the tenant extension would inject `customerId` into a model query
// on User and silently reduce this to a single organization.
export async function getPasswordReuseReport(): Promise<{
  coverage: { totalUsers: number; withFingerprint: number; unchecked: number };
  groups: Array<{ count: number; users: Array<{ id: string; name: string; email: string; role: string; organization: string }> }>;
}> {
  const [counts] = await prisma.$queryRaw<Array<{ total: bigint; covered: bigint }>>`
    SELECT COUNT(*) AS total,
           COUNT("passwordFingerprint") AS covered
      FROM "User"`;
  const totalUsers = Number(counts?.total ?? 0);
  const withFingerprint = Number(counts?.covered ?? 0);

  // Only fingerprints shared by 2+ accounts. The fingerprint itself is never returned.
  const rows = await prisma.$queryRaw<Array<{
    fingerprint: string; id: string; name: string; email: string; role: string; organization: string;
  }>>`
    SELECT u."passwordFingerprint" AS fingerprint,
           u."id", u."name", u."email", u."role"::text AS role,
           COALESCE(c."name", '—') AS organization
      FROM "User" u
      LEFT JOIN "customers" c ON c."id" = u."customerId"
     WHERE u."passwordFingerprint" IN (
             SELECT "passwordFingerprint" FROM "User"
              WHERE "passwordFingerprint" IS NOT NULL
              GROUP BY "passwordFingerprint" HAVING COUNT(*) > 1)
     ORDER BY u."passwordFingerprint", u."email"`;

  const byFingerprint = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byFingerprint.get(r.fingerprint) ?? [];
    list.push(r);
    byFingerprint.set(r.fingerprint, list);
  }

  const groups = [...byFingerprint.values()].map((list) => ({
    count: list.length,
    users: list.map(({ id, name, email, role, organization }) => ({ id, name, email, role, organization })),
  })).sort((a, b) => b.count - a.count);

  return { coverage: { totalUsers, withFingerprint, unchecked: totalUsers - withFingerprint }, groups };
}
