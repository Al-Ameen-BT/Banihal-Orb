import request from 'supertest';
import { describe, it, expect } from 'vitest';
import app from '../src/app';
import { createTestOrg, createTestUser, loginAs, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';

// Cross-org assignee isolation: the shared ticket store (b2b_ticket) spans EVERY
// tenant, plus the platform's own staff. The org assignee pool used to be built
// with db.listStaff() — a global scan of that store — so org A's New Ticket form
// offered org B's people (and Banihal's platform team) as assignees. Reservation:
// an org may only ever see/assign its OWN staff, scoped by the caller's
// customerId in the Application directory, never by a global roster.
const ready = ticketTestDbReady();
describe.skipIf(!ready)(`assignee pool is org-scoped${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, () => {
  const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

  async function orgWithMembers(tag: string, count: number) {
    const org = await createTestOrg(`${tag} org ${now}`);
    const users = [];
    for (let i = 0; i < count; i++) users.push(await createTestUser(org.id, `${tag}-u${i}-${now}@${tag}.test`, 'USER'));
    return { org, users };
  }

  // Bridging into the store happens lazily on the first authenticated ticketing
  // action. ONE login per user — logging in twice trips the single-active-session
  // guard, and a second session must not be what we test.
  async function bridge(cookies: string[]) {
    await request(app).get('/api/ticketing/tickets?mine=true').set('Cookie', cookies).expect(200);
  }

  it(`org A never sees org B's staff (and vice versa)`, async () => {
    const { users: aUsers } = await orgWithMembers('poolA', 2);
    const { users: bUsers } = await orgWithMembers('poolB', 1);

    const cookiesA = await Promise.all(aUsers.map((u) => loginAs(u.email)));
    const cookiesB = await Promise.all(bUsers.map((u) => loginAs(u.email)));
    for (const c of [...cookiesA, ...cookiesB]) await bridge(c);

    const forA = (await request(app).get('/api/ticketing/assignees').set('Cookie', cookiesA[0]!).expect(200)).body.assignees as { email: string }[];
    const forB = (await request(app).get('/api/ticketing/assignees').set('Cookie', cookiesB[0]!).expect(200)).body.assignees as { email: string }[];
    const emailsA = forA.map((x) => x.email.toLowerCase());
    const emailsB = forB.map((x) => x.email.toLowerCase());

    for (const u of aUsers) {
      expect(emailsA, `org A must see its own member ${u.email}`).toContain(u.email.toLowerCase());
      expect(emailsB, `org B must NOT see ${u.email}`).not.toContain(u.email.toLowerCase());
    }
    for (const u of bUsers) {
      expect(emailsB, `org B must see its own member ${u.email}`).toContain(u.email.toLowerCase());
      expect(emailsA, `org A must NOT see ${u.email}`).not.toContain(u.email.toLowerCase());
    }
  });

  it(`an org admin's pool is prefixed with the advisory 'Banihal Support' escalation option`, async () => {
    const { users } = await orgWithMembers('poolC', 1);
    await prisma.user.update({ where: { id: users[0].id }, data: { role: 'ORG_ADMIN' } });
    const cookies = await loginAs(users[0].email);
    await bridge(cookies);

    const res = await request(app).get('/api/ticketing/assignees').set('Cookie', cookies).expect(200);
    const items = res.body.assignees as { id: string; name: string }[];
    const escalate = items.find((a) => a.id === '__escalate_admins__');
    expect(escalate, 'ORG_ADMIN must see the escalate option').toBeDefined();
    expect(escalate!.name).toBe('Banihal Support');
  });

  it(`platform administrators use the admin store's own roster, not any org's`, async () => {
    // ADMINISTRATOR login is domain-gated (vitest.config.ts pins ADMIN_DOMAINS to
    // `example.com`), so the admin account must live on that test provider domain.
    const { org } = await orgWithMembers('poolD', 1);
    const adminUser = await createTestUser(org.id, `platform-${now}@example.com`, 'ADMINISTRATOR', 'administration');
    const cookies = await loginAs(adminUser.email);
    await bridge(cookies);

    const res = await request(app).get('/api/ticketing/assignees').set('Cookie', cookies).expect(200);
    const emails = (res.body.assignees as { email: string }[]).map((x) => x.email.toLowerCase());
    // The admin roster comes from the ADMIN store (admin/manager/developer/tester)
    // and is platform-scoped — at minimum it must contain the bridged administrator.
    expect(emails).toContain(adminUser.email.toLowerCase());
  });
});