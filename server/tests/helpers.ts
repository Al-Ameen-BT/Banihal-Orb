import request from 'supertest';
import bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import app from '../src/app';
import { prisma } from '../src/config/database';

/**
 * `approved` is stamped for the same reason `emailVerifiedAt` is on createTestUser:
 * login (and every authenticated request) is blocked while an org is awaiting
 * platform approval, so an un-approved fixture would fail every test that signs in.
 * Tests exercising the approval gate itself should set `approved: false` explicitly.
 */
export async function createTestOrg(name: string, approved = true) {
  const slug = name.toLowerCase().replace(/\s+/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
  return prisma.customer.create({
    data: {
      name,
      slug,
      mailId: `contact@${slug}.test`,
      contactPerson: 'Test Contact',
      contactNumber: '+1-555-0000',
      approved,
      ...(approved ? { approvedAt: new Date() } : {}),
    },
  });
}

/**
 * `platformRoleKey` names the vendor-staff role (administration | hr_admin |
 * employee | intern) and is REQUIRED when role is ADMINISTRATOR — a DB CHECK
 * constraint rejects platform staff without one. Defaults to administration so
 * existing tests that pass only 'ADMINISTRATOR' keep their old behaviour.
 *
 * `emailVerifiedAt` is stamped because login is blocked while it is null; tests
 * that exercise the verification gate itself should clear it explicitly.
 */
export async function createTestUser(
  orgId: string,
  email: string,
  role: Role = 'USER',
  platformRoleKey?: string,
) {
  const passwordHash = await bcrypt.hash('TestPassword1!', 12);
  const key = role === 'ADMINISTRATOR' ? (platformRoleKey ?? 'administration') : platformRoleKey;
  const platformRole = key
    ? await prisma.platformRole.findUnique({ where: { key }, select: { id: true } })
    : null;
  if (key && !platformRole) {
    throw new Error(`Platform role "${key}" is missing — run db/b2b.sql against the test database.`);
  }

  return prisma.user.create({
    data: {
      email,
      name: 'Test User',
      passwordHash,
      role,
      customerId: orgId,
      emailVerifiedAt: new Date(),
      ...(platformRole ? { platformRoleId: platformRole.id } : {}),
    },
  });
}

export async function loginAs(email: string, password = 'TestPassword1!') {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  const cookies = res.headers['set-cookie'] as string[];
  return cookies;
}

/**
 * Register an organization and return a logged-in session for its ORG_ADMIN.
 *
 * Registration deliberately no longer returns session cookies — signing up used
 * to BE a login, which left the email-verification gate with nothing to guard
 * (auth.service.register). So the flow is three steps now, and the middle one is
 * short-circuited here: callers just need a usable session. A test OF the
 * verification flow should register and redeem the real token instead.
 */
export async function registerAndLogin(orgName: string, email: string) {
  const res = await request(app).post('/api/auth/register').send({
    name: 'Test User',
    email,
    password: 'TestPassword1!',
    organizationName: orgName,
    contactNumber: '+1-555-0000',
  });
  if (res.status !== 201) throw new Error(`register failed (${res.status}): ${JSON.stringify(res.body)}`);
  await verifyUser(email);
  await approveOrgOf(email);
  return loginAs(email);
}

/** Mark an account's email confirmed, the way redeeming the link would. */
export async function verifyUser(email: string): Promise<void> {
  await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
}

/**
 * Admit the organization this account belongs to, the way a staff member handing
 * over the approval code would. Self-registration now creates a PENDING org, so
 * without this every registerAndLogin fixture would stop at ORG_NOT_APPROVED.
 */
export async function approveOrgOf(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email }, select: { customerId: true } });
  if (!user) return;
  await prisma.customer.update({
    where: { id: user.customerId },
    data: { approved: true, approvedAt: new Date() },
  });
}

/**
 * cleanDb deletes every user and org, so it must never see a production URL.
 * vitest loads the same .env the server uses, which is exactly how the live
 * b2b_saas database was once emptied by a test run — the database name has to
 * end in `_test` or nothing runs.
 */
const dbName = (url: string): string => url.split('/').pop()?.split('?')[0] ?? '';
const isTestDb = (url: string | undefined): boolean => Boolean(url) && dbName(url!).endsWith('_test');

function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!isTestDb(url)) {
    throw new Error(`Refusing to run destructive tests against "${dbName(url) || url}" — point DATABASE_URL at a *_test database.`);
  }
}

/**
 * The ticket stores live in their OWN databases and assertTestDatabase above does
 * not cover them — it only ever guarded DATABASE_URL. A test that writes a real
 * ticket (the first-wins claim) would otherwise land in whatever `.env` points at,
 * which in a normal checkout is the DEV store.
 *
 * Returns false rather than throwing so such a test can SKIP with a reason instead
 * of failing a suite that has no ticket database configured at all.
 */
export function ticketTestDbReady(): boolean {
  return isTestDb(process.env['ADMIN_TICKETING_DATABASE_URL']) && isTestDb(process.env['TICKET_DATABASE_URL']);
}

/** Names the misconfigured URL, so a skipped ticket test says WHY it skipped. */
export function ticketDbSkipReason(): string {
  const bad = (['ADMIN_TICKETING_DATABASE_URL', 'TICKET_DATABASE_URL'] as const)
    .filter((k) => !isTestDb(process.env[k]))
    .map((k) => `${k}=${dbName(process.env[k] ?? '') || '(unset)'}`);
  return `needs a *_test ticket store — ${bad.join(', ')}`;
}

export async function cleanDb() {
  assertTestDatabase();
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.emailVerificationToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.featureFlag.deleteMany();
  // PlatformRole is deliberately NOT deleted: the four system roles come from
  // db/b2b.sql, not from any test, and createTestUser looks them up by key.
}

export { app, request };
