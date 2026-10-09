import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { ticketPrisma } from '../src/config/ticketDatabase';

// GET /ticketing/reports — the Reports tab's per-ticket feed.
//
// The load-bearing case is the FIRST one. This endpoint used to read the whole ticket
// table with no organization filter, and b2b_ticket is shared by every client org —
// so an ORG_ADMIN's report counted, and a Client-wise report would have NAMED, every
// other customer. If someone drops ticketAccessScope from the handler again, the
// tenant test below is what fails.
const ready = ticketTestDbReady();

interface ReportBody {
  type: string;
  groups: Array<{ key: string; label: string; tickets: Array<{ id: string; ticketNumber: string; status: string; customerName: string | null; assigneeName: string | null }> }>;
  totals: { tickets: number; open: number; completed: number; breached: number };
  truncated: boolean;
}

async function raiseTicket(cookies: string[], title: string) {
  const proj = await request(app).post('/api/ticketing/projects').set('Cookie', cookies)
    .send({ name: `Report Project ${Math.random().toString(36).slice(2, 8)}` });
  expect(proj.status, JSON.stringify(proj.body)).toBe(201);
  const res = await request(app).post('/api/ticketing/tickets').set('Cookie', cookies).send({
    title, description: 'Raised by the report test.', type: 'task', priority: 'medium',
    projectId: (proj.body as { id: string }).id,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; ticketNumber: string };
}

const report = (cookies: string[], query: Record<string, string | number> = {}) =>
  request(app).get('/api/ticketing/reports').set('Cookie', cookies).query(query);

const allTickets = (b: ReportBody) => b.groups.flatMap((g) => g.tickets);

describe.skipIf(!ready)('GET /ticketing/reports', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it(`never includes another organization's tickets${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, async () => {
    const orgA = await createTestOrg('Report Org A');
    await createTestUser(orgA.id, 'report-a@example.com', 'ORG_ADMIN');
    const orgB = await createTestOrg('Report Org B');
    await createTestUser(orgB.id, 'report-b@example.com', 'ORG_ADMIN');

    const aCookies = await loginAs('report-a@example.com');
    const bCookies = await loginAs('report-b@example.com');

    // Both land in the SAME database — that is the whole risk.
    const aTicket = await raiseTicket(aCookies, 'Org A only');
    const bTicket = await raiseTicket(bCookies, 'Org B only');

    const res = await report(aCookies, { type: 'overall' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const numbers = allTickets(res.body as ReportBody).map((t) => t.ticketNumber);

    expect(numbers).toContain(aTicket.ticketNumber);
    expect(numbers).not.toContain(bTicket.ticketNumber);
    // The totals are derived from the same rows, so they must agree.
    expect((res.body as ReportBody).totals.tickets).toBe(numbers.length);
  });

  it('groups client-wise by the ticket’s customer', async () => {
    const org = await createTestOrg('Grouping Org');
    await createTestUser(org.id, 'report-group@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('report-group@example.com');
    await raiseTicket(cookies, 'Grouped ticket');

    const res = await report(cookies, { type: 'client' });
    expect(res.status).toBe(200);
    const body = res.body as ReportBody;
    expect(body.groups.length).toBeGreaterThan(0);
    // An org admin's tickets link their own organization as the client, so the group
    // label is the org name rather than the "No client" fallback.
    expect(body.groups.map((g) => g.label)).toContain('Grouping Org');
  });

  it('overall puts everything in a single group', async () => {
    const org = await createTestOrg('Overall Org');
    await createTestUser(org.id, 'report-overall@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('report-overall@example.com');
    const one = await raiseTicket(cookies, 'One');
    const two = await raiseTicket(cookies, 'Two');

    const body = (await report(cookies, { type: 'overall' }).expect(200)).body as ReportBody;
    expect(body.groups.length).toBe(1);
    // Assert the tickets THIS run created, not an absolute count: cleanDb resets the
    // main database but not the ticket stores, and the bridge is keyed by email — so a
    // second run of this file reuses the same ticket-store user and its earlier tickets
    // are still there, correctly, in scope.
    const ids = body.groups[0]!.tickets.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([one.id, two.id]));
  });

  it('sla_breach returns only open tickets past their resolution budget', async () => {
    const org = await createTestOrg('Breach Org');
    await createTestUser(org.id, 'report-breach@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('report-breach@example.com');

    const breaching = await raiseTicket(cookies, 'Long overdue');
    const healthy = await raiseTicket(cookies, 'Fresh');
    const paused = await raiseTicket(cookies, 'Waiting on the client');
    const done = await raiseTicket(cookies, 'Already fixed');

    // A 1-hour resolution SLA, attached to three of them; then age those past it.
    //
    // The four states pin the exact rule isBreached encodes:
    //   • open + over budget            → breached
    //   • no SLA policy / still young   → not breached
    //   • client_pending + over budget  → STILL breached. Pausing stops the clock but
    //     does not undo a budget already blown, or "waiting on the client" would be a
    //     way to make any breach vanish. (This diverges from the per-ticket SLA badge,
    //     which shows 'Paused' — see the note on isBreached.)
    //   • completed                     → never breached, it is not open
    const sla = await ticketPrisma.sLAs.create({
      data: { name: `Vitest 1h ${Math.random().toString(36).slice(2, 8)}`, responseTime: 1, resolutionTime: 1, timeUnit: 'hours' },
      select: { id: true },
    });
    const old = new Date(Date.now() - 5 * 3_600_000);
    await ticketPrisma.tickets.updateMany({
      where: { id: { in: [breaching.id, paused.id, done.id] } },
      data: { SLAId: sla.id, createdAt: old },
    });
    await ticketPrisma.tickets.update({ where: { id: paused.id }, data: { status: 'client_pending' } });
    await ticketPrisma.tickets.update({ where: { id: done.id }, data: { status: 'completed' } });

    const body = (await report(cookies, { type: 'sla_breach' }).expect(200)).body as ReportBody;
    const ids = allTickets(body).map((t) => t.id);

    expect(ids).toContain(breaching.id);
    expect(ids).toContain(paused.id);        // over budget before it was paused
    expect(ids).not.toContain(healthy.id);   // young, and no SLA attached
    expect(ids).not.toContain(done.id);      // completed is not open
    expect(body.totals.breached).toBe(ids.length);
  });

  it('filters by date range', async () => {
    const org = await createTestOrg('Range Org');
    await createTestUser(org.id, 'report-range@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('report-range@example.com');

    const recent = await raiseTicket(cookies, 'This week');
    const ancient = await raiseTicket(cookies, 'Last year');
    await ticketPrisma.tickets.update({
      where: { id: ancient.id },
      data: { createdAt: new Date(Date.now() - 400 * 86_400_000) },
    });

    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const body = (await report(cookies, { type: 'overall', from: since }).expect(200)).body as ReportBody;
    const ids = allTickets(body).map((t) => t.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(ancient.id);
  });

  it('accepts cleared filters — an empty string is "no filter", not a 400', async () => {
    // The report bar sends `?customerId=` when "All clients" is selected. Without the
    // blank() preprocessing the uuid check rejects it and the whole page 400s over a
    // filter the user deliberately cleared.
    const org = await createTestOrg('Blank Filter Org');
    await createTestUser(org.id, 'report-blank@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('report-blank@example.com');

    const res = await report(cookies, { type: 'client', customerId: '', assigneeId: '', from: '', to: '' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('rejects a malformed filter, rather than silently ignoring it', async () => {
    const org = await createTestOrg('Bad Filter Org');
    await createTestUser(org.id, 'report-bad@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('report-bad@example.com');

    // Silently dropping this would report on EVERY client while the user believes
    // they filtered to one — wrong data that looks right.
    expect((await report(cookies, { type: 'client', customerId: 'not-a-uuid' })).status).toBe(400);
    expect((await report(cookies, { type: 'nonsense' })).status).toBe(400);
  });

  it('denies a plain USER — reports are a staff surface', async () => {
    const org = await createTestOrg('Report Role Org');
    await createTestUser(org.id, 'report-user@example.com', 'USER');
    const cookies = await loginAs('report-user@example.com');

    expect((await report(cookies)).status).toBe(403);
  });
});
