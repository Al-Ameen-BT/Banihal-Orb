import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { ticketPrisma, adminTicketPrisma } from '../src/config/ticketDatabase';

// Tickets are compliance records: they are never deletable, for any role. The
// DELETE endpoint has been REMOVED, so no actor — org admin, platform admin,
// tickets.write holder — can delete a ticket. These pin that.
//
// Skipped LOUDLY when no *_test ticket store is configured: they need a ticket
// to exist before proving it cannot go away.
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

describe.skipIf(!ready)('tickets are non-deletable (compliance)', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it(`no delete endpoint exists — an ORG_ADMIN cannot delete a ticket${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, async () => {
    const org = await createTestOrg('Compliance Org');
    await createTestUser(org.id, 'comp-admin@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('comp-admin@example.com');

    const ticket = await createTicket(cookies);
    const res = await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', cookies);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(await ticketPrisma.tickets.count({ where: { id: ticket.id } })).toBe(1);
  });

  it('a PLATFORM admin cannot delete a ticket either', async () => {
    const org = await createTestOrg('Platform Compliance Org');
    await createTestUser(org.id, 'pf-admin@example.com', 'ADMINISTRATOR');
    const cookies = await loginAs('pf-admin@example.com');

    const ticket = await createTicket(cookies);
    const res = await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', cookies);

    expect(res.status).toBe(404);
    // Platform staff's tickets live in the ADMIN store (ticket.store.admin).
    expect(await adminTicketPrisma.tickets.count({ where: { id: ticket.id } })).toBe(1);
  });

  it('an EMPLOYEE — holder of tickets.write — cannot delete a ticket either', async () => {
    const org = await createTestOrg('Employee Compliance Org');
    await createTestUser(org.id, 'emp@example.com', 'ADMINISTRATOR', 'employee');
    const cookies = await loginAs('emp@example.com');

    const ticket = await createTicket(cookies);
    const res = await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', cookies);

    expect(res.status).toBe(404);
    expect(await adminTicketPrisma.tickets.count({ where: { id: ticket.id } })).toBe(1);
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
