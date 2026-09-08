import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { adminTicketPrisma } from '../src/config/ticketDatabase';

// GET /ticketing/customers — the client pool behind the New Ticket form's picker
// and the Reports tab's "Select Client" filter (ADMINISTRATOR only).
//
// Load-bearing cases:
//   • the admin ticketing DB can hold the SAME client twice — one mailbox entered
//     under two names — and the old dropdown showed both as separate options;
//   • the Application (b2b_saas) Customer is the source of truth, so the ticket-store
//     rows must be verified against it (name/contact reconciled, details converge).
const ready = ticketTestDbReady();

interface CustomerOption {
  id: string;
  ids: string[];
  name: string;
  email: string | null;
  contactPerson: string | null;
  company: string | null;
  b2bCustomerId: string | null;
  verified: boolean;
}

const list = (cookies: string[]) =>
  request(app).get('/api/ticketing/customers').set('Cookie', cookies);

describe.skipIf(!ready)('GET /ticketing/customers', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it(`collapses clients that share an email but differ in name${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, async () => {
    const org = await createTestOrg('Dedupe Org');
    await createTestUser(org.id, 'dedupe-admin@example.com', 'ADMINISTRATOR');
    const cookies = await loginAs('dedupe-admin@example.com');

    // Two admin-store rows, one mailbox — the exact duplicate the dropdown must not show.
    const first = await adminTicketPrisma.customers.create({
      data: { name: 'Dedupe Org', email: org.mailId },
      select: { id: true },
    });
    const second = await adminTicketPrisma.customers.create({
      data: { name: 'Dedupe Org (Legacy)', email: org.mailId, contactPerson: 'Old Contact' },
      select: { id: true },
    });

    const res = await list(cookies);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const options = res.body.customers as CustomerOption[];
    const match = options.filter((c) => c.email?.toLowerCase() === org.mailId.toLowerCase());

    expect(match.length, 'one email must produce one option').toBe(1);
    expect(match[0]!.ids).toEqual(expect.arrayContaining([first.id, second.id]));
    // Verification against the Application: the option carries the Application's
    // name and id, and the previously-stale row's contact is reconciled to it.
    expect(match[0]!.name).toBe('Dedupe Org');
    expect(match[0]!.b2bCustomerId).toBe(org.id);
    expect(match[0]!.verified).toBe(true);

    const reconciled = await adminTicketPrisma.customers.findUnique({ where: { id: second.id }, select: { name: true, contactPerson: true } });
    expect(reconciled?.name).toBe('Dedupe Org');
    expect(reconciled?.contactPerson).toBe('Test Contact');
  });

  it('leaves ticket-store-only clients untouched and unverified', async () => {
    const org = await createTestOrg('Unverified Org');
    await createTestUser(org.id, 'unverified-admin@example.com', 'ADMINISTRATOR');
    const cookies = await loginAs('unverified-admin@example.com');

    // No matching Application customer — nothing to verify or reconcile against.
    const created = await adminTicketPrisma.customers.create({
      data: { name: 'External Client', email: 'someone-else@example.com' },
      select: { id: true },
    });

    const res = await list(cookies);
    const match = (res.body.customers as CustomerOption[]).find((c) => c.id === created.id);
    expect(match?.name).toBe('External Client');
    expect(match?.ids).toEqual([created.id]);
    expect(match?.b2bCustomerId).toBeNull();
    expect(match?.verified).toBe(false);
  });

  it('keeps a client with no email as its own entry', async () => {
    const org = await createTestOrg('No Mail Org');
    await createTestUser(org.id, 'nomail-admin@example.com', 'ADMINISTRATOR');
    const cookies = await loginAs('nomail-admin@example.com');

    const created = await adminTicketPrisma.customers.create({
      data: { name: 'No Email Client', email: null, company: 'Side Inc' },
      select: { id: true },
    });

    const res = await list(cookies);
    const match = (res.body.customers as CustomerOption[]).find((c) => c.id === created.id);
    expect(match?.ids).toEqual([created.id]);
    expect(match?.email).toBeNull();
    expect(match?.company).toBe('Side Inc');
  });

  it('denies ORG_ADMIN — the client pool is an admin-store surface', async () => {
    const org = await createTestOrg('Customers Role Org');
    await createTestUser(org.id, 'customers-org@example.com', 'ORG_ADMIN');
    const cookies = await loginAs('customers-org@example.com');

    expect((await list(cookies)).status).toBe(403);
  });
});