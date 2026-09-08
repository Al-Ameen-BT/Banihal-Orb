import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { ticketPrisma, adminTicketPrisma } from '../src/config/ticketDatabase';

// Edit lock on TICKET mutations — OWNER-BASED:
//   - plain USER      → may edit only a ticket they opened (reporter)
//   - ORG_ADMIN       → may edit any ticket inside their org scope
//   - platform staff  → may edit ONLY a ticket they OWN (reporter OR assignee)
//                       and only while holding the `tickets.write` permission.
// Locked out: everyone else — including an employee/HR admin who merely sees a
// colleague's ticket in the shared queue.
//
// assertCanEditTicket lives in the controller (role + reporterId/assigneeId); the
// routes are open to every authenticated user so a creator plain USER is not cut
// off by the old staffWrite gate. assertTicketAccess still 404s tickets outside
// the caller's scope BEFORE the lock, and the lock itself returns
// 403 TICKET_EDIT_FORBIDDEN. Commenting is deliberately not part of the lock.
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

    // Bridge the assignee into the default store (they act once) so they appear in
    // the org assignee pool with a real ticket-store id we can assign. Creating a
    // project is staffWrite and a plain USER gets FORBIDDEN — listing their own
    // tickets resolves (bridges) the actor without writing anything.
    const assigneeCookies = await loginAs('assignee@example.com');
    await request(app).get('/api/ticketing/tickets?mine=true').set('Cookie', assigneeCookies).expect(200);

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

  it('locks a platform staff member out of a ticket they do not own — 403 TICKET_EDIT_FORBIDDEN', async () => {
    const org = await createTestOrg('Non-Owner Lock Org');
    await createTestUser(org.id, 'owner@example.com', 'ADMINISTRATOR', 'employee');
    // HR Admin holds tickets.write AND ticket.store.admin, so they reach the lock.
    await createTestUser(org.id, 'hr@example.com', 'ADMINISTRATOR', 'hr_admin');

    const ownerCookies = await loginAs('owner@example.com');
    const ticket = await createTicket(ownerCookies, 'Owned by the employee');

    const hrCookies = await loginAs('hr@example.com');
    const denied = await request(app).patch(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', hrCookies)
      .send({ title: 'HR recasts it' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('TICKET_EDIT_FORBIDDEN');

    const deniedDelete = await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', hrCookies);
    expect(deniedDelete.status).toBe(403);

    expect(await adminTicketPrisma.tickets.findUnique({ where: { id: ticket.id }, select: { title: true } }))
      .toMatchObject({ title: 'Owned by the employee' });
  });

  it('lets the ASSIGNEE (owner) edit a ticket they did not create', async () => {
    const org = await createTestOrg('Assignee Owner Org');
    await createTestUser(org.id, 'creator-a@example.com', 'ADMINISTRATOR', 'employee');
    await createTestUser(org.id, 'assignee-b@example.com', 'ADMINISTRATOR', 'employee');

    const bCookies = await loginAs('assignee-b@example.com');
    // Bridge B into the admin store so they are a real assignee id A can point at.
    await createProject(bCookies, `Bridge ${Math.random().toString(36).slice(2, 8)}`);

    const aCookies = await loginAs('creator-a@example.com');
    const pool = (await request(app).get('/api/ticketing/assignees').set('Cookie', aCookies).expect(200)).body.assignees as Array<{ id: string; email: string }>;
    const bId = pool.find((p) => p.email === 'assignee-b@example.com');
    expect(bId, 'B must be in the admin assignee pool').toBeDefined();

    const ticket = await createTicket(aCookies, 'Assigned to B', bId!.id);

    // B owns the ticket via assigneeId — editing must succeed despite never creating it.
    const allowed = await request(app).patch(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', bCookies)
      .send({ title: 'B owns this one' });
    expect(allowed.status).toBe(200);
    expect(await adminTicketPrisma.tickets.findUnique({ where: { id: ticket.id }, select: { title: true } }))
      .toMatchObject({ title: 'B owns this one' });
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