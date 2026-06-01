import { prisma } from '../../config/database';
import type { UpdateOrgInput, SecuritySettingsInput } from './organizations.schema';

const orgSelect = {
  id: true,
  name: true,
  slug: true,
  plan: true,
  suspended: true,
  ssoEnabled: true,
  mfaRequired: true,
  creditLimit: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function getMyOrg(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: orgSelect });
  if (!org) throw Object.assign(new Error('Organization not found'), { status: 404, code: 'NOT_FOUND' });
  return org;
}

export async function updateMyOrg(orgId: string, input: UpdateOrgInput) {
  return prisma.organization.update({ where: { id: orgId }, data: input, select: orgSelect });
}

export async function updateSecuritySettings(orgId: string, input: SecuritySettingsInput) {
  return prisma.organization.update({ where: { id: orgId }, data: input, select: orgSelect });
}

export async function getMyServices(orgId: string) {
  const services = await prisma.organizationService.findMany({
    where: { organizationId: orgId },
    orderBy: [{ status: 'asc' }, { renewsAt: 'asc' }],
    select: {
      id: true, name: true, description: true, status: true, enabled: true,
      monthlyPrice: true, purchasedAt: true, renewsAt: true, lastBilledAt: true,
    },
  });
  const monthlyTotal = services.filter((s) => s.enabled && s.status !== 'EXPIRED' && s.status !== 'SUSPENDED').reduce((sum, s) => sum + s.monthlyPrice, 0);
  return { services, monthlyTotal };
}

export async function getUsage(orgId: string) {
  const [usages, org] = await Promise.all([
    prisma.apiUsage.findMany({
      where: { organizationId: orgId },
      orderBy: { periodStart: 'desc' },
      take: 12,
      select: { id: true, creditsUsed: true, periodStart: true, periodEnd: true },
    }),
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { creditLimit: true },
    }),
  ]);

  const totalUsed = usages.reduce((sum, u) => sum + u.creditsUsed, 0);
  return { usages, totalUsed, creditLimit: org?.creditLimit ?? 1000 };
}
