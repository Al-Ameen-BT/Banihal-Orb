import { prisma } from '../../config/database';
import type { QueueQuery } from './dashboard.schema';

export async function getKpis(orgId: string) {
  const [userCount, org] = await Promise.all([
    prisma.user.count({ where: { customerId: orgId } }),
    prisma.customer.findUnique({
      where: { id: orgId },
      select: { plan: true, creditLimit: true },
    }),
  ]);

  return {
    activeUsers: userCount,
    plan: org?.plan ?? 'FREE',
    creditLimit: org?.creditLimit ?? 1000,
    // Placeholder revenue/churn metrics (replace with real billing integration)
    revenue: { mrr: 0, arr: 0, churnRate: 0 },
  };
}

export async function getQueue(orgId: string, input: QueueQuery) {
  const skip = (input.page - 1) * input.limit;

  // Queue items: users pending MFA setup when org requires it
  const [pendingMfa, total] = await Promise.all([
    prisma.user.findMany({
      where: { customerId: orgId, mfaEnabled: false },
      skip,
      take: input.limit,
      select: { id: true, name: true, email: true, role: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.user.count({ where: { customerId: orgId, mfaEnabled: false } }),
  ]);

  return {
    items: pendingMfa.map((u) => ({ ...u, type: 'MFA_SETUP', urgency: 'medium', label: `${u.name} has not enabled MFA` })),
    total,
    page: input.page,
    limit: input.limit,
    pages: Math.ceil(total / input.limit),
  };
}
