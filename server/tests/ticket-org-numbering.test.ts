import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import { createTestOrg, createTestUser, loginAs, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';

// Per-org ticket numbering: when the platform format includes the org code, each
// organization counts from 1 under its own code (TKT-<A>-001, TKT-<A>-002) instead
// of sharing one global TKT-NNN sequence. The org segment is resolved from the
// creating user's directory customer (req.user.customerId → customers.orgCode), so
// two different orgs' first tickets both read `-001` without colliding.
const ready = ticketTestDbReady();
describe.skipIf(!ready)(`per-org ticket numbering e2e${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, () => {
  it('each organization counts from its own sequence with its org code', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const codeA = `VA${now.slice(-4)}`;
    const codeB = `VB${now.slice(-4)}`;

    const orgA = await createTestOrg(`Num Org A ${now}`);
    const orgB = await createTestOrg(`Num Org B ${now}`);
    await prisma.customer.update({ where: { id: orgA.id }, data: { orgCode: codeA } });
    await prisma.customer.update({ where: { id: orgB.id }, data: { orgCode: codeB } });

    const ua = await createTestUser(orgA.id, `num-a-${now}@example.com`, 'ORG_ADMIN');
    const ub = await createTestUser(orgB.id, `num-b-${now}@example.com`, 'ORG_ADMIN');
    const ca = await loginAs(ua.email);
    const cb = await loginAs(ub.email);
    await request(app).get('/api/ticketing/tickets?mine=true').set('Cookie', ca).expect(200);
    await request(app).get('/api/ticketing/tickets?mine=true').set('Cookie', cb).expect(200);

    const projA = await request(app).post('/api/ticketing/projects').set('Cookie', ca).send({ name: `Num Proj A ${now}` });
    const projB = await request(app).post('/api/ticketing/projects').set('Cookie', cb).send({ name: `Num Proj B ${now}` });
    expect(projA.status).toBe(201);
    expect(projB.status).toBe(201);

    const mk = async (cookies: string[], projectId: string, title: string) => {
      const res = await request(app).post('/api/ticketing/tickets').set('Cookie', cookies)
        .send({ title, description: 'numbering check', projectId });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.ticketNumber as string;
    };

    const a1 = await mk(ca, projA.body.id, 'Num A-1');
    const a2 = await mk(ca, projA.body.id, 'Num A-2');
    const b1 = await mk(cb, projB.body.id, 'Num B-1');

    expect(a1).toBe(`TKT-${codeA}-001`);
    expect(a2).toBe(`TKT-${codeA}-002`);
    expect(b1).toBe(`TKT-${codeB}-001`);
  });
});