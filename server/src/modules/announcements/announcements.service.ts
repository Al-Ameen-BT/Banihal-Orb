import { prisma } from '../../config/database';

// Announcement is in the tenant extension's globalModels (customerId: null means
// "all orgs"), so the auto-injected tenant filter does NOT apply here — this
// manual where clause is the visibility boundary.
export async function listForCustomer(customerId: string) {
  const now = new Date();
  return prisma.announcement.findMany({
    where: {
      active: true,
      OR: [{ customerId: null }, { customerId }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
    select: { id: true, title: true, message: true, level: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
}
