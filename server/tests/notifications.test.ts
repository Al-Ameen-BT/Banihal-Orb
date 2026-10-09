import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request } from './helpers';
import { prisma } from '../src/config/database';
import { notify } from '../src/modules/notifications/notifications.service';

// The durable notification store. Everything else in this codebase recomputes its
// "notifications" from a localStorage watermark and forgets them on reload; these
// assertions are about the part that must NOT be forgettable.

describe('notifications', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  async function seedUser(orgName: string, email: string) {
    const org = await createTestOrg(orgName);
    const user = await createTestUser(org.id, email, 'ORG_ADMIN');
    return { org, user };
  }

  const raise = (userId: string, customerId: string, title = 'You were mentioned') =>
    notify({ userId, customerId, kind: 'ticket_mention', title, body: 'have a look', url: '/ticketing?ticket=abc', entityId: 'abc' });

  it('persists a notification and reports it as unread', async () => {
    const { org, user } = await seedUser('Notif Org', 'notif@example.com');
    await raise(user.id, org.id);

    const cookies = await loginAs('notif@example.com');
    const res = await request(app).get('/api/notifications').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('You were mentioned');
    expect(res.body.items[0].url).toBe('/ticketing?ticket=abc');
    expect(res.body.items[0].readAt).toBeNull();
  });

  it('never leaks another user’s notifications — even inside the same org', async () => {
    // The tenant extension injects customerId only. Without the explicit userId
    // filter in the service, every member of an org would read every other
    // member's notifications. This is that assertion.
    const org = await createTestOrg('Shared Org');
    const alice = await createTestUser(org.id, 'alice@example.com', 'ORG_ADMIN');
    await createTestUser(org.id, 'bob@example.com', 'ORG_ADMIN');

    await raise(alice.id, org.id, 'For Alice only');

    const bobCookies = await loginAs('bob@example.com');
    const res = await request(app).get('/api/notifications').set('Cookie', bobCookies);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.unreadCount).toBe(0);
  });

  it('marks one read, and reading does not delete it', async () => {
    const { org, user } = await seedUser('Read Org', 'reader@example.com');
    await raise(user.id, org.id);
    const cookies = await loginAs('reader@example.com');

    const before = await request(app).get('/api/notifications').set('Cookie', cookies);
    const id = before.body.items[0].id as string;

    await request(app).post(`/api/notifications/${id}/read`).set('Cookie', cookies).expect(204);

    const after = await request(app).get('/api/notifications').set('Cookie', cookies);
    expect(after.body.unreadCount).toBe(0);
    // Still present, just read — the history is not destroyed by looking at it.
    expect(after.body.items).toHaveLength(1);
    expect(after.body.items[0].readAt).not.toBeNull();
  });

  it('marking read is idempotent', async () => {
    const { org, user } = await seedUser('Idem Org', 'idem@example.com');
    await raise(user.id, org.id);
    const cookies = await loginAs('idem@example.com');
    const id = (await request(app).get('/api/notifications').set('Cookie', cookies)).body.items[0].id;

    await request(app).post(`/api/notifications/${id}/read`).set('Cookie', cookies).expect(204);
    await request(app).post(`/api/notifications/${id}/read`).set('Cookie', cookies).expect(204);
    expect((await request(app).get('/api/notifications').set('Cookie', cookies)).body.unreadCount).toBe(0);
  });

  it('one user cannot mark another user’s notification read', async () => {
    const org = await createTestOrg('Cross Read Org');
    const alice = await createTestUser(org.id, 'a-read@example.com', 'ORG_ADMIN');
    await createTestUser(org.id, 'b-read@example.com', 'ORG_ADMIN');
    await raise(alice.id, org.id);

    const aliceCookies = await loginAs('a-read@example.com');
    const id = (await request(app).get('/api/notifications').set('Cookie', aliceCookies)).body.items[0].id;

    const bobCookies = await loginAs('b-read@example.com');
    await request(app).post(`/api/notifications/${id}/read`).set('Cookie', bobCookies).expect(204);

    // Bob's call is a silent no-op — Alice's notification is untouched.
    const after = await request(app).get('/api/notifications').set('Cookie', aliceCookies);
    expect(after.body.unreadCount).toBe(1);
  });

  it('read-all clears the badge', async () => {
    const { org, user } = await seedUser('ReadAll Org', 'readall@example.com');
    await raise(user.id, org.id, 'One');
    await raise(user.id, org.id, 'Two');
    const cookies = await loginAs('readall@example.com');

    const res = await request(app).post('/api/notifications/read-all').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(2);
    expect((await request(app).get('/api/notifications').set('Cookie', cookies)).body.unreadCount).toBe(0);
  });

  it('survives a reload — the whole point of the table', async () => {
    // No watermark, no client state: a fresh session sees exactly the same list.
    const { org, user } = await seedUser('Durable Org', 'durable@example.com');
    await raise(user.id, org.id);

    const first = await loginAs('durable@example.com');
    expect((await request(app).get('/api/notifications').set('Cookie', first)).body.unreadCount).toBe(1);

    // A second, independent request — nothing carried over from the first.
    const again = await request(app).get('/api/notifications').set('Cookie', first);
    expect(again.body.unreadCount).toBe(1);
  });
});
