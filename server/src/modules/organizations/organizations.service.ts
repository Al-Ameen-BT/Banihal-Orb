import { prisma } from '../../config/database';
import type { UpdateOrgInput, SecuritySettingsInput } from './organizations.schema';

const customerSelect = {
  id: true,
  name: true,
  slug: true,
  plan: true,
  suspended: true,
  ssoEnabled: true,
  mfaRequired: true,
  creditLimit: true,
  mailId: true,
  contactPerson: true,
  contactNumber: true,
  domain: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function getMyOrg(customerId: string) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: customerSelect });
  if (!customer) throw Object.assign(new Error('Customer not found'), { status: 404, code: 'NOT_FOUND' });
  return customer;
}

export async function updateMyOrg(customerId: string, input: UpdateOrgInput) {
  return prisma.customer.update({ where: { id: customerId }, data: input, select: customerSelect });
}

export async function updateSecuritySettings(customerId: string, input: SecuritySettingsInput) {
  return prisma.customer.update({ where: { id: customerId }, data: input, select: customerSelect });
}

// Derive a service's status from its end date (no stored status column).
function deriveStatus(endDate: Date): 'ACTIVE' | 'EXPIRING' | 'EXPIRED' {
  const days = (endDate.getTime() - Date.now()) / 86400_000;
  if (days < 0) return 'EXPIRED';
  if (days < 30) return 'EXPIRING';
  return 'ACTIVE';
}

export async function getMyServices(customerId: string) {
  const purchases = await prisma.customerService.findMany({
    where: { customerId },
    orderBy: { endDate: 'asc' },
    include: {
      service: { select: { name: true, description: true, monthlyPrice: true, parent: { select: { name: true } } } },
    },
  });

  const services = purchases.map((p) => ({
    id: p.id,
    name: p.service.parent ? `${p.service.parent.name} — ${p.service.name}` : p.service.name,
    description: p.service.description,
    status: deriveStatus(p.endDate),
    enabled: true,
    monthlyPrice: p.service.monthlyPrice,
    purchasedAt: p.purchaseDate,
    renewsAt: p.endDate,
    lastBilledAt: null as Date | null,
  }));

  const monthlyTotal = services
    .filter((s) => s.status !== 'EXPIRED')
    .reduce((sum, s) => sum + s.monthlyPrice, 0);

  return { services, monthlyTotal };
}

