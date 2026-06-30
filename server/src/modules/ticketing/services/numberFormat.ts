import { prisma } from '../../../config/database';
import { deriveOrgCode } from '../../../utils/orgCode';

// The platform-wide ticket-number format (main DB, single "default" row), plus
// resolution of an org's code. Consumed by the ticketing service when it
// allocates a number. Kept here so the ticketing module owns the read path while
// the saas-admin module owns the write path.

export interface NumberFormat {
  prefix: string;
  includeOrgCode: boolean;
  separator: string;
  padWidth: number;
}

export const DEFAULT_FORMAT: NumberFormat = { prefix: 'TKT', includeOrgCode: false, separator: '-', padWidth: 3 };

export async function getTicketNumberFormat(): Promise<NumberFormat> {
  const row = await prisma.ticketNumberSetting.findUnique({ where: { id: 'default' } });
  if (!row) return DEFAULT_FORMAT;
  return { prefix: row.prefix, includeOrgCode: row.includeOrgCode, separator: row.separator, padWidth: row.padWidth };
}

// Org code for the B2B customer creating a ticket — falls back to a derived code
// when the customer has none set yet (so numbering works without a backfill).
export async function resolveOrgCode(b2bCustomerId: string | null | undefined): Promise<string | null> {
  if (!b2bCustomerId) return null;
  const c = await prisma.customer.findUnique({ where: { id: b2bCustomerId }, select: { orgCode: true, name: true } });
  if (!c) return null;
  return c.orgCode ?? deriveOrgCode(c.name);
}
