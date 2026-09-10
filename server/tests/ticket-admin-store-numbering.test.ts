import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import { createTestOrg, createTestUser, loginAs, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { adminTicketPrisma } from '../src/config/ticketDatabase';

// The ADMIN store has exactly ONE ticket-number clock. Platform-created tickets and
// escalated copies both advance it, so an administrator always reads "the last
// platform number was N, this one is N+1".
//
// The creating administrator's OWN organization must never segment that clock. It is
// the inverse of ticket-org-numbering.test.ts (per-org -001 counters in the SHARED
// client store): here the org code must be absent entirely, however many different
// orgs the platform staff belong to.
//
// The regression this pins: createTicket used to resolve the org code from
// req.user.customerId regardless of store scope. Since User.customerId is NOT NULL
// and deriveOrgCode never returns empty, that ALWAYS produced a code — so every
// administrator minted a private TKT-<theirOrg>-001 series forking away from the
// store's master sequence (the live symptom was TKT-BT-001 landing on top of
// TKT-1610).
const ready = ticketTestDbReady();
describe.skipIf(!ready)(`admin-store ticket numbering${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, () => {
  it('ignores each administrator’s own org and continues the store-wide sequence', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const codeA = `AA${now.slice(-4)}`;
    const codeB = `AB${now.slice(-4)}`;

    // Two platform administrators from DIFFERENT B2B orgs, each with an explicit
    // orgCode — so if a code ever leaks into the number we know exactly whose.
    const orgA = await createTestOrg(`Admin Num Org A ${now}`);
    const orgB = await createTestOrg(`Admin Num Org B ${now}`);
    await prisma.customer.update({ where: { id: orgA.id }, data: { orgCode: codeA } });
    await prisma.customer.update({ where: { id: orgB.id }, data: { orgCode: codeB } });

    const ua = await createTestUser(orgA.id, `admin-num-a-${now}@example.com`, 'ADMINISTRATOR');
    const ub = await createTestUser(orgB.id, `admin-num-b-${now}@example.com`, 'ADMINISTRATOR');
    const ca = await loginAs(ua.email);
    const cb = await loginAs(ub.email);

    // Bridge both into the admin store before writing (same warm-up the other
    // ticketing e2e tests use).
    await request(app).get('/api/ticketing/tickets').set('Cookie', ca).expect(200);
    await request(app).get('/api/ticketing/tickets').set('Cookie', cb).expect(200);

    const proj = await request(app).post('/api/ticketing/projects').set('Cookie', ca)
      .send({ name: `Admin Num Proj ${now}` });
    expect(proj.status, JSON.stringify(proj.body)).toBe(201);

    // The store-wide clock as it stands BEFORE this test writes anything.
    const before = await storeWideMaxDigit();

    // `customerId: null` mirrors the real admin New Ticket form: "no client",
    // which also suppresses the auto-link of the administrator's own org.
    const mk = async (cookies: string[], title: string) => {
      const res = await request(app).post('/api/ticketing/tickets').set('Cookie', cookies)
        .send({ title, description: 'admin numbering check', projectId: proj.body.id, customerId: null });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.ticketNumber as string;
    };

    const n1 = await mk(ca, 'Admin Num 1');
    const n2 = await mk(cb, 'Admin Num 2');

    // No org segment — not org A's code, not org B's, none at all.
    expect(n1).toMatch(/^TKT-\d+$/);
    expect(n2).toMatch(/^TKT-\d+$/);
    expect(n1).not.toContain(codeA);
    expect(n2).not.toContain(codeB);

    const seq1 = seqOf(n1);
    const seq2 = seqOf(n2);

    // Both administrators advance the SAME clock: consecutive, and past the
    // pre-existing store maximum. This is the assertion that fails on the old
    // behaviour, where a fresh TKT-<code>-001 sits BELOW the store max.
    expect(seq1).toBeGreaterThan(before);
    expect(seq2).toBe(seq1 + 1);
  });
});

/** Trailing sequence digits of a ticket number. */
function seqOf(num: string): number {
  const m = /(\d+)\s*$/.exec(num);
  expect(m, `no trailing digits in ${num}`).not.toBeNull();
  return parseInt(m![1]!, 10);
}

/** Max trailing sequence digit among ALL admin-store ticket numbers (store-wide clock). */
async function storeWideMaxDigit(): Promise<number> {
  const nums = await adminTicketPrisma.tickets.findMany({ select: { ticketNumber: true } });
  let max = 0;
  for (const t of nums) {
    const m = /(\d+)\s*$/.exec(t.ticketNumber);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return max;
}
