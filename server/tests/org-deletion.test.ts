import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { app, request, createTestOrg, createTestUser, loginAs, cleanDb, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { runWithTicketDb, getTicketDb } from '../src/config/ticketDatabase';

// Organization deletion is irreversible and spans four databases. These pin the
// two things that matter: the refusals that stop it happening by accident, and
// that the audit trail SURVIVES the organization it describes — plus that the
// ticket stores are ALWAYS retained (tickets are compliance records, never
// deleted, for platform admin and org admin alike).

const del = (orgId: string, cookies: string[], data: { confirm?: string } = {}) =>
  request(app).delete(`/api/saas-admin/orgs/${orgId}`).set('Cookie', cookies).send({
    confirm: data.confirm ?? '',
  });

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

/** Insert a believable ticket row (customer + user + project + ticket) into one store. */
async function seedStoreTicket(scope: 'default' | 'admin', orgName: string, email: string, ticketNumber: string) {
  return runWithTicketDb(scope, async () => {
    const db = getTicketDb();
    const customer = await db.customers.create({ data: { name: orgName, email }});
    const user = await db.users.create({
      data: { firstName: 'Member', lastName: 'Test', email, password: 'x', role: 'admin' },
    });
    // Format is genuinely random (blank DM, internal, etc.) — mimic seed-tickets.ts.
    const project = await db.projects.create({
      data: { name: `Proj ${ticketNumber}`, category: 'internal', leadId: user.id, type: 'software' },
    });
    await db.tickets.create({
      data: {
        ticketNumber, title: `Ticket ${ticketNumber}`, description: 'x', status: 'todo',
        projectId: project.id, reporterId: user.id, createdBy: user.id, customerId: customer.id,
        labels: ['org:' + orgName],
      },
    });
  });
}

/**
 * The FK trap. A ticket owned by ANOTHER organization that a member of the org
 * being deleted merely touched: assigned to them, commented on, with an activity
 * line. The purge's sweep never claims it — different reporter, creator and
 * customer — and every pointer at Users in both stores is ON DELETE NO ACTION,
 * so deleting the member row used to fail with P2003 *after* the org's own
 * tickets and their attachment files had already been destroyed.
 */
async function seedForeignTicketTouchedBy(scope: 'default' | 'admin', memberEmail: string, ticketNumber: string) {
  return runWithTicketDb(scope, async () => {
    const db = getTicketDb();
    const other = await db.customers.create({ data: { name: `Other Co ${ticketNumber}`, email: `owner-${ticketNumber}@example.com` } });
    const owner = await db.users.create({
      data: { firstName: 'Other', lastName: 'Owner', email: `owner-${ticketNumber}@example.com`, password: 'x', role: 'admin' },
    });
    const member = await db.users.upsert({
      where: { email: memberEmail }, update: {},
      create: { firstName: 'Member', lastName: 'Test', email: memberEmail, password: 'x', role: 'admin' },
    });
    const project = await db.projects.create({
      data: { name: `Other ${ticketNumber}`, category: 'internal', leadId: owner.id, type: 'software' },
    });
    const ticket = await db.tickets.create({
      data: {
        ticketNumber, title: `Foreign ${ticketNumber}`, description: 'x', status: 'todo',
        projectId: project.id, reporterId: owner.id, createdBy: owner.id,
        assigneeId: member.id, customerId: other.id,
      },
    });
    await db.comments.create({ data: { ticketId: ticket.id, userId: member.id, content: 'looked at this' } });
    await db.activities.create({ data: { ticketId: ticket.id, userId: member.id, type: 'assigned', description: 'x' } });
    return ticket.id;
  });
}

/** Assert a ticket still exists for the org in a store (the keep-tickets case). */
async function storeTicketCount(scope: 'default' | 'admin', orgName: string) {
  return runWithTicketDb(scope, () =>
    getTicketDb().tickets.count({ where: { Customers: { is: { name: orgName } } } }));
}

describe('refusals — each blocks a different accident', () => {
  it('refuses an organization that is not suspended', async () => {
    const org = await createTestOrg('Live Ltd');
    await createTestUser(org.id, 'live@member.test', 'USER');

    const res = await del(org.id, adminCookies, { confirm: 'Live Ltd' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_SUSPENDED');
    expect(await prisma.customer.count({ where: { id: org.id } })).toBe(1);
  });

  it('refuses the provider organization — it holds the platform staff', async () => {
    // Deliberately NOT suspended: the provider guard fires first, and suspending
    // the acting admin's own org would log them out before the handler runs.
    const res = await del(platformOrgId, adminCookies, { confirm: 'Provider Co' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PROVIDER_ORG');
    expect(await prisma.customer.count({ where: { id: platformOrgId } })).toBe(1);
  });

  it('refuses a mistyped confirmation name', async () => {
    const org = await deletableOrg();

    const res = await del(org.id, adminCookies, { confirm: 'not the name' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIRM_MISMATCH');
    expect(await prisma.customer.count({ where: { id: org.id } })).toBe(1);
  });

  it('refuses a role without orgs.delete, even one that can edit orgs', async () => {
    const org = await deletableOrg();
    // employee holds neither orgs.manage nor orgs.delete.
    await createTestUser(platformOrgId, 'employee@example.com', 'ADMINISTRATOR', 'employee');
    const employeeCookies = await loginAs('employee@example.com');

    expect((await del(org.id, employeeCookies, { confirm: 'Doomed Ltd' })).status).toBe(403);
    expect(await prisma.customer.count({ where: { id: org.id } })).toBe(1);
  });

  it('refuses intern — no permission is ever implicit, whatever the page guard lets through', async () => {
    const org = await deletableOrg();
    await createTestUser(platformOrgId, 'intern@example.com', 'ADMINISTRATOR', 'intern');
    const internCookies = await loginAs('intern@example.com');

    expect((await del(org.id, internCookies, { confirm: 'Doomed Ltd' })).status).toBe(403);
    expect(await prisma.customer.count({ where: { id: org.id } })).toBe(1);
  });

  it('404s an unknown organization', async () => {
    expect((await del('clnonexistent00000000000', adminCookies, { confirm: 'x' })).status).toBe(404);
  });
});

describe('a successful deletion clears the org and keeps the record', () => {
  it('removes the organization and its users', async () => {
    const org = await deletableOrg();

    const res = await del(org.id, adminCookies, { confirm: 'Doomed Ltd' });

    expect(res.status).toBe(200);
    expect(res.body.orgName).toBe('Doomed Ltd');
    expect(res.body.users).toBe(1);
    expect(res.body.mode).toBe('keep_tickets');
    expect(res.body.tickets).toBe(0);
    expect(await prisma.customer.count({ where: { id: org.id } })).toBe(0);
    expect(await prisma.user.count({ where: { customerId: org.id } })).toBe(0);
  });

  it('HR ADMIN can delete an organization — the page edits orgs, the delete needs its own key', async () => {
    const org = await deletableOrg();
    await createTestUser(platformOrgId, 'hr@example.com', 'ADMINISTRATOR', 'hr_admin');
    const hrCookies = await loginAs('hr@example.com');

    const res = await del(org.id, hrCookies, { confirm: 'Doomed Ltd' });

    expect(res.status).toBe(200);
    expect(await prisma.customer.count({ where: { id: org.id } })).toBe(0);
  });

  it('RETAINS the audit trail — the record outlives the organization', async () => {
    const org = await deletableOrg();
    // A pre-existing row for this org, to prove history is not swept with it.
    await prisma.auditLog.create({
      data: { action: 'LOGIN', performedById: null, customerId: org.id, metadata: {} },
    });

    await del(org.id, adminCookies, { confirm: 'Doomed Ltd' });

    const rows = await prisma.auditLog.findMany({ where: { customerId: org.id } });
    expect(rows.length, 'audit rows must survive the org they describe').toBeGreaterThanOrEqual(2);
    const deletion = rows.find((r) => r.action === 'ORG_DELETED');
    expect(deletion, 'the deletion itself must be recorded').toBeDefined();
    expect((deletion!.metadata as { orgName?: string }).orgName).toBe('Doomed Ltd');
    expect((deletion!.metadata as { mode?: string }).mode).toBe('keep_tickets');
  });

  it('purges the FK-less tables nothing cascades', async () => {
    const org = await deletableOrg();
    await prisma.slackBotOrg.create({ data: { botId: 'bot-x', customerId: org.id } }).catch(() => {});

    await del(org.id, adminCookies, { confirm: 'Doomed Ltd' });

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

    await del(org.id, adminCookies, { confirm: 'Doomed Ltd' });

    expect(await prisma.announcement.count({ where: { id: global.id } })).toBe(1);
  });
});

describe.skipIf(!ticketTestDbReady())(`ticketing history — retained for compliance${ticketTestDbReady() ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, () => {
  it('deletes the org but leaves BOTH ticket stores intact', async () => {
    const org = await deletableOrg(`Keep Tix ${Date.now()}`);
    const name = org.name;
    const email = `keep-tix-${Date.now()}@example.com`;
    await seedStoreTicket('default', name, email, `TKT-KT-${String(Date.now()).slice(-5)}`);
    await seedStoreTicket('admin', name, email, `TKT-KA-${String(Date.now()).slice(-5)}`);

    const res = await del(org.id, adminCookies, { confirm: name });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mode).toBe('keep_tickets');
    expect(res.body.tickets).toBe(0);
    expect(await prisma.customer.count({ where: { id: org.id } })).toBe(0);
    expect(await storeTicketCount('default', name)).toBe(1);
    expect(await storeTicketCount('admin', name)).toBe(1);
  });

  it('retains tickets in BOTH stores — no mode deletes them', async () => {
    const org = await deletableOrg(`Wipe Tix ${Date.now()}`);
    const name = org.name;
    const email = `wipe-tix-${Date.now()}@example.com`;
    await seedStoreTicket('default', name, email, `TKT-WT-${String(Date.now()).slice(-5)}`);
    await seedStoreTicket('admin', name, email, `TKT-WA-${String(Date.now()).slice(-5)}`);

    const res = await del(org.id, adminCookies, { confirm: name });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mode).toBe('keep_tickets');
    expect(res.body.tickets).toBe(0);
    // The org is gone from the main database, but its tickets — and the store-local
    // user/customer rows they reference — are compliance records and stay.
    expect(await storeTicketCount('default', name)).toBe(1);
    expect(await storeTicketCount('admin', name)).toBe(1);
  });

  it('leaves an org whose member touched ANOTHER org\'s ticket completely intact', async () => {
    const stamp = String(Date.now()).slice(-6);
    const org = await deletableOrg(`FK Trap ${stamp}`);
    const member = await prisma.user.findFirstOrThrow({ where: { customerId: org.id } });
    // The production shape: the org owns tickets of its own in the store AND its
    // member holds rows on someone else's ticket.
    await seedStoreTicket('default', org.name, member.email.toLowerCase(), `TKT-FKO-${stamp}`);
    const foreign = await seedForeignTicketTouchedBy('default', member.email.toLowerCase(), `TKT-FK-${stamp}`);

    const res = await del(org.id, adminCookies, { confirm: org.name });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await prisma.customer.count({ where: { id: org.id } })).toBe(0);

    // The stores are left WHOLE: the other org's ticket, its assignee, the member's
    // comment and activity all survive — deletion of the departing member never
    // reaches into the stores, so there is nothing to detach or delete.
    const left = await runWithTicketDb('default', async () => {
      const db = getTicketDb();
      return {
        ticket: await db.tickets.findUnique({ where: { id: foreign }, select: { assigneeId: true } }),
        comments: await db.comments.count({ where: { ticketId: foreign } }),
        activities: await db.activities.count({ where: { ticketId: foreign } }),
      };
    });
    expect(left.ticket).not.toBeNull();
    expect(left.ticket!.assigneeId).not.toBeNull();
    expect(left.comments).toBe(1);
    expect(left.activities).toBe(1);
    // The org's OWN ticket survives too, attributed as it always was.
    expect(await storeTicketCount('default', org.name)).toBe(1);
  });
});
