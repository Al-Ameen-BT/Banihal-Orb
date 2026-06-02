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
  await request(app).post('/api/auth/register').send({
    name: 'Test User',
    email,
    password: 'TestPassword1!',
    organizationName: orgName,
    contactNumber: '+1-555-0000',
  });
  return loginAs(email);
}

export async function cleanDb() {
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.featureFlag.deleteMany();
}

export { app, request };
