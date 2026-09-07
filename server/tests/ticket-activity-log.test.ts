import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';

// GET /ticketing/activity — the Activity Log tab's feed.
//
// The one thing that MUST hold: the client store (b2b_ticket) is shared across every
// organization, so an unscoped feed would hand one org's admin every other org's
// ticket history. The handler passes ticketAccessScope() into the query for exactly
// that reason, and this is the test that would fail if someone dropped it.
const ready = ticketTestDbReady();

interface FeedRow {
  id: string;
  type: string;
  ticket: { id: string; ticketNumber: string; title: string } | null;
}

async function raiseTicket(cookies: string[], projectName: string, title: string) {
  const proj = await request(app).post('/api/ticketing/projects').set('Cookie', cookies)
    .send({ name: `${projectName} ${Math.random().toString(36).slice(2, 8)}` });
  expect(proj.status, JSON.stringify(proj.body)).toBe(201);
  const res = await request(app).post('/api/ticketing/tickets').set('Cookie', cookies).send({
    title, description: 'Raised by the activity-log test.', type: 'task', priority: 'medium',
    projectId: (proj.body as { id: string }).id,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; ticketNumber: string };
}

const feed = (cookies: string[], query: Record<string, string | number> = {}) =>
  request(app).get('/api/ticketing/activity').set('Cookie', cookies).query(query);

describe.skipIf(!ready)('GET /ticketing/activity', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it(`shows only the caller's own organization's activity${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, async () => {
    const orgA = await createTestOrg('Activity Org A');
    await createTestUser(orgA.id, 'activity-a@example.com', 'ORG_ADMIN');
    const orgB = await createTestOrg('Activity Org B');
    await createTestUser(orgB.id, 'activity-b@example.com', 'ORG_ADMIN');

    const aCookies = await loginAs('activity-a@example.com');
    const bCookies = await loginAs('activity-b@example.com');

    // Both land in the SAME database (b2b_ticket) — that is the whole risk.
    const aTicket = await raiseTicket(aCookies, 'Org A Project', 'Org A only');
    const bTicket = await raiseTicket(bCookies, 'Org B Project', 'Org B only');

    const res = await feed(aCookies, { limit: 200 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const numbers = (res.body.activity as FeedRow[]).map((r) => r.ticket?.ticketNumber);

    expect(numbers).toContain(aTicket.ticketNumber);
    expect(numbers).not.toContain(bTicket.ticketNumber);
  });

  it('records ticket creation, and joins each row to its ticket', async () => {
    const org = await createTestOrg('Activity Shape Org');
    await createTestUser(org.id, 'activity-shape@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('activity-shape@example.com');

    const ticket = await raiseTicket(cookies, 'Shape Project', 'Shape check');
    const res = await feed(cookies, { limit: 200 });
    expect(res.status).toBe(200);

    const row = (res.body.activity as FeedRow[]).find((r) => r.ticket?.id === ticket.id);
    expect(row, 'creating a ticket must write an activity row').toBeDefined();
    expect(row?.type).toBe('created');
    expect(row?.ticket?.ticketNumber).toBe(ticket.ticketNumber);
  });

  it('filters by type, and a cleared filter (?type=) is not an error', async () => {
    const org = await createTestOrg('Activity Filter Org');
    await createTestUser(org.id, 'activity-filter@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('activity-filter@example.com');
    const ticket = await raiseTicket(cookies, 'Filter Project', 'Filter check');

    // An empty string is what a "All activity" dropdown actually sends. Without the
    // blank() preprocessing the enum would reject it and 400 the whole page.
    const cleared = await feed(cookies, { type: '', limit: 200 });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);

    const created = await feed(cookies, { type: 'created', limit: 200 });
    expect(created.status).toBe(200);
    const rows = created.body.activity as FeedRow[];
    expect(rows.every((r) => r.type === 'created')).toBe(true);
    expect(rows.map((r) => r.ticket?.id)).toContain(ticket.id);

    // A type nothing has written yet is a legitimately empty answer, not a failure.
    const none = await feed(cookies, { type: 'attachment_added', limit: 200 });
    expect(none.status).toBe(200);
    expect((none.body.activity as FeedRow[]).map((r) => r.ticket?.id)).not.toContain(ticket.id);
  });

  it('pages with a cursor without repeating or dropping a row', async () => {
    const org = await createTestOrg('Activity Paging Org');
    await createTestUser(org.id, 'activity-paging@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('activity-paging@example.com');

    for (const n of [1, 2, 3]) await raiseTicket(cookies, 'Paging Project', `Paged ${n}`);

    const first = await feed(cookies, { limit: 2 });
    expect(first.status).toBe(200);
    expect((first.body.activity as FeedRow[]).length).toBe(2);
    expect(first.body.nextCursor, 'three rows at limit 2 must offer a next page').toBeTruthy();

    const second = await feed(cookies, { limit: 2, cursor: first.body.nextCursor as string });
    expect(second.status).toBe(200);

    const ids = [...first.body.activity, ...second.body.activity].map((r: FeedRow) => r.id);
    expect(new Set(ids).size, 'a cursor page must not repeat a row').toBe(ids.length);
  });

  it('denies a plain USER — the feed is a staff surface', async () => {
    const org = await createTestOrg('Activity Role Org');
    await createTestUser(org.id, 'activity-user@example.com', 'USER');
    const cookies = await loginAs('activity-user@example.com');

    const res = await feed(cookies);
    expect(res.status).toBe(403);
  });
});
