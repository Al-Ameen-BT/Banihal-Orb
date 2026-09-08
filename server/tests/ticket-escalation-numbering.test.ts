import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import { createTestOrg, createTestUser, loginAs, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { adminTicketPrisma } from '../src/config/ticketDatabase';

// When an ORG_ADMIN escalates a ticket, the copy written to the ADMIN store
// (b2b_ticketing_admin) must carry the SAME org-coded number format as the source
// (TKT-<ORGCODE>-NNN), counting from the admin store's own per-org sequence.
// Previously the copy got a plain TKT-NNN; the platform admin then saw a number
// that shared nothing with the org ticket it came from.

const ready = ticketTestDbReady();
describe.skipIf(!ready)(`escalated copy numbering${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, () => {
  it('escalated copy in admin store carries the org-coded number', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const orgCode = `EX${now.slice(-4)}`;
    const org = await createTestOrg(`Esc Num Org ${now}`);
    await prisma.customer.update({ where: { id: org.id }, data: { orgCode } });

    const admin = await createTestUser(org.id, `esc-admin-${now}@example.com`, 'ORG_ADMIN');
    const ac = await loginAs(admin.email);
    await request(app).get('/api/ticketing/tickets?mine=true').set('Cookie', ac).expect(200);

    const proj = await request(app).post('/api/ticketing/projects').set('Cookie', ac).send({ name: `Esc Num Proj ${now}` });
    expect(proj.status).toBe(201);

    const res = await request(app).post('/api/ticketing/tickets').set('Cookie', ac).send({
      title: 'Escalate with code', description: 'test', projectId: proj.body.id, escalateToAdministrators: true,
    });
    expect(res.status).toBe(201);
    const srcId = res.body.id as string;
    const srcNum = res.body.ticketNumber as string;
    expect(srcNum).toMatch(new RegExp(`^TKT-${orgCode}-`));

    // The 'escalated' label is added after the response is sent, so re-fetch.
    const refreshed = await request(app).get(`/api/ticketing/tickets/${srcId}`).set('Cookie', ac).expect(200);
    expect(refreshed.body.labels).toContain('escalated');

    // The copy lives in the admin store and carries 'src:<sourceNumber>'.
    const copy = await adminTicketPrisma.tickets.findFirst({
      where: { labels: { has: `src:${srcNum}` } },
      select: { ticketNumber: true, labels: true },
    });
    expect(copy, 'admin store must contain the escalated copy').toBeDefined();
    expect(copy!.ticketNumber).toMatch(new RegExp(`^TKT-${orgCode}-`));
    expect(copy!.labels).toContain('escalated');
    expect(copy!.labels).toContain('org:Esc Num Org ' + now);
  });
});
