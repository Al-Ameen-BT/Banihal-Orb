import { query, queryOne, buildSet } from '../../config/db';
import type { UpdateOrgInput, SecuritySettingsInput } from './organizations.schema';

// Columns returned to org-facing callers (matches the former Prisma customerSelect).
// `customers` is the mapped table name for the Customer model.
const CUSTOMER_COLS =
  '"id","name","slug","plan","suspended","ssoEnabled","mfaRequired","creditLimit","mailId","contactPerson","contactNumber","domain","createdAt","updatedAt"';

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  suspended: boolean;
  ssoEnabled: boolean;
  mfaRequired: boolean;
  creditLimit: number;
  mailId: string;
  contactPerson: string;
  contactNumber: string;
  domain: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const notFound = () => Object.assign(new Error('Customer not found'), { status: 404, code: 'NOT_FOUND' });

export async function getMyOrg(customerId: string): Promise<OrgRow> {
  const customer = await queryOne<OrgRow>(`SELECT ${CUSTOMER_COLS} FROM "customers" WHERE "id" = $1`, [customerId]);
  if (!customer) throw notFound();
  return customer;
}

export async function updateMyOrg(customerId: string, input: UpdateOrgInput): Promise<OrgRow> {
  // buildSet appends "updatedAt" = now() (Prisma's @updatedAt was client-side).
  const { sql, params, nextIndex } = buildSet(input as Record<string, unknown>);
  const customer = await queryOne<OrgRow>(
    `UPDATE "customers" SET ${sql} WHERE "id" = $${nextIndex} RETURNING ${CUSTOMER_COLS}`,
    [...params, customerId],
  );
  if (!customer) throw notFound();
  return customer;
}

export async function updateSecuritySettings(customerId: string, input: SecuritySettingsInput): Promise<OrgRow> {
  const { sql, params, nextIndex } = buildSet(input as Record<string, unknown>);
  const customer = await queryOne<OrgRow>(
    `UPDATE "customers" SET ${sql} WHERE "id" = $${nextIndex} RETURNING ${CUSTOMER_COLS}`,
    [...params, customerId],
  );
  if (!customer) throw notFound();
  return customer;
}

// Derive a service's status from its end date (no stored status column).
function deriveStatus(endDate: Date): 'ACTIVE' | 'EXPIRING' | 'EXPIRED' {
  const days = (endDate.getTime() - Date.now()) / 86400_000;
  if (days < 0) return 'EXPIRED';
  if (days < 30) return 'EXPIRING';
  return 'ACTIVE';
}

interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  monthlyPrice: number;
  purchaseDate: Date;
  endDate: Date;
}

export async function getMyServices(customerId: string) {
  // `customerServices` is the mapped table; customerId is the caller's own org.
  const purchases = await query<ServiceRow>(
    `SELECT "id","name","description","monthlyPrice","purchaseDate","endDate"
       FROM "customerServices" WHERE "customerId" = $1 ORDER BY "endDate" ASC`,
    [customerId],
  );

  const services = purchases.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    status: deriveStatus(p.endDate),
    enabled: true,
    monthlyPrice: p.monthlyPrice,
    purchasedAt: p.purchaseDate,
    renewsAt: p.endDate,
    lastBilledAt: null as Date | null,
  }));

  const monthlyTotal = services
    .filter((s) => s.status !== 'EXPIRED')
    .reduce((sum, s) => sum + s.monthlyPrice, 0);

  return { services, monthlyTotal };
}
