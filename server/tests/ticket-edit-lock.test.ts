import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { ticketPrisma, adminTicketPrisma } from '../src/config/ticketDatabase';

// Edit lock on TICKET mutations: only the ticket CREATOR (any role), platform
// ADMINISTRATOR and ORG_ADMIN may PATCH/DELETE. Locked out: everyone else —
// including the assignee who did not open the ticket.
//
// assertCanEditTicket lives in the controller (role + reporterId); the routes are
// open to every authenticated user so a creator plain USER is not cut off by the
// old staffWrite gate. assertTicketAccess still 404s tickets outside the caller's
// scope BEFORE the lock, and the lock itself returns 403 TICKET_EDIT_FORBIDDEN.
const ready = ticketTestDbReady();

async function createProject(cookies: string[], name = `Vitest Proj ${Math.random().toString(36).slice(2, 8)}`): Promise<string> {
  const res = await request(app).post('/api/ticketing/projects').set('Cookie', cookies).send({ name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

async function createTicket(cookies: string[], title = 'Under lock and key', assigneeId?: string) {
  const projectId = await createProject(cookies);
  const res = await request(app).post('/api/ticketing/tickets').set('Cookie', cookies).send({
    title, description: 'Who may touch this?', type: 'task', priority: 'medium', projectId, ...(assigneeId ? { assigneeId } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; ticketNumber: string };
}

describe.skipIf(!ready)('Ticket edit lock', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it(`lets a plain USER edit and delete their OWN ticket${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, async () => {
    const org = await createTestOrg('Creator Edit Org');
    await createTestUser(org.id, 'orgadmin@example.com', 'ORG_ADMIN');
    await createTestUser(org.id, 'creator@example.com', 'USER');

    // A plain USER cannot create a project (staffWrite route) — the org admin
    // provisions it, then the USER raises the ticket against it.
    const adminCookies = await loginAs('orgadmin@example.com');
    const projectId = await createProject(adminCookies);
    const userCookies = await loginAs('creator@example.com');
    const created = await request(app).post('/api/ticketing/tickets').set('Cookie', userCookies).send({
      title: 'Made by me', description: 'Mine to fix', type: 'task', priority: 'medium', projectId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const ticket = created.body as { id: string; ticketNumber: string };

    await request(app).patch(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', userCookies)
      .send({ title: 'Creator corrected me' }).expect(200);
    await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', userCookies).expect(204);
    expect(await ticketPrisma.tickets.count({ where: { id: ticket.id } })).toBe(0);
  });

  it('locks an assignee who is not the creator out of editing — 403 TICKET_EDIT_FORBIDDEN', async () => {
    const org = await createTestOrg('Assignee Lock Org');
    await createTestUser(org.id, 'boss@example.com', 'ORG_ADMIN');
    await createTestUser(org.id, 'assignee@example.com', 'USER');

    // Bridge the assignee into the default store (they act once), so they appear in
    // the org assignee pool with a real ticket-store id we can assign.
    const assigneeCookies = await loginAs('assignee@example.com');
    await createProject(assigneeCookies, `Bridge ${Math.random().toString(36).slice(2, 8)}`);

    const bossCookies = await loginAs('boss@example.com');
    const pool = (await request(app).get('/api/ticketing/assignees').set('Cookie', bossCookies).expect(200)).body.assignees as Array<{ id: string; email: string }>;
    const assigneeId = pool.find((a) => a.email === 'assignee@example.com');
    expect(assigneeId, 'assignee must be in the org pool').toBeDefined();

    const ticket = await createTicket(bossCookies, "Not the assignee's ticket", assigneeId!.id);

    // The assignee's scope includes them (owner via assigneeId), so this reaches the
    // EDIT LOCK itself — and the lock is what says no.
    const res = await request(app).patch(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', assigneeCookies)
      .send({ title: 'Assignees cannot reword it' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TICKET_EDIT_FORBIDDEN');
    expect(await ticketPrisma.tickets.findUnique({ where: { id: ticket.id }, select: { title: true } }))
      .toMatchObject({ title: "Not the assignee's ticket" });
  });

  it('keeps the tickets.write split for platform staff (intern denied, employee allowed)', async () => {
    const org = await createTestOrg('Platform Lock Org');
    await createTestUser(org.id, 'intern@example.com', 'ADMINISTRATOR', 'intern');
    await createTestUser(org.id, 'employee@example.com', 'ADMINISTRATOR', 'employee');

    const employeeCookies = await loginAs('employee@example.com');
    const ticket = await createTicket(employeeCookies, 'Platform ticket');

    const internCookies = await loginAs('intern@example.com');
    const denied = await request(app).patch(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', internCookies)
      .send({ title: 'Intern tries' });
    expect(denied.status).toBe(403);

    const allowed = await request(app).patch(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', employeeCookies)
      .send({ title: 'Employee (ADMINISTRATOR) may' });
    expect(allowed.status).toBe(200);
    expect(await adminTicketPrisma.tickets.findUnique({ where: { id: ticket.id }, select: { title: true } }))
      .toMatchObject({ title: 'Employee (ADMINISTRATOR) may' });
  });

  it('404s (not 403) the PATCH when the ticket is outside the caller’s scope', async () => {
    const org = await createTestOrg('Scope Org');
    await createTestUser(org.id, 'other-admin@example.com', 'ORG_ADMIN');
    await createTestUser(org.id, 'stranger@example.com', 'USER');

    const adminCookies = await loginAs('other-admin@example.com');
    const ticket = await createTicket(adminCookies);

    const strangerCookies = await loginAs('stranger@example.com');
    const res = await request(app).patch(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', strangerCookies)
      .send({ title: 'Not mine to touch' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});