import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { app, request, cleanDb } from './helpers';
import { prisma } from '../src/config/database';

// The first account on a platform with no Administrator bootstraps itself into
// the `administration` platform role — otherwise a fresh install has nobody who
// could invite anyone. EVERY later provider-domain signup gets `employee`.
//
// Before this rule, any mailbox on a domain listed in ADMIN_DOMAINS could
// self-register and receive every permission on the platform. These tests are
// what stop that coming back.
//
// vitest.config.ts sets ADMIN_DOMAINS=example.com, so @example.com is the
// provider domain here and anything else is a client.

// Passwords must differ per account: assertPasswordNotReused rejects a password
// another user already holds, which would fail registration for the wrong reason.
const registerOrg = (email: string, password: string, organizationName = `Org ${email}`) =>
  request(app).post('/api/auth/register').send({
    name: 'Test Person', email, password, organizationName, contactNumber: '+1-555-0000',
  });

// How real staff #2 onwards arrive: Customer.domain is unique, so only ONE org
// can ever own example.com. Everyone after the founder JOINS it by domain.
const joinOrg = (email: string, password: string) =>
  request(app).post('/api/auth/register-user').send({ name: 'Test Person', email, password });

/** A provider organization with no users — the state a race starts from. */
const emptyProviderOrg = () => prisma.customer.create({
  data: {
    name: 'Provider Co', slug: `provider-${Math.random().toString(36).slice(2, 8)}`,
    domain: 'example.com', mailId: 'ops@example.com',
    contactPerson: 'Ops', contactNumber: '+1-555-0000',
  },
});

const roleOf = async (email: string) => {
  const u = await prisma.user.findUnique({
    where: { email },
    select: { role: true, platformRole: { select: { key: true } } },
  });
  return { role: u?.role, platformRole: u?.platformRole?.key ?? null };
};

const administratorCount = () => prisma.user.count({ where: { role: 'ADMINISTRATOR' } });

beforeEach(cleanDb);
afterAll(async () => { await cleanDb(); await prisma.$disconnect(); });

describe('the first platform account bootstraps itself', () => {
  it('makes the very first provider-domain registration an Administration admin', async () => {
    expect(await administratorCount(), 'fixture must start with no administrators').toBe(0);

    expect((await registerOrg('first@example.com', 'FirstPass1!aA')).status).toBe(201);

    expect(await roleOf('first@example.com')).toEqual({ role: 'ADMINISTRATOR', platformRole: 'administration' });
  });

  it('gives every LATER provider-domain signup employee, not administration', async () => {
    await registerOrg('first@example.com', 'FirstPass1!aA');
    expect((await joinOrg('second@example.com', 'SecondPass2!bB')).status).toBe(201);
    expect((await joinOrg('third@example.com', 'ThirdPass3!cC')).status).toBe(201);

    // Still platform staff — they can sign in and work — but without
    // users.manage, roles.manage, orgs.manage or revenue.view.
    expect(await roleOf('second@example.com')).toEqual({ role: 'ADMINISTRATOR', platformRole: 'employee' });
    expect(await roleOf('third@example.com')).toEqual({ role: 'ADMINISTRATOR', platformRole: 'employee' });
  });

  it('only ever mints ONE administration account, however many register', async () => {
    await registerOrg('first@example.com', 'FirstPass1!aA');
    await joinOrg('second@example.com', 'SecondPass2!bB');

    const admins = await prisma.user.count({
      where: { role: 'ADMINISTRATOR', platformRole: { key: 'administration' } },
    });
    expect(admins).toBe(1);
  });

  it('leaves client registrations alone — no platform role at all', async () => {
    await registerOrg('first@example.com', 'FirstPass1!aA');

    expect((await registerOrg('owner@acme-client.test', 'ClientPass9!zZ')).status).toBe(201);
    expect(await roleOf('owner@acme-client.test')).toEqual({ role: 'ORG_ADMIN', platformRole: null });
  });

  it('bootstraps a client-first platform too — the rule is "no administrator yet", not "no users yet"', async () => {
    await registerOrg('owner@acme-client.test', 'ClientPass9!zZ');
    expect(await administratorCount()).toBe(0);

    await registerOrg('first@example.com', 'FirstPass1!aA');
    expect(await roleOf('first@example.com')).toEqual({ role: 'ADMINISTRATOR', platformRole: 'administration' });
  });
});

describe('concurrent first registrations cannot both become Administration', () => {
  it('serializes the bootstrap: exactly one administration, the rest employee', async () => {
    // An org exists but nobody is in it yet, so all three joiners see an empty
    // platform. Only one may bootstrap.
    await emptyProviderOrg();
    expect(await administratorCount()).toBe(0);

    // Fired together, so all three read "no administrator yet" unless the write
    // is serialized. This is the case the isolation level exists for.
    const results = await Promise.allSettled([
      joinOrg('race-a@example.com', 'RaceAlphaa1!aA'),
      joinOrg('race-b@example.com', 'RaceBravoo2!bB'),
      joinOrg('race-c@example.com', 'RaceCharlie3!cC'),
    ]);

    // Every request must have been answered — a serialization retry is internal,
    // never a 500 the caller sees.
    for (const r of results) {
      expect(r.status, 'no registration may fail outright').toBe('fulfilled');
      expect((r as PromiseFulfilledResult<{ status: number }>).value.status).toBe(201);
    }

    const administration = await prisma.user.count({
      where: { role: 'ADMINISTRATOR', platformRole: { key: 'administration' } },
    });
    const employees = await prisma.user.count({
      where: { role: 'ADMINISTRATOR', platformRole: { key: 'employee' } },
    });
    expect(administration, 'exactly one account may bootstrap').toBe(1);
    expect(employees, 'the losers must land on employee, not be dropped').toBe(2);
  });
});
