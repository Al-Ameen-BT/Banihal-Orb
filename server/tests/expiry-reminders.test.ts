import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, cleanDb } from './helpers';
import { prisma } from '../src/config/database';
import { runExpiryReminders } from '../src/services/expiryReminders';

// ─── Service expiry reminders: cadence windows + once-per-window dedupe ──────
describe('Service expiry reminders', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it('mails on the matching window day, bookmarks the service, and never re-mails that day', async () => {
    const org = await createTestOrg('Remind Co');
    await createTestUser(org.id, 'admin@remind.test', 'ORG_ADMIN');
    const svc = await prisma.customerService.create({
      data: { customerId: org.id, name: 'Squid Proxy', monthlyPrice: 0, endDate: new Date(Date.now() + 7 * 86400_000) },
    });

    expect(await runExpiryReminders()).toBe(1);
    const marked = await prisma.customerService.findUnique({ where: { id: svc.id }, select: { lastRemindedAt: true } });
    expect(marked?.lastRemindedAt).not.toBeNull();

    // Same day → the window already mailed; the bookmark blocks a duplicate.
    expect(await runExpiryReminders()).toBe(0);
  });

  it('sends a single final notice for a service that expired without ever being reminded', async () => {
    const org = await createTestOrg('Expired Co');
    await prisma.customerService.create({
      data: { customerId: org.id, name: 'VPN License', monthlyPrice: 0, endDate: new Date(Date.now() - 86400_000) },
    });
    expect(await runExpiryReminders()).toBe(1);
    expect(await runExpiryReminders()).toBe(0);
  });
});