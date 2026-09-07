import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { ticketPrisma, adminTicketPrisma } from '../src/config/ticketDatabase';

// DELETE /ticketing/tickets/:id and the audit rows the ticketing module now writes.
//
// Skipped LOUDLY when no *_test ticket store is configured: these assertions are
// about real cascade behaviour and a real cross-database audit write, so a green
// tick without a database would claim guarantees nothing checked.
const ready = ticketTestDbReady();

/** Tickets.projectId is NOT NULL, so every ticket needs a project to hang off. */
async function createProject(cookies: string[]): Promise<string> {
  const res = await request(app).post('/api/ticketing/projects').set('Cookie', cookies)
    .send({ name: `Vitest Project ${Math.random().toString(36).slice(2, 8)}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

/** Raise a ticket through the API as the logged-in caller. */
async function createTicket(cookies: string[], title = 'Printer offline') {
  const projectId = await createProject(cookies);
  const res = await request(app).post('/api/ticketing/tickets').set('Cookie', cookies).send({
    title, description: 'It shows offline and nothing prints.', type: 'task', priority: 'medium', projectId,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; ticketNumber: string };
}

describe.skipIf(!ready)('DELETE /ticketing/tickets/:id', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it(`removes the ticket${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, async () => {
    const org = await createTestOrg('Delete Ticket Org');
    await createTestUser(org.id, 'del-admin@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('del-admin@example.com');

    const ticket = await createTicket(cookies);
    const res = await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', cookies);
    expect(res.status).toBe(204);

    expect(await ticketPrisma.tickets.count({ where: { id: ticket.id } })).toBe(0);
  });

  it('cascades the ticket’s comments and activity away with it', async () => {
    const org = await createTestOrg('Cascade Org');
    await createTestUser(org.id, 'cascade-admin@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('cascade-admin@example.com');

    const ticket = await createTicket(cookies);
    await request(app).post(`/api/ticketing/tickets/${ticket.id}/comments`)
      .set('Cookie', cookies).field('content', 'Looking into it');

    // Creation alone writes an activity row, so both counts are non-zero first —
    // otherwise "0 after" would prove nothing.
    expect(await ticketPrisma.comments.count({ where: { ticketId: ticket.id } })).toBeGreaterThan(0);
    expect(await ticketPrisma.activities.count({ where: { ticketId: ticket.id } })).toBeGreaterThan(0);

    await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', cookies).expect(204);

    expect(await ticketPrisma.comments.count({ where: { ticketId: ticket.id } })).toBe(0);
    expect(await ticketPrisma.activities.count({ where: { ticketId: ticket.id } })).toBe(0);
    expect(await ticketPrisma.ticketWatchers.count({ where: { ticketId: ticket.id } })).toBe(0);
  });

  it('leaves a TICKET_DELETED audit row that OUTLIVES the ticket', async () => {
    // The whole reason the audit row is written to the MAIN database: the ticket's
    // own Activities history is ON DELETE CASCADE and dies with it.
    const org = await createTestOrg('Audit Delete Org');
    const admin = await createTestUser(org.id, 'audit-del@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('audit-del@example.com');

    const ticket = await createTicket(cookies, 'Ticket that will be deleted');
    await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', cookies).expect(204);

    const row = await prisma.auditLog.findFirst({
      where: { action: 'TICKET_DELETED', performedById: admin.id, targetId: ticket.id },
    });
    expect(row).not.toBeNull();
    expect((row?.metadata as { ticketNumber?: string })?.ticketNumber).toBe(ticket.ticketNumber);
    // ...and the thing it describes really is gone.
    expect(await ticketPrisma.tickets.count({ where: { id: ticket.id } })).toBe(0);
  });

  it('refuses to delete an escalated ticket, and the ticket survives', async () => {
    const org = await createTestOrg('Escalated Delete Org');
    await createTestUser(org.id, 'esc-admin@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('esc-admin@example.com');

    const ticket = await createTicket(cookies);
    // The mirror lives in another database joined only by a label, so the guard is
    // the label — set it directly rather than running a full escalation.
    await ticketPrisma.tickets.update({ where: { id: ticket.id }, data: { labels: ['escalated'] } });

    const res = await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', cookies);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TICKET_ESCALATED');
    expect(await ticketPrisma.tickets.count({ where: { id: ticket.id } })).toBe(1);
  });

  it('denies a plain USER', async () => {
    const org = await createTestOrg('User Delete Org');
    await createTestUser(org.id, 'plain-user@example.com', 'USER');
    await createTestUser(org.id, 'owner-admin@example.com', 'ORG_ADMIN');

    const adminCookies = await loginAs('owner-admin@example.com');
    const ticket = await createTicket(adminCookies);

    const userCookies = await loginAs('plain-user@example.com');
    const res = await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', userCookies);
    expect([401, 403]).toContain(res.status);
    expect(await ticketPrisma.tickets.count({ where: { id: ticket.id } })).toBe(1);
  });

  it('denies an INTERN but allows an EMPLOYEE — the tickets.write split', async () => {
    // plr_intern deliberately lacks tickets.write ("read-only: no ticket edits");
    // plr_employee has it. staffWrite is what encodes that, and this proves the new
    // route inherited it rather than inventing its own rule.
    const org = await createTestOrg('Platform Staff Org');
    await createTestUser(org.id, 'intern@example.com', 'ADMINISTRATOR', 'intern');
    await createTestUser(org.id, 'employee@example.com', 'ADMINISTRATOR', 'employee');

    const employeeCookies = await loginAs('employee@example.com');
    const ticket = await createTicket(employeeCookies);

    // Platform staff hold ticket.store.admin, so their tickets live in the ADMIN
    // store — counting in the default one would find nothing and prove nothing.
    const store = adminTicketPrisma;

    const internCookies = await loginAs('intern@example.com');
    const denied = await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', internCookies);
    expect(denied.status).toBe(403);
    expect(await store.tickets.count({ where: { id: ticket.id } })).toBe(1);

    await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', employeeCookies).expect(204);
    expect(await store.tickets.count({ where: { id: ticket.id } })).toBe(0);
  });

  it('404s (not 403) for another org’s ticket', async () => {
    // assertTicketAccess answers 404 on purpose — a 403 would confirm the id exists.
    const orgA = await createTestOrg('Owner Org');
    const orgB = await createTestOrg('Other Org');
    await createTestUser(orgA.id, 'a-admin@example.com', 'ORG_ADMIN');
    await createTestUser(orgB.id, 'b-admin@example.com', 'ORG_ADMIN');

    const aCookies = await loginAs('a-admin@example.com');
    const ticket = await createTicket(aCookies);

    const bCookies = await loginAs('b-admin@example.com');
    const res = await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', bCookies);
    expect(res.status).toBe(404);
    expect(await ticketPrisma.tickets.count({ where: { id: ticket.id } })).toBe(1);
  });
});

describe.skipIf(!ready)('ticket audit logging', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it(`records creation and edits${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, async () => {
    const org = await createTestOrg('Audit Trail Org');
    const admin = await createTestUser(org.id, 'trail@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('trail@example.com');

    const ticket = await createTicket(cookies, 'Original title');
    const created = await prisma.auditLog.findFirst({
      where: { action: 'TICKET_CREATED', performedById: admin.id, targetId: ticket.id },
    });
    expect(created).not.toBeNull();

    await request(app).patch(`/api/ticketing/tickets/${ticket.id}`)
      .set('Cookie', cookies).send({ title: 'Corrected title' }).expect(200);

    const updated = await prisma.auditLog.findFirst({
      where: { action: 'TICKET_UPDATED', performedById: admin.id, targetId: ticket.id },
    });
    expect(updated).not.toBeNull();
    // Field NAMES are recorded, never the values — a description can be 10k chars.
    expect((updated?.metadata as { fields?: string[] })?.fields).toEqual(['title']);
  });

  it('writes an activity row when the title is edited', async () => {
    const org = await createTestOrg('Edit Activity Org');
    await createTestUser(org.id, 'editact@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('editact@example.com');

    const ticket = await createTicket(cookies, 'Before');
    await request(app).patch(`/api/ticketing/tickets/${ticket.id}`)
      .set('Cookie', cookies).send({ title: 'After' }).expect(200);

    const activity = await ticketPrisma.activities.findFirst({
      where: { ticketId: ticket.id, type: 'updated', field: 'title' },
    });
    expect(activity).not.toBeNull();
    expect(activity?.newValue).toBe('After');
  });
});
