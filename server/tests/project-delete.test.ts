import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { ticketPrisma } from '../src/config/ticketDatabase';

// DELETE /ticketing/projects/:id — the typed-name confirmation and the compliance
// guard. Tickets are NEVER deletable, so a project that still holds any ticket
// cannot be deleted either; only EMPTY projects can go.
//
// Skipped LOUDLY without a *_test ticket store: the refusal and the cross-database
// audit write are the whole point, and a green tick with no database would claim
// guarantees nothing checked.
const ready = ticketTestDbReady();

async function createProject(cookies: string[], name: string): Promise<string> {
  const res = await request(app).post('/api/ticketing/projects').set('Cookie', cookies).send({ name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

async function createTicket(cookies: string[], projectId: string, title = 'Printer offline') {
  const res = await request(app).post('/api/ticketing/tickets').set('Cookie', cookies).send({
    title, description: 'It shows offline and nothing prints.', type: 'task', priority: 'medium', projectId,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; ticketNumber: string };
}

const del = (cookies: string[], id: string, confirm?: string) =>
  request(app).delete(`/api/ticketing/projects/${id}`)
    .set('Cookie', cookies)
    .query(confirm === undefined ? {} : { confirm });

describe.skipIf(!ready)('DELETE /ticketing/projects/:id', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it(`refuses without the exact name, and the project survives${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, async () => {
    const org = await createTestOrg('Confirm Project Org');
    await createTestUser(org.id, 'proj-admin@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('proj-admin@example.com');

    const name = 'Network Refresh';
    const projectId = await createProject(cookies, name);

    // No confirmation at all, the wrong name, and a near-miss all have to fail —
    // a guard that only catches the empty string is not a guard.
    for (const confirm of [undefined, '', 'Network Refres', 'network refresh']) {
      const res = await del(cookies, projectId, confirm);
      expect(res.status, `confirm=${String(confirm)} → ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.code).toBe('CONFIRM_MISMATCH');
    }

    expect(await ticketPrisma.projects.count({ where: { id: projectId } })).toBe(1);
  });

  it('refuses to delete a project that still holds tickets (compliance), and everything survives', async () => {
    const org = await createTestOrg('Cascade Project Org');
    await createTestUser(org.id, 'cascade-proj@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('cascade-proj@example.com');

    const name = 'Core Banking Rollout';
    const projectId = await createProject(cookies, name);
    const a = await createTicket(cookies, projectId, 'First');
    const b = await createTicket(cookies, projectId, 'Second');
    await request(app).post(`/api/ticketing/tickets/${a.id}/comments`)
      .set('Cookie', cookies).field('content', 'Looking into it');

    expect(await ticketPrisma.tickets.count({ where: { projectId } })).toBe(2);

    const res = await del(cookies, projectId, name);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('PROJECT_HAS_TICKETS');

    // Nothing was destroyed on the way to the refusal.
    expect(await ticketPrisma.projects.count({ where: { id: projectId } })).toBe(1);
    expect(await ticketPrisma.tickets.count({ where: { id: { in: [a.id, b.id] } } })).toBe(2);
    // Comments and activity survive along with the tickets.
    expect(await ticketPrisma.comments.count({ where: { ticketId: a.id } })).toBeGreaterThan(0);
    expect(await ticketPrisma.activities.count({ where: { ticketId: a.id } })).toBeGreaterThan(0);
  });

  it('deletes an EMPTY project when the name matches', async () => {
    const org = await createTestOrg('Empty Project Org');
    await createTestUser(org.id, 'empty-proj@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('empty-proj@example.com');

    const name = 'Scratch Project';
    const projectId = await createProject(cookies, name);

    await del(cookies, projectId, name).expect(204);
    expect(await ticketPrisma.projects.count({ where: { id: projectId } })).toBe(0);
  });

  it('surrounding whitespace in the typed name is forgiven, a wrong name is not', async () => {
    const org = await createTestOrg('Trim Project Org');
    await createTestUser(org.id, 'trim-proj@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('trim-proj@example.com');

    const projectId = await createProject(cookies, 'Zero Trust');
    await del(cookies, projectId, '  Zero Trust  ').expect(204);
    expect(await ticketPrisma.projects.count({ where: { id: projectId } })).toBe(0);
  });

  it('refuses an escalated project too — "holds tickets" covers every ticket', async () => {
    // Escalated or not, a ticket is a ticket: compliance means it cannot be deleted,
    // so a project holding one cannot be deleted either.
    const org = await createTestOrg('Escalated Project Org');
    await createTestUser(org.id, 'esc-proj@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('esc-proj@example.com');

    const name = 'Escalation Holder';
    const projectId = await createProject(cookies, name);
    const ticket = await createTicket(cookies, projectId);
    await ticketPrisma.tickets.update({ where: { id: ticket.id }, data: { labels: ['escalated'] } });

    const res = await del(cookies, projectId, name);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('PROJECT_HAS_TICKETS');

    // Nothing was destroyed on the way to the refusal.
    expect(await ticketPrisma.projects.count({ where: { id: projectId } })).toBe(1);
    expect(await ticketPrisma.tickets.count({ where: { id: ticket.id } })).toBe(1);
  });

  it('leaves a PROJECT_DELETED audit row that OUTLIVES the project', async () => {
    // Only empty projects can be deleted, so the audit row records a zero-ticket
    // deletion; it is the only surviving record the project ever existed.
    const org = await createTestOrg('Audit Project Org');
    const admin = await createTestUser(org.id, 'audit-proj@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('audit-proj@example.com');

    const name = 'Doomed Project';
    const projectId = await createProject(cookies, name);

    await del(cookies, projectId, name).expect(204);

    const row = await prisma.auditLog.findFirst({
      where: { action: 'PROJECT_DELETED', performedById: admin.id, targetId: projectId },
    });
    expect(row).not.toBeNull();
    const meta = row?.metadata as { project?: string; tickets?: number };
    expect(meta?.project).toBe(name);
    expect(meta?.tickets).toBe(0);
  });

  it('404s for a project that does not exist, before checking the confirmation', async () => {
    const org = await createTestOrg('Missing Project Org');
    await createTestUser(org.id, 'missing-proj@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('missing-proj@example.com');

    const res = await del(cookies, '00000000-0000-0000-0000-000000000000', 'anything');
    expect(res.status).toBe(404);
  });

  it('denies an INTERN but allows an EMPLOYEE — the tickets.write split', async () => {
    // plr_intern deliberately lacks tickets.write; plr_employee has it. staffWrite is
    // what encodes that, and deleting a project is very much a write.
    const org = await createTestOrg('Platform Project Org');
    await createTestUser(org.id, 'proj-intern@example.com', 'ADMINISTRATOR', 'intern');
    await createTestUser(org.id, 'proj-employee@example.com', 'ADMINISTRATOR', 'employee');

    const employeeCookies = await loginAs('proj-employee@example.com');
    const name = 'Staff Split Project';
    const projectId = await createProject(employeeCookies, name);

    const internCookies = await loginAs('proj-intern@example.com');
    const denied = await del(internCookies, projectId, name);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');

    await del(employeeCookies, projectId, name).expect(204);
  });
});
