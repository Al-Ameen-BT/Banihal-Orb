import { describe, it, expect } from 'vitest';
import { DEFAULT_FORMAT, getTicketNumberFormat, resolveOrgCode } from '../src/modules/ticketing/services/numberFormat';
import { prisma } from '../src/config/database';
import { createTestOrg } from './helpers';

// Per-org ticket codes: the org segment is the point of a multi-tenant support
// platform. When no platform-wide TicketNumberSetting exists the fallback used to
// disable org codes entirely and every ticket anywhere counted on one global
// TKT-NNN sequence. The default must now include the org code, and org codes
// resolve from the Application directory with a name-derived fallback.
describe('ticket number format', () => {
  it('defaults to per-org codes when no platform setting exists', async () => {
    await prisma.ticketNumberSetting.deleteMany({});
    expect(DEFAULT_FORMAT.includeOrgCode).toBe(true);
    expect((await getTicketNumberFormat()).includeOrgCode).toBe(true);
  });

  it('resolves the org code an organization has set', async () => {
    const tag = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const code = `C${tag.slice(-5).toUpperCase()}`;
    const org = await createTestOrg(`numbered-${tag}`);
    await prisma.customer.update({ where: { id: org.id }, data: { orgCode: code } });
    expect(await resolveOrgCode(org.id)).toBe(code);
  });

  it('falls back to a derived code when an organization has none set', async () => {
    const org = await createTestOrg('Acme Widgets');
    expect(await resolveOrgCode(org.id)).toBe('AW');
  });
});