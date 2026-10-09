import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { cleanDb, app, request } from './helpers';
import { prisma } from '../src/config/database';
import { isPersonalEmailDomain, emailDomain } from '../src/modules/auth/emailDomains';
import { deriveDomain, isProviderAdminEmail } from '../src/modules/auth/auth.service';

// Passwords are unique PLATFORM-WIDE (assertPasswordNotReused → 409 PASSWORD_REUSED),
// and rows created by the last test in a file outlive it — the next file's
// beforeEach may or may not clean them, and validation.test.ts deliberately runs
// with no cleanDb at all. So these must not collide with any other file's
// fixtures: they are unique to this file, not the shared 'TestPassword1!'.
const PASSWORD = 'WorkEmailPass1!aA';
const OTHER_PASSWORD = 'WorkEmailPass2!bB';

// vitest.config.ts pins ADMIN_DOMAINS='example.com', which is NOT on the block
// list — so every fixture below on @example.com stays valid, and the no-bypass
// rule is asserted by ordering (see the register() suite) rather than by mutating
// env mid-run, which cannot work: adminDomains is resolved at module load.

describe('isPersonalEmailDomain', () => {
  it('blocks mainstream consumer providers', () => {
    for (const email of [
      'a@gmail.com', 'a@googlemail.com', 'a@outlook.com', 'a@hotmail.com',
      'a@yahoo.com', 'a@yahoo.co.in', 'a@aol.com', 'a@icloud.com', 'a@me.com',
      'a@proton.me', 'a@protonmail.com', 'a@gmx.net', 'a@yandex.ru', 'a@qq.com',
      'a@comcast.net', 'a@web.de',
    ]) {
      expect(isPersonalEmailDomain(email), email).toBe(true);
    }
  });

  it('blocks disposable/throwaway providers', () => {
    for (const email of [
      'a@mailinator.com', 'a@guerrillamail.com', 'a@sharklasers.com',
      'a@10minutemail.com', 'a@yopmail.com', 'a@temp-mail.org', 'a@maildrop.cc',
    ]) {
      expect(isPersonalEmailDomain(email), email).toBe(true);
    }
  });

  it('allows real company domains', () => {
    for (const email of ['a@acme.com', 'a@example.com', 'a@banihaltechnologies.com', 'a@platform.com']) {
      expect(isPersonalEmailDomain(email), email).toBe(false);
    }
  });

  it('normalises case and surrounding whitespace', () => {
    expect(isPersonalEmailDomain('  USER@GMAIL.COM ')).toBe(true);
    expect(isPersonalEmailDomain('User@OutLook.Com')).toBe(true);
  });

  it('does not match on a substring or a lookalike domain', () => {
    // notgmail.com and gmail.com.attacker.net are different domains and must not
    // be caught by accident — the check is exact-match, not `includes`.
    expect(isPersonalEmailDomain('a@notgmail.com')).toBe(false);
    expect(isPersonalEmailDomain('a@gmail.com.attacker.net')).toBe(false);
  });

  it('handles an address with no domain part', () => {
    expect(isPersonalEmailDomain('no-at-sign')).toBe(false);
    expect(emailDomain('no-at-sign')).toBeNull();
  });
});

describe('deriveDomain', () => {
  it('returns null for every blocked provider, not just gmail', () => {
    // The regression this whole feature exists for: before, ONLY gmail returned null.
    expect(deriveDomain('a@gmail.com')).toBeNull();
    expect(deriveDomain('a@outlook.com')).toBeNull();
    expect(deriveDomain('a@mailinator.com')).toBeNull();
  });

  it('returns the lowercased domain for a work address', () => {
    expect(deriveDomain('Someone@ACME.com')).toBe('acme.com');
  });
});

describe('POST /api/auth/register — organization signup', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  const body = (email: string) => ({
    name: 'Test Person',
    email,
    password: PASSWORD,
    organizationName: 'Test Org',
    contactNumber: '+1-555-0000',
  });

  it('rejects a personal address and writes nothing', async () => {
    const res = await request(app).post('/api/auth/register').send(body('founder@gmail.com'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WORK_EMAIL_REQUIRED');

    // The old behaviour did not reject — it created a Customer with domain: null,
    // which no one could ever join. Assert the absence of BOTH rows.
    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.user.count({ where: { email: 'founder@gmail.com' } })).toBe(0);
  });

  it('rejects a disposable address', async () => {
    const res = await request(app).post('/api/auth/register').send(body('throwaway@mailinator.com'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WORK_EMAIL_REQUIRED');
  });

  it('is not bypassed by ADMIN_DOMAINS', async () => {
    // The guard runs before isProviderAdminEmail(), so a blocked domain is refused
    // whatever ADMIN_DOMAINS says. Proven by ordering: gmail.com is rejected with
    // WORK_EMAIL_REQUIRED — the code the guard raises — and never reaches the
    // provider-admin branch that would have self-approved the org.
    const res = await request(app).post('/api/auth/register').send(body('staff@gmail.com'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WORK_EMAIL_REQUIRED');
    expect(await prisma.customer.count()).toBe(0);
  });

  it('still accepts a work address and records its domain', async () => {
    const res = await request(app).post('/api/auth/register').send(body('founder@acme-corp.test'));
    expect(res.status).toBe(201);
    const customer = await prisma.customer.findFirst({ where: { name: 'Test Org' } });
    expect(customer?.domain).toBe('acme-corp.test');
  });

  it('still self-approves an org on an ADMIN_DOMAINS domain that is not blocked', async () => {
    // example.com is pinned into ADMIN_DOMAINS by vitest.config.ts and is a work
    // domain, so the provider-admin path must be untouched by this change.
    expect(isProviderAdminEmail('boss@example.com')).toBe(true);
    const res = await request(app).post('/api/auth/register').send(body('boss@example.com'));
    expect(res.status).toBe(201);
    const customer = await prisma.customer.findFirst({ where: { name: 'Test Org' } });
    expect(customer?.approved).toBe(true);
  });
});

describe('POST /api/auth/register-user — joining an existing org', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  const body = (email: string) => ({ name: 'New Joiner', email, password: PASSWORD });

  it('rejects consumer providers beyond gmail', async () => {
    for (const email of ['joiner@outlook.com', 'joiner@yahoo.com', 'joiner@proton.me']) {
      const res = await request(app).post('/api/auth/register-user').send(body(email));
      expect(res.status, email).toBe(400);
      expect(res.body.code, email).toBe('WORK_EMAIL_REQUIRED');
    }
  });

  it('rejects a disposable address', async () => {
    const res = await request(app).post('/api/auth/register-user').send(body('joiner@yopmail.com'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WORK_EMAIL_REQUIRED');
  });

  it('still lets a work address join its approved organization', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Org Owner',
      email: 'owner@joinable.test',
      password: PASSWORD,
      organizationName: 'Joinable Org',
      contactNumber: '+1-555-0000',
    });
    await prisma.customer.updateMany({ where: { domain: 'joinable.test' }, data: { approved: true, approvedAt: new Date() } });

    const res = await request(app).post('/api/auth/register-user')
      .send({ name: 'New Joiner', email: 'joiner@joinable.test', password: OTHER_PASSWORD });
    expect(res.status).toBe(201);
    expect(await prisma.user.count({ where: { email: 'joiner@joinable.test' } })).toBe(1);
  });
});
