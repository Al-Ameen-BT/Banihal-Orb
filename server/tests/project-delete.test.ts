import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { ticketPrisma } from '../src/config/ticketDatabase';

// DELETE /ticketing/projects/:id — the typed-name confirmation and the compliance
// relocation. Tickets are NEVER deletable, so deleting a project that still holds
// any RELOCATES them into a hidden "Retained tickets" bucket instead of refusing:
// the project row disappears, the tickets (and every overall count) survive. Only
// an empty project is destroyed outright.
//
// Skipped LOUDLY without a *_test ticket store: the relocation and the cross-database
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

  it('deletes a project holding tickets by MOVING them to a hidden retained bucket — nothing is destroyed', async () => {
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
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    // The project row itself is gone…
    expect(await ticketPrisma.projects.count({ where: { id: projectId } })).toBe(0);
    // …but its tickets are NOT: they were relocated wholesale.
    expect(await ticketPrisma.tickets.count({ where: { id: { in: [a.id, b.id] } } })).toBe(2);

    const bucket = await ticketPrisma.projects.findFirst({
      where: { name: 'Retained tickets' }, select: { id: true, deletedAt: true },
    });
    expect(bucket, 'a hidden retained bucket must exist').not.toBeNull();
    expect(bucket!.deletedAt, 'the bucket is invisible: deletedAt marks it hidden').not.toBeNull();
    expect(await ticketPrisma.tickets.count({ where: { projectId: bucket!.id, id: { in: [a.id, b.id] } } })).toBe(2);

    // Comments and activity belong to the tickets, so they survive the move.
    expect(await ticketPrisma.comments.count({ where: { ticketId: a.id } })).toBeGreaterThan(0);
    expect(await ticketPrisma.activities.count({ where: { ticketId: a.id } })).toBeGreaterThan(0);

    // The frontend project list hides the bucket AND the deleted project (asserted
    // by id — earlier sessions leave same-named rows behind in the shared store).
    const list = await request(app).get('/api/ticketing/projects').set('Cookie', cookies);
    expect(list.status).toBe(200);
    const ids = (list.body as { projects: Array<{ id: string; name: string }> }).projects.map((p) => p.id);
    expect(ids).not.toContain(projectId);
    expect((list.body as { projects: Array<{ id: string; name: string }> }).projects.map((p) => p.name)).not.toContain('Retained tickets');
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

  it('relocates an escalated project too — "holds tickets" covers every ticket', async () => {
    // Escalated or not, a ticket is a ticket: compliance means it cannot be deleted,
    // so when its project goes, the escalated ticket is retained too.
    const org = await createTestOrg('Escalated Project Org');
    await createTestUser(org.id, 'esc-proj@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('esc-proj@example.com');

    const name = 'Escalation Holder';
    const projectId = await createProject(cookies, name);
    const ticket = await createTicket(cookies, projectId);
    await ticketPrisma.tickets.update({ where: { id: ticket.id }, data: { labels: ['escalated'] } });

    const res = await del(cookies, projectId, name);
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    const bucket = await ticketPrisma.projects.findFirst({
      where: { name: 'Retained tickets' }, select: { id: true },
    });
    expect(bucket).not.toBeNull();
    expect(await ticketPrisma.tickets.count({ where: { id: ticket.id } })).toBe(1);
    expect(await ticketPrisma.tickets.count({ where: { id: ticket.id, projectId: bucket!.id } })).toBe(1);
  });

  it('leaves a PROJECT_DELETED audit row that OUTLIVES the project', async () => {
    // Empty deletion: the audit row records a zero-ticket deletion; it is the only
    // surviving record the project ever existed.
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
    const meta = row?.metadata as { project?: string; tickets?: number; retained?: boolean };
    expect(meta?.project).toBe(name);
    expect(meta?.tickets).toBe(0);
    expect(meta?.retained).toBe(false);
  });

  it('records the retained tickets in the PROJECT_DELETED audit row when tickets were moved', async () => {
    const org = await createTestOrg('Audit Retained Org');
    const admin = await createTestUser(org.id, 'audit-retained@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('audit-retained@example.com');

    const name = 'Doomed With Tickets';
    const projectId = await createProject(cookies, name);
    await createTicket(cookies, projectId, 'One');
    await createTicket(cookies, projectId, 'Two');
    await createTicket(cookies, projectId, 'Three');

    await del(cookies, projectId, name).expect(204);

    const row = await prisma.auditLog.findFirst({
      where: { action: 'PROJECT_DELETED', performedById: admin.id, targetId: projectId },
    });
    expect(row).not.toBeNull();
    const meta = row?.metadata as { project?: string; tickets?: number; retained?: boolean };
    expect(meta?.project).toBe(name);
    expect(meta?.tickets).toBe(3);
    expect(meta?.retained).toBe(true);
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

  it('the ADMINISTRATION role may delete an empty project — the tickets.manage path', async () => {
    // Administration computes to every key, so tickets.manage is held and the delete
    // gate (tickets.write OR tickets.manage) passes even though the key is what the
    // delete is now explicitly attached to.
    const org = await createTestOrg('Admin Project Org');
    await createTestUser(org.id, 'proj-admin@example.com', 'ADMINISTRATOR', 'administration');

    const adminCookies = await loginAs('proj-admin@example.com');
    const name = 'Administration Project';
    const projectId = await createProject(adminCookies, name);

    await del(adminCookies, projectId, name).expect(204);
  });
});
