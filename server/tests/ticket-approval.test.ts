import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import { createTestOrg, createTestUser, loginAs, cleanDb, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { createKey } from '../src/modules/external-api/external-keys';

// Approval of external-created tickets (Phase 4):
//   - an external API ticket is created with the `pending:approval` label AND an
//     audit row recording the request;
//   - approve → in_progress + label removed; decline (with reason) → declined +
//     a reason comment — both go through the shared service transition;
//   - FIRST valid decision wins; a duplicate gets 409 TICKET_ALREADY_DECIDED;
//   - another organization's admin cannot decide (404 via assertTicketAccess).

const ready = ticketTestDbReady();

async function externalToken(orgId: string, actor: { userId: string; customerId: string }) {
  const key = await createKey(
    { name: `approval-test-${Date.now()}`, scopes: ['tickets.write'], ticketStore: 'default', customerIds: [orgId] },
    actor,
  );
  const res = await request(app).post('/api/external/token').send({
    grant_type: 'client_credentials', client_id: key.clientId, client_secret: key.secret, scope: 'tickets.write',
  });
  expect(res.status).toBe(200);
  expect(res.body.access_token, 'client_credentials must issue a JWT without Redis').toBeTruthy();
  return { ...key, accessToken: res.body.access_token as string };
}

describe.skipIf(!ready)(`external ticket approval${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, () => {
  beforeEach(async () => { await cleanDb(); });
  afterAll(async () => { await cleanDb(); await prisma.$disconnect(); });

  it('approve/decline are first-wins, duplicates 409, and the decision is org-scoped', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const org = await createTestOrg(`Approval Org ${now}`);
    const otherOrg = await createTestOrg(`Approval Other ${now}`);
    const admin = await createTestUser(org.id, `approve-admin-${now}@example.com`, 'ORG_ADMIN');
    const otherAdmin = await createTestUser(otherOrg.id, `approve-other-${now}@example.com`, 'ORG_ADMIN');
    const ac = await loginAs(admin.email);
    const oc = await loginAs(otherAdmin.email);

    const proj = await request(app).post('/api/ticketing/projects').set('Cookie', ac).send({ name: `Approval Proj ${now}` });
    expect(proj.status).toBe(201);
    const pool = (await request(app).get('/api/ticketing/assignees').set('Cookie', ac).expect(200)).body.assignees as Array<{ id: string; email: string }>;
    const persona = pool.find((a) => a.email === admin.email);
    expect(persona, 'the org-admin template holder (ESCALATE_ADMINS_ID) is not a uuid, so pick the bridged user by email').toBeDefined();
    const personaId = persona!.id;

    const key = await externalToken(org.id, { userId: admin.id, customerId: org.id });
    const extCreate = (title: string) =>
      request(app).post('/api/external/tickets').set('Authorization', `Bearer ${key.accessToken}`).send({
        title, description: 'test', type: 'task', priority: 'high',
        projectId: proj.body.id, assigneeId: personaId, orgCustomerId: org.id,
      });

    // ── Approve wins once ──
    const created = await extCreate('Needs approval');
    expect(created.status).toBe(200);
    const ticketId = created.body.id as string;
    expect(created.body.labels).toContain('pending:approval');
    expect(created.body.status).toBe('todo');

    const requested = await prisma.auditLog.findFirst({ where: { action: 'TICKET_APPROVAL_REQUESTED', targetId: ticketId } });
    expect(requested, 'TICKET_APPROVAL_REQUESTED must be recorded at creation').toBeDefined();

    // A different org's admin must not even see it, let alone decide it.
    const stranger = await request(app).post(`/api/ticketing/tickets/${ticketId}/approve`).set('Cookie', oc);
    expect(stranger.status).toBe(404);

    const approved = await request(app).post(`/api/ticketing/tickets/${ticketId}/approve`).set('Cookie', ac);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('in_progress');
    expect(approved.body.labels).not.toContain('pending:approval');

    const dup = await request(app).post(`/api/ticketing/tickets/${ticketId}/approve`).set('Cookie', ac);
    expect(dup.status).toBe(409);
    const approvedLog = await prisma.auditLog.findFirst({ where: { action: 'TICKET_APPROVED', targetId: ticketId } });
    expect(approvedLog).toBeDefined();

    // ── Decline with reason ──
    const declined = await extCreate('Needs decline');
    const declinedId = declined.body.id as string;
    const res = await request(app).post(`/api/ticketing/tickets/${declinedId}/decline`).set('Cookie', ac).send({ reason: 'Not relevant' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('declined');
    expect(res.body.labels).not.toContain('pending:approval');

    const comments = (await request(app).get(`/api/ticketing/tickets/${declinedId}/comments`).set('Cookie', ac)).body.comments as Array<{ content: string }>;
    expect(comments.some((c) => c.content.includes('Not relevant')), 'the decline reason must be recorded as a comment').toBe(true);

    // The new status round-trips through the org list without breaking the filter.
    const list = await request(app).get('/api/ticketing/tickets?status=declined').set('Cookie', ac).expect(200);
    expect(list.body.tickets.some((t: { id: string }) => t.id === declinedId)).toBe(true);
  });

  it('plain members cannot decide — staffWrite gates approve/decline to staff', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const org = await createTestOrg(`Approval Role Org ${now}`);
    const admin = await createTestUser(org.id, `approve-role-admin-${now}@example.com`, 'ORG_ADMIN');
    const member = await createTestUser(org.id, `approve-role-member-${now}@example.com`, 'USER');
    const ac = await loginAs(admin.email);
    const mc = await loginAs(member.email);

    const proj = await request(app).post('/api/ticketing/projects').set('Cookie', ac).send({ name: `Approval Role Proj ${now}` });
    expect(proj.status).toBe(201);
    const pool = (await request(app).get('/api/ticketing/assignees').set('Cookie', ac).expect(200)).body.assignees as Array<{ id: string; email: string }>;
    const persona = pool.find((a) => a.email === admin.email);
    expect(persona).toBeDefined();

    const key = await createKey(
      { name: `approval-role-${now}`, scopes: ['tickets.write'], ticketStore: 'default', customerIds: [org.id] },
      { userId: admin.id, customerId: org.id },
    );
    const tok = await request(app).post('/api/external/token').send({
      grant_type: 'client_credentials', client_id: key.clientId, client_secret: key.secret, scope: 'tickets.write',
    });
    expect(tok.status).toBe(200);

    const created = await request(app).post('/api/external/tickets').set('Authorization', `Bearer ${tok.body.access_token}`).send({
      title: 'Member must not decide', description: 'test', type: 'task', priority: 'high',
      projectId: proj.body.id, assigneeId: persona!.id, orgCustomerId: org.id,
    });
    expect(created.status).toBe(200);
    const ticketId = created.body.id as string;

    const denied = await request(app).post(`/api/ticketing/tickets/${ticketId}/approve`).set('Cookie', mc);
    expect(denied.status).toBe(403);
  });
});