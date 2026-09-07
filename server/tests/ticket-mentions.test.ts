import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { ticketPrisma, adminTicketPrisma } from '../src/config/ticketDatabase';

const ready = ticketTestDbReady();

/** Create a project + ticket as the caller. Returns the ticket. */
async function createTicket(cookies: string[]) {
  const proj = await request(app).post('/api/ticketing/projects').set('Cookie', cookies)
    .send({ name: `Mentions Project ${Math.random().toString(36).slice(2, 8)}` });
  expect(proj.status, JSON.stringify(proj.body)).toBe(201);
  const res = await request(app).post('/api/ticketing/tickets').set('Cookie', cookies).send({
    title: 'Mention me', description: 'Please look at this.', projectId: proj.body.id,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; ticketNumber: string };
}

/** The admin-store assignee roster, as the picker would see it. */
async function roster(cookies: string[]) {
  const res = await request(app).get('/api/ticketing/assignees').set('Cookie', cookies);
  expect(res.status).toBe(200);
  return res.body.assignees as Array<{ id: string; name: string; email: string }>;
}

describe.skipIf(!ready)('@mentions in ticket comments', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it(`notifies the mentioned person${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, async () => {
    const org = await createTestOrg('Mention Org');
    await createTestUser(org.id, 'author@example.com', 'ADMINISTRATOR', 'employee');
    const target = await createTestUser(org.id, 'target@example.com', 'ADMINISTRATOR', 'employee');

    const cookies = await loginAs('author@example.com');
    const ticket = await createTicket(cookies);
    const targetEntry = (await roster(cookies)).find((a) => a.email === 'target@example.com');
    expect(targetEntry, 'target must be in the admin roster').toBeDefined();

    await request(app).post(`/api/ticketing/tickets/${ticket.id}/comments`)
      .set('Cookie', cookies)
      .field('content', `@${targetEntry!.name} can you take a look?`)
      .field('mentions', targetEntry!.id)
      .expect(201);

    const notifs = await prisma.notification.findMany({ where: { userId: target.id } });
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.kind).toBe('ticket_mention');
    expect(notifs[0]!.url).toBe(`/ticketing?ticket=${ticket.id}`);
    expect(notifs[0]!.title).toContain(ticket.ticketNumber);
    expect(notifs[0]!.readAt).toBeNull();

    // ...and it shows in the ticket's own timeline too.
    const acts = await adminTicketPrisma.activities.findMany({ where: { ticketId: ticket.id, type: 'mentioned' } });
    expect(acts).toHaveLength(1);
  });

  it('IGNORES mentions in the default (org) store — the security boundary', async () => {
    // The comment route serves BOTH stores and has no admin guard, so restricting
    // the picker to the admin pane proves nothing. This is what actually holds.
    const org = await createTestOrg('Org Store Mention');
    await createTestUser(org.id, 'orgadmin@example.com', 'ORG_ADMIN');
    const victim = await createTestUser(org.id, 'orgvictim@example.com', 'USER');

    const cookies = await loginAs('orgadmin@example.com');
    const ticket = await createTicket(cookies);
    const pool = await roster(cookies);
    const someone = pool.find((a) => a.email === 'orgvictim@example.com');

    const res = await request(app).post(`/api/ticketing/tickets/${ticket.id}/comments`)
      .set('Cookie', cookies)
      .field('content', 'trying to mention across stores')
      .field('mentions', someone?.id ?? '00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(201);   // the comment posts fine

    // ...but nothing was notified, and no mention activity was written.
    expect(await prisma.notification.count({ where: { userId: victim.id } })).toBe(0);
    expect(await ticketPrisma.activities.count({ where: { ticketId: ticket.id, type: 'mentioned' } })).toBe(0);
  });

  it('drops an id that is not on the roster', async () => {
    const org = await createTestOrg('Bogus Id Org');
    await createTestUser(org.id, 'bogus@example.com', 'ADMINISTRATOR', 'employee');
    const cookies = await loginAs('bogus@example.com');
    const ticket = await createTicket(cookies);

    await request(app).post(`/api/ticketing/tickets/${ticket.id}/comments`)
      .set('Cookie', cookies)
      .field('content', 'mentioning a stranger')
      .field('mentions', '11111111-2222-3333-4444-555555555555')
      .expect(201);

    expect(await prisma.notification.count()).toBe(0);
  });

  it('mentioning yourself notifies nobody', async () => {
    const org = await createTestOrg('Self Mention Org');
    const me = await createTestUser(org.id, 'self@example.com', 'ADMINISTRATOR', 'employee');
    const cookies = await loginAs('self@example.com');
    const ticket = await createTicket(cookies);
    const mine = (await roster(cookies)).find((a) => a.email === 'self@example.com');

    await request(app).post(`/api/ticketing/tickets/${ticket.id}/comments`)
      .set('Cookie', cookies)
      .field('content', 'note to self')
      .field('mentions', mine!.id)
      .expect(201);

    expect(await prisma.notification.count({ where: { userId: me.id } })).toBe(0);
  });

  it('the notification OUTLIVES the ticket it points at', async () => {
    // The reason the table is in the main database rather than the ticket store,
    // where Activities rows are ON DELETE CASCADE on the ticket.
    const org = await createTestOrg('Outlive Org');
    await createTestUser(org.id, 'deleter@example.com', 'ADMINISTRATOR', 'employee');
    const target = await createTestUser(org.id, 'survivor@example.com', 'ADMINISTRATOR', 'employee');

    const cookies = await loginAs('deleter@example.com');
    const ticket = await createTicket(cookies);
    const targetEntry = (await roster(cookies)).find((a) => a.email === 'survivor@example.com');

    await request(app).post(`/api/ticketing/tickets/${ticket.id}/comments`)
      .set('Cookie', cookies).field('content', 'look here').field('mentions', targetEntry!.id).expect(201);
    expect(await prisma.notification.count({ where: { userId: target.id } })).toBe(1);

    await request(app).delete(`/api/ticketing/tickets/${ticket.id}`).set('Cookie', cookies).expect(204);

    // Ticket gone, its activity history gone with it — notification still there.
    expect(await adminTicketPrisma.activities.count({ where: { ticketId: ticket.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: target.id } })).toBe(1);
  });

  it('a comment with no mentions still posts normally', async () => {
    const org = await createTestOrg('Plain Comment Org');
    await createTestUser(org.id, 'plain@example.com', 'ADMINISTRATOR', 'employee');
    const cookies = await loginAs('plain@example.com');
    const ticket = await createTicket(cookies);

    const res = await request(app).post(`/api/ticketing/tickets/${ticket.id}/comments`)
      .set('Cookie', cookies).field('content', 'just a comment');
    expect(res.status).toBe(201);
    expect(res.body.comments).toHaveLength(1);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('rejects an empty comment', async () => {
    const org = await createTestOrg('Empty Comment Org');
    await createTestUser(org.id, 'empty@example.com', 'ADMINISTRATOR', 'employee');
    const cookies = await loginAs('empty@example.com');
    const ticket = await createTicket(cookies);

    const res = await request(app).post(`/api/ticketing/tickets/${ticket.id}/comments`)
      .set('Cookie', cookies).field('content', '   ');
    expect(res.status).toBe(400);
  });
});
