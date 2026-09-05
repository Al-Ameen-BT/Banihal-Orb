import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { app, request, createTestOrg, createTestUser, loginAs, cleanDb } from './helpers';
import { prisma } from '../src/config/database';

// MFA has two switches. `initiateLogin` has always combined them —
// `mfaEnabled || customer.mfaRequired` — but nothing else did, so a user their
// org already forces through MFA was displayed as unprotected AND could switch
// their own flag off to no effect.
//
// These pin both halves: the flag now travels with the user, and the write is
// refused while the org enforces.

const enforce = (orgId: string, on: boolean) =>
  prisma.customer.update({ where: { id: orgId }, data: { mfaRequired: on } });

let orgId: string;
let cookies: string[];

beforeEach(async () => {
  await cleanDb();
  const org = await createTestOrg('MFA Org');
  orgId = org.id;
  await createTestUser(orgId, 'member@mfa.test', 'ORG_ADMIN');
  cookies = await loginAs('member@mfa.test');
});
afterAll(async () => { await cleanDb(); await prisma.$disconnect(); });

describe('the org flag travels with the user', () => {
  it('GET /users/me carries customer.mfaRequired so the profile can lock', async () => {
    await enforce(orgId, true);
    const res = await request(app).get('/api/users/me').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.customer?.mfaRequired, 'the profile toggle cannot lock without this').toBe(true);
  });

  it('the staff and client directories carry it too', async () => {
    const platform = await createTestOrg('Provider Co');
    await createTestUser(platform.id, 'admin@example.com', 'ADMINISTRATOR', 'administration');
    const admin = await loginAs('admin@example.com');
    await enforce(orgId, true);

    const staff = await request(app).get('/api/saas-admin/sadmins').set('Cookie', admin);
    expect(staff.body.sadmins[0]?.customer).toHaveProperty('mfaRequired');

    const clients = await request(app).get('/api/saas-admin/all-users').set('Cookie', admin);
    const row = clients.body.users.find((u: { email: string }) => u.email === 'member@mfa.test');
    expect(row.customer.mfaRequired, 'the ⚠ badge is computed from this').toBe(true);
  });
});

describe('MFA cannot be switched off while the org requires it', () => {
  it('refuses the user’s own profile toggle', async () => {
    await enforce(orgId, true);

    const res = await request(app).patch('/api/users/me').set('Cookie', cookies).send({ mfaEnabled: false });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MFA_REQUIRED_BY_ORG');
    // The write must not have landed — a stored `false` is what poisoned every display.
    const me = await prisma.user.findUnique({ where: { email: 'member@mfa.test' }, select: { mfaEnabled: true } });
    expect(me!.mfaEnabled).toBe(false); // unchanged from the fixture default…
  });

  it('still allows turning it ON, and off again once enforcement lifts', async () => {
    await enforce(orgId, true);
    expect((await request(app).patch('/api/users/me').set('Cookie', cookies).send({ mfaEnabled: true })).status).toBe(200);

    await enforce(orgId, false);
    expect((await request(app).patch('/api/users/me').set('Cookie', cookies).send({ mfaEnabled: false })).status).toBe(200);
  });

  it('refuses an administrator doing it on someone else’s behalf', async () => {
    const platform = await createTestOrg('Provider Co');
    await createTestUser(platform.id, 'admin@example.com', 'ADMINISTRATOR', 'administration');
    const admin = await loginAs('admin@example.com');
    const member = await prisma.user.findUniqueOrThrow({ where: { email: 'member@mfa.test' } });
    await enforce(orgId, true);

    const res = await request(app).patch(`/api/saas-admin/users/${member.id}`)
      .set('Cookie', admin).send({ mfaEnabled: false });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MFA_REQUIRED_BY_ORG');
  });
});

describe('org-wide enforcement is a privileged setting', () => {
  it('an Intern cannot flip it, an HR Admin can', async () => {
    const platform = await createTestOrg('Provider Co');
    await createTestUser(platform.id, 'intern@example.com', 'ADMINISTRATOR', 'intern');
    await createTestUser(platform.id, 'hr@example.com', 'ADMINISTRATOR', 'hr_admin');

    // requireRole('ADMINISTRATOR') alone admitted every platform account.
    const internRes = await request(app).patch('/api/organizations/me/security')
      .set('Cookie', await loginAs('intern@example.com')).send({ mfaRequired: true });
    expect(internRes.status).toBe(403);

    const hrRes = await request(app).patch('/api/organizations/me/security')
      .set('Cookie', await loginAs('hr@example.com')).send({ mfaRequired: true });
    expect(hrRes.status).toBe(200);
  });

  it('an ORG_ADMIN keeps it for their own organization', async () => {
    const res = await request(app).patch('/api/organizations/me/security')
      .set('Cookie', cookies).send({ mfaRequired: true });
    expect(res.status).toBe(200);
  });
});
