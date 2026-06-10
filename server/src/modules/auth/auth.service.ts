import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Role } from '@prisma/client';
import { prisma, customerContext } from '../../config/database';
import { env } from '../../config/env';
import type { RegisterInput, RegisterUserInput, LoginInput } from './auth.schema';

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

// Work-email domains permitted to hold the ADMINISTRATOR (software provider) role.
// Fail closed: an empty ADMIN_DOMAINS means no email qualifies (admin login disabled).
const adminDomains = env.ADMIN_DOMAINS.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
export function isProviderAdminEmail(email: string): boolean {
  const domain = deriveDomain(email);
  return !!domain && adminDomains.includes(domain);
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
          role: isProviderAdminEmail(input.email) ? 'ADMINISTRATOR' : 'ORG_ADMIN',
        },
      },
    },
    include: { users: true },
  });

  const user = customer.users[0]!;

  await prisma.auditLog.create({
    data: {
      action: 'CUSTOMER_CREATED',
      performedById: user.id,
      customerId: customer.id,
      metadata: {
        orgName: customer.name,
        email: user.email,
        role: user.role,
        ...(customer.domain ? { domain: customer.domain } : {}),
      },
    },
  }).catch(() => {});

  const accessToken = signAccessToken(user.id, customer.id, user.role);
  const refreshToken = await createRefreshToken(user.id);
  return { accessToken, refreshToken };
}

// Self-registration for a member joining an existing organization. The org is
// resolved from the work-email domain — no organization name is collected.
export async function registerUser(input: RegisterUserInput): Promise<TokenPair> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw Object.assign(new Error('Email already registered'), { status: 409, code: 'EMAIL_EXISTS' });
  }

  const domain = deriveDomain(input.email);
  if (!domain) {
    throw Object.assign(
      new Error('Please register with your work email, not a personal address.'),
      { status: 400, code: 'WORK_EMAIL_REQUIRED' },
    );
  }

  // Match the domain to its registered organization (domain is unique per org,
  // enforced by the @unique constraint on Customer.domain).
  const customer = await prisma.customer.findFirst({ where: { domain } });
  if (!customer) {
    throw Object.assign(
      new Error(`No organization is registered for "${domain}". Ask your administrator to register the organization first.`),
      { status: 404, code: 'ORG_NOT_FOUND' },
    );
  }
  if (customer.suspended) {
    throw Object.assign(
      new Error('This organization is suspended. Contact your administrator.'),
      { status: 403, code: 'ORG_SUSPENDED' },
    );
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      name: input.name,
      role: isProviderAdminEmail(input.email) ? 'ADMINISTRATOR' : 'USER',
      customerId: customer.id,
    },
  });

  await prisma.auditLog.create({
    data: {
      action: 'USER_REGISTERED',
      performedById: user.id,
      customerId: customer.id,
      metadata: { email: user.email, name: user.name, role: user.role, domain },
    },
  }).catch(() => {});

  const accessToken = signAccessToken(user.id, customer.id, user.role);
  const refreshToken = await createRefreshToken(user.id);
  return { accessToken, refreshToken };
}

export async function login(input: LoginInput): Promise<TokenPair> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, email: true, customerId: true, role: true, passwordHash: true },
  });

  if (!user) {
    throw Object.assign(new Error('Invalid credentials'), { status: 401, code: 'INVALID_CREDENTIALS' });
  }

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) {
    throw Object.assign(new Error('Invalid credentials'), { status: 401, code: 'INVALID_CREDENTIALS' });
  }

  // The ADMINISTRATOR (provider) role is restricted to the configured provider domain(s).
  if (user.role === 'ADMINISTRATOR' && !isProviderAdminEmail(user.email)) {
    throw Object.assign(
      new Error('Administrator access is restricted to the provider organization.'),
      { status: 403, code: 'ADMIN_DOMAIN_FORBIDDEN' },
    );
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  await prisma.auditLog.create({
    data: { action: 'LOGIN', performedById: user.id, customerId: user.customerId, metadata: { role: user.role } },
  }).catch(() => {});

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
      await prisma.auditLog.create({
        data: { action: 'LOGOUT', performedById: t.user.id, customerId: t.user.customerId, metadata: { role: t.user.role } },
      }).catch(() => {});
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
