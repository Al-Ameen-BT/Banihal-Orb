import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Role } from '@prisma/client';
import { prisma, customerContext } from '../../config/database';
import { env } from '../../config/env';
import type { RegisterInput, RegisterSaasInput, LoginInput } from './auth.schema';

const BCRYPT_ROUNDS = 12;

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) + '-' + crypto.randomBytes(3).toString('hex');
}

function signAccessToken(userId: string, customerId: string, role: Role): string {
  return jwt.sign({ userId, customerId, role, type: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

// Derive the domain from a contact email, ignoring generic gmail addresses.
export function deriveDomain(email: string): string | null {
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain || domain === 'gmail.com') return null;
  return domain;
}

async function createRefreshToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(64).toString('hex');
  const hash = await bcrypt.hash(raw, BCRYPT_ROUNDS);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await prisma.refreshToken.create({ data: { tokenHash: hash, userId, expiresAt } });
  return raw;
}

export async function register(input: RegisterInput): Promise<TokenPair> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const slug = generateSlug(input.organizationName);

  const customer = await prisma.customer.create({
    data: {
      name: input.organizationName,
      slug,
      mailId: input.email,
      contactPerson: input.name,
      contactNumber: input.contactNumber,
      domain: deriveDomain(input.email),
      users: {
        create: {
          email: input.email,
          passwordHash,
          name: input.name,
          role: 'ORG_ADMIN',
        },
      },
    },
    include: { users: true },
  });

  const user = customer.users[0]!;
  const accessToken = signAccessToken(user.id, customer.id, user.role);
  const refreshToken = await createRefreshToken(user.id);
  return { accessToken, refreshToken };
}

// Derive a stable customer slug from a Sadmin's email domain.
// e.g. admin@acompany.in → platform-acompany-in
function domainSlug(email: string): string {
  const domain = email.split('@')[1]?.toLowerCase().trim() ?? 'unknown';
  return `platform-${domain.replace(/\./g, '-')}`;
}

export async function registerSaas(input: RegisterSaasInput): Promise<TokenPair> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw Object.assign(new Error('Email already registered'), { status: 409, code: 'EMAIL_EXISTS' });
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  // Group Sadmins by work-email domain: admin@acompany.in → customer slug "platform-acompany-in"
  const slug = domainSlug(input.email);
  const domain = input.email.split('@')[1]?.toLowerCase().trim() ?? 'unknown';

  let domainCustomer = await prisma.customer.findUnique({ where: { slug } });
  if (!domainCustomer) {
    domainCustomer = await prisma.customer.create({
      data: {
        name: `${domain} Platform`,
        slug,
        mailId: input.email,
        contactPerson: input.name,
        contactNumber: input.contactNumber,
        domain: deriveDomain(input.email),
      },
    });
  }

  // Platform self-registrants (grouped by work-email domain) are all ADMINISTRATOR.
  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      name: input.name,
      role: 'ADMINISTRATOR',
      customerId: domainCustomer.id,
    },
  });

  const accessToken = signAccessToken(user.id, domainCustomer.id, user.role);
  const refreshToken = await createRefreshToken(user.id);
  return { accessToken, refreshToken };
}

export async function login(input: LoginInput): Promise<TokenPair> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, customerId: true, role: true, passwordHash: true },
  });

  if (!user) {
    throw Object.assign(new Error('Invalid credentials'), { status: 401, code: 'INVALID_CREDENTIALS' });
  }

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) {
    throw Object.assign(new Error('Invalid credentials'), { status: 401, code: 'INVALID_CREDENTIALS' });
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  if (user.role === 'ADMINISTRATOR') {
    await prisma.auditLog.create({
      data: { action: 'LOGIN', performedById: user.id, customerId: user.customerId },
    }).catch(() => {});
  }

  const accessToken = signAccessToken(user.id, user.customerId, user.role);
  const refreshToken = await createRefreshToken(user.id);
  return { accessToken, refreshToken };
}

export async function refreshTokens(rawRefreshToken: string): Promise<TokenPair> {
  // Find all non-expired tokens and check against each
  const tokens = await prisma.refreshToken.findMany({
    where: { expiresAt: { gt: new Date() } },
    include: { user: { select: { id: true, customerId: true, role: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  let matched: (typeof tokens)[number] | undefined;
  for (const t of tokens) {
    const ok = await bcrypt.compare(rawRefreshToken, t.tokenHash);
    if (ok) { matched = t; break; }
  }

  if (!matched) {
    throw Object.assign(new Error('Invalid or expired refresh token'), { status: 401, code: 'REFRESH_TOKEN_INVALID' });
  }

  // One-time-use: delete old token
  await prisma.refreshToken.delete({ where: { id: matched.id } });

  const { user } = matched;
  const accessToken = signAccessToken(user.id, user.customerId, user.role);
  const refreshToken = await createRefreshToken(user.id);
  return { accessToken, refreshToken };
}

export async function logout(rawRefreshToken: string): Promise<void> {
  const tokens = await prisma.refreshToken.findMany({
    where: { expiresAt: { gt: new Date() } },
    include: { user: { select: { id: true, customerId: true, role: true } } },
    take: 500,
  });

  for (const t of tokens) {
    const ok = await bcrypt.compare(rawRefreshToken, t.tokenHash);
    if (ok) {
      await prisma.refreshToken.delete({ where: { id: t.id } });
      if (t.user.role === 'ADMINISTRATOR') {
        await prisma.auditLog.create({
          data: { action: 'LOGOUT', performedById: t.user.id, customerId: t.user.customerId },
        }).catch(() => {});
      }
      return;
    }
  }
}

export function signImpersonationToken(userId: string, customerId: string, role: Role): string {
  return jwt.sign({ userId, customerId, role, type: 'impersonation' }, env.IMPERSONATION_SECRET, {
    expiresIn: '5m',
  });
}

// Run a callback outside tenant scope (for SADMIN / ADMINISTRATOR global queries)
export async function withoutTenantScope<T>(fn: () => Promise<T>): Promise<T> {
  return customerContext.run({} as { customerId: string }, fn);
}
