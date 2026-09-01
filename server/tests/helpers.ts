import request from 'supertest';
import bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import app from '../src/app';
import { prisma } from '../src/config/database';

export async function createTestOrg(name: string) {
  const slug = name.toLowerCase().replace(/\s+/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
  return prisma.customer.create({
    data: {
      name,
      slug,
      mailId: `contact@${slug}.test`,
      contactPerson: 'Test Contact',
      contactNumber: '+1-555-0000',
    },
  });
}

export async function createTestUser(orgId: string, email: string, role: Role = 'USER') {
  const passwordHash = await bcrypt.hash('TestPassword1!', 12);
  return prisma.user.create({
    data: { email, name: 'Test User', passwordHash, role, customerId: orgId },
  });
}

export async function loginAs(email: string, password = 'TestPassword1!') {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  const cookies = res.headers['set-cookie'] as string[];
  return cookies;
}

export async function registerAndLogin(orgName: string, email: string) {
  // Registration already sets session cookies; a second cookie-less login would
  // now be blocked by single-session enforcement (409 SESSION_ACTIVE).
  const res = await request(app).post('/api/auth/register').send({
    name: 'Test User',
    email,
    password: 'TestPassword1!',
    organizationName: orgName,
    contactNumber: '+1-555-0000',
  });
  return res.headers['set-cookie'] as string[];
}

/**
 * cleanDb deletes every user and org, so it must never see a production URL.
 * vitest loads the same .env the server uses, which is exactly how the live
 * b2b_saas database was once emptied by a test run — the database name has to
 * end in `_test` or nothing runs.
 */
function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  const name = url.split('/').pop()?.split('?')[0] ?? '';
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run destructive tests against "${name || url}" — point DATABASE_URL at a *_test database.`);
  }
}

export async function cleanDb() {
  assertTestDatabase();
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.featureFlag.deleteMany();
}

export { app, request };
