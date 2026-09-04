import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { app, request, createTestOrg, createTestUser, loginAs, cleanDb } from './helpers';
import { prisma } from '../src/config/database';

// Organization deletion is irreversible and spans four databases. These pin the
// two things that matter: the refusals that stop it happening by accident, and
// that the audit trail SURVIVES the organization it describes.

const del = (orgId: string, cookies: string[]) =>
  request(app).delete(`/api/saas-admin/orgs/${orgId}`).set('Cookie', cookies);

let adminCookies: string[];
let platformOrgId: string;

beforeEach(async () => {
  await cleanDb();
  const platform = await createTestOrg('Provider Co');
  platformOrgId = platform.id;
  await createTestUser(platformOrgId, 'admin@example.com', 'ADMINISTRATOR', 'administration');
  adminCookies = await loginAs('admin@example.com');
});
afterAll(async () => { await cleanDb(); await prisma.$disconnect(); });

/** A suspended client org with a member — the deletable baseline. */
async function deletableOrg(name = 'Doomed Ltd') {
  const org = await createTestOrg(name);
  await createTestUser(org.id, `member@${org.slug}.test`, 'USER');
  await prisma.customer.update({ where: { id: org.id }, data: { suspended: true } });
  return org;
}

describe('refusals — each blocks a different accident', () => {
  it('refuses an organization that is not suspended', async () => {
    const org = await createTestOrg('Live Ltd');
    await createTestUser(org.id, 'live@member.test', 'USER');

    const res = await del(org.id, adminCookies);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_SUSPENDED');
    expect(await prisma.customer.count({ where: { id: org.id } })).toBe(1);
  });

  it('refuses the provider organization — it holds the platform staff', async () => {
    // Deliberately NOT suspended: the provider guard fires first, and suspending
    // the acting admin's own org would log them out before the handler runs.
    const res = await del(platformOrgId, adminCookies);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PROVIDER_ORG');
    expect(await prisma.customer.count({ where: { id: platformOrgId } })).toBe(1);
  });

  it('refuses a role without orgs.delete, even one that can edit orgs', async () => {
    const org = await deletableOrg();
    // employee holds neither orgs.manage nor orgs.delete.
    await createTestUser(platformOrgId, 'employee@example.com', 'ADMINISTRATOR', 'employee');
    const employeeCookies = await loginAs('employee@example.com');

    expect((await del(org.id, employeeCookies)).status).toBe(403);
    expect(await prisma.customer.count({ where: { id: org.id } })).toBe(1);
  });

  it('404s an unknown organization', async () => {
    expect((await del('clnonexistent00000000000', adminCookies)).status).toBe(404);
  });
});

describe('a successful deletion clears the org and keeps the record', () => {
  it('removes the organization and its users', async () => {
    const org = await deletableOrg();

    const res = await del(org.id, adminCookies);

    expect(res.status).toBe(200);
    expect(res.body.orgName).toBe('Doomed Ltd');
    expect(res.body.users).toBe(1);
    expect(await prisma.customer.count({ where: { id: org.id } })).toBe(0);
    expect(await prisma.user.count({ where: { customerId: org.id } })).toBe(0);
  });

  it('RETAINS the audit trail — the record outlives the organization', async () => {
    const org = await deletableOrg();
    // A pre-existing row for this org, to prove history is not swept with it.
    await prisma.auditLog.create({
      data: { action: 'LOGIN', performedById: null, customerId: org.id, metadata: {} },
    });

    await del(org.id, adminCookies);

    const rows = await prisma.auditLog.findMany({ where: { customerId: org.id } });
    expect(rows.length, 'audit rows must survive the org they describe').toBeGreaterThanOrEqual(2);
    const deletion = rows.find((r) => r.action === 'ORG_DELETED');
    expect(deletion, 'the deletion itself must be recorded').toBeDefined();
    expect((deletion!.metadata as { orgName?: string }).orgName).toBe('Doomed Ltd');
  });

  it('purges the FK-less tables nothing cascades', async () => {
    const org = await deletableOrg();
    await prisma.slackBotOrg.create({ data: { botId: 'bot-x', customerId: org.id } }).catch(() => {});

    await del(org.id, adminCookies);

    expect(await prisma.slackBotOrg.count({ where: { customerId: org.id } })).toBe(0);
    expect(await prisma.adCredentialDelivery.count({ where: { customerId: org.id } })).toBe(0);
    expect(await prisma.botTicketSubmission.count({ where: { customerId: org.id } })).toBe(0);
  });

  it('keeps GLOBAL announcements — they are not the org’s data', async () => {
    const org = await deletableOrg();
    const author = await prisma.user.findFirst({ where: { customerId: platformOrgId } });
    const global = await prisma.announcement.create({
      data: { title: 'Platform notice', message: 'x', level: 'INFO', createdById: author!.id, customerId: null },
    });

    await del(org.id, adminCookies);

    expect(await prisma.announcement.count({ where: { id: global.id } })).toBe(1);
  });
});
