import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import { createTestOrg, createTestUser, loginAs, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { adminTicketPrisma } from '../src/config/ticketDatabase';

// Auto-assignment of organization-member tickets:
//   - a USER-created ticket is stored UNASSIGNED with a pending:org-admin label and
//     notifies the organization's admins ("ticket notification");
//   - the first ORG_ADMIN to OPEN the ticket (list click or notification deep link)
//     claims it — the lazy "auto-assign to the org admin" contract;
//   - an escalated ticket is ASSIGNED to the first active platform ADMINISTRATOR
//     ("Banihal Support") instead of being left for a manual claim.

const ready = ticketTestDbReady();
describe.skipIf(!ready)(`org-admin auto-assignment${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, () => {
  it('member-created ticket is unassigned, notified to the org admin, and claimed on first open', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const org = await createTestOrg(`Auto Assign Org ${now}`);

    const admin = await createTestUser(org.id, `autoadmin-${now}@example.com`, 'ORG_ADMIN');
    const ac = await loginAs(admin.email);

    const proj = await request(app).post('/api/ticketing/projects').set('Cookie', ac)
      .send({ name: `Auto Assign Proj ${now}` });
    expect(proj.status).toBe(201);

    const member = await createTestUser(org.id, `member-${now}@example.com`, 'USER');
    const mc = await loginAs(member.email);

    const res = await request(app).post('/api/ticketing/tickets').set('Cookie', mc).send({
      title: 'Awaiting org admin', description: 'test', projectId: proj.body.id,
    });
    expect(res.status).toBe(201);
    const ticketId = res.body.id as string;
    expect(res.body.assignee, 'a plain member ticket starts UNASSIGNED').toBeNull();
    expect(res.body.labels).toContain('pending:org-admin');

    // The "ticket notification": the org admin got an in-app row deep-linked to it.
    const notice = await prisma.notification.findFirst({
      where: { userId: admin.id, entityId: ticketId, kind: 'ticket_pending_org_admin' },
    });
    expect(notice, 'the org admin must be notified of the pending ticket').toBeDefined();
    expect(notice!.url).toContain(ticketId);

    // Opening it as a plain member does NOT claim it.
    const memberOpen = await request(app).get(`/api/ticketing/tickets/${ticketId}`).set('Cookie', mc).expect(200);
    expect(memberOpen.body.assignee, 'a plain member must not claim the ticket').toBeNull();

    // The org admin's bridged ticket-store id (their own row in the org assignee pool).
    const pool = (await request(app).get('/api/ticketing/assignees').set('Cookie', ac).expect(200)).body.assignees as Array<{ id: string; email: string }>;
    const adminTicketUser = pool.find((a) => a.email === admin.email);
    expect(adminTicketUser, 'the org admin must be in the org assignee pool').toBeDefined();

    // Claim-on-open: the first ORG_ADMIN who opens it takes it.
    const opened = await request(app).get(`/api/ticketing/tickets/${ticketId}`).set('Cookie', ac).expect(200);
    expect(opened.body.assignee).not.toBeNull();
    expect(opened.body.assignee.id).toBe(adminTicketUser!.id);
    expect(opened.body.labels).not.toContain('pending:org-admin');

    // Re-opening does not disturb the assignment.
    const reopened = await request(app).get(`/api/ticketing/tickets/${ticketId}`).set('Cookie', ac).expect(200);
    expect(reopened.body.assignee.id).toBe(adminTicketUser!.id);
  });

  it('escalated copy is assigned to the first active platform administrator', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const org = await createTestOrg(`Esc Support Org ${now}`);

    // Name-sorts before every fixture 'Test User' administrator, so it deterministically
    // wins the "first active ADMINISTRATOR" pick the escalation assigns to.
    const support = await createTestUser(org.id, `support-${now}@banihal.tech.test`, 'ADMINISTRATOR', 'administration');
    await prisma.user.update({ where: { id: support.id }, data: { name: `AA1 ${now}` } });

    const admin = await createTestUser(org.id, `escorgadmin-${now}@example.com`, 'ORG_ADMIN');
    const ac = await loginAs(admin.email);
    await request(app).get('/api/ticketing/tickets?mine=true').set('Cookie', ac).expect(200);

    const proj = await request(app).post('/api/ticketing/projects').set('Cookie', ac)
      .send({ name: `Esc Support Proj ${now}` });
    expect(proj.status).toBe(201);

    const res = await request(app).post('/api/ticketing/tickets').set('Cookie', ac).send({
      title: 'Escalate to support', description: 'test', projectId: proj.body.id, escalateToAdministrators: true,
    });
    expect(res.status).toBe(201);
    const srcNum = res.body.ticketNumber as string;

    const copy = await adminTicketPrisma.tickets.findFirst({
      where: { labels: { has: `src:${srcNum}` } },
      include: { Users_Tickets_assigneeIdToUsers: { select: { email: true, role: true, isActive: true } } },
    });
    expect(copy, 'the admin store must contain the escalated copy').toBeDefined();
    expect(copy!.Users_Tickets_assigneeIdToUsers, 'the escalated copy must be ASSIGNED').not.toBeNull();
    expect(copy!.Users_Tickets_assigneeIdToUsers!.email).toBe(support.email);
    expect(copy!.Users_Tickets_assigneeIdToUsers!.role).toBe('admin');
  });
});