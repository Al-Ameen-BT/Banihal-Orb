import { prisma } from '../../config/database';
import type { QueueQuery } from './dashboard.schema';

export async function getKpis(orgId: string) {
  const [userCount, usages, org] = await Promise.all([
    prisma.user.count({ where: { organizationId: orgId } }),
    prisma.apiUsage.findMany({
      where: { organizationId: orgId },
      orderBy: { periodStart: 'desc' },
      take: 2,
      select: { creditsUsed: true, periodStart: true },
    }),
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { plan: true, creditLimit: true },
    }),
  ]);

  const currentUsage = usages[0]?.creditsUsed ?? 0;
  const previousUsage = usages[1]?.creditsUsed ?? 0;
  const usageDelta = previousUsage > 0 ? ((currentUsage - previousUsage) / previousUsage) * 100 : 0;

  return {
    activeUsers: userCount,
    plan: org?.plan ?? 'FREE',
    apiCreditsUsed: currentUsage,
    creditLimit: org?.creditLimit ?? 1000,
    usageDeltaPct: Math.round(usageDelta * 10) / 10,
    // Placeholder revenue/churn metrics (replace with real billing integration)
    revenue: { mrr: 0, arr: 0, churnRate: 0 },
  };
}

export async function getQueue(orgId: string, input: QueueQuery) {
  const skip = (input.page - 1) * input.limit;

  // Queue items: users pending MFA setup when org requires it
  const [pendingMfa, total] = await Promise.all([
    prisma.user.findMany({
      where: { organizationId: orgId, mfaEnabled: false },
      skip,
      take: input.limit,
      select: { id: true, name: true, email: true, role: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where: { organizationId: orgId, mfaEnabled: false } }),
  ]);

  return {
    items: pendingMfa.map((u) => ({ ...u, type: 'MFA_SETUP', urgency: 'medium', label: `${u.name} has not enabled MFA` })),
    total,
    page: input.page,
    limit: input.limit,
    pages: Math.ceil(total / input.limit),
  };
}
