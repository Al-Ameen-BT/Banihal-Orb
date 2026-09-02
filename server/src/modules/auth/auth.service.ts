import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Role } from '@prisma/client';
import { prisma } from '../../config/database';
import { assertPasswordNotReused, passwordFingerprint } from './passwordReuse';
import { env } from '../../config/env';
import { uniqueOrgCode } from '../../utils/orgCode';
import { ADMINISTRATION_ROLE_KEY } from '../../config/permissions';
import * as mailService from '../mail/mail.service';
import type { RegisterInput, RegisterUserInput, LoginInput, ForgotPasswordInput, ResetPasswordInput } from './auth.schema';

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

// `prid` is the platform-staff role id, carried so auth.middleware can resolve the
// caller's permissions from a process-local map instead of a per-request query.
// Null for customer accounts. Like `role`, it is only as fresh as the token: a
// role REASSIGNMENT takes effect within the 15-minute access lifetime, or
// immediately if the caller also deletes the target's refresh tokens.
function signAccessToken(
  userId: string,
  customerId: string,
  role: Role,
  sessionId: string,
  platformRoleId: string | null = null,
): string {
  return jwt.sign(
    { userId, customerId, role, prid: platformRoleId, sid: sessionId, type: 'access' },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'] },
  );
}

// Stable per-login session identity — survives refresh-token rotation and is
// embedded in every access JWT (`sid`) so revocation takes effect immediately.
function newSessionId(): string {
  return crypto.randomBytes(24).toString('hex');
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
  // Match the raw email domain against ADMIN_DOMAINS directly — intentionally
  // NOT via deriveDomain(). deriveDomain treats gmail.com as "no domain" (an org
  // can't be keyed off gmail), but a provider admin domain CAN be gmail.com when
  // it's explicitly listed in ADMIN_DOMAINS.
  const domain = email.split('@')[1]?.toLowerCase().trim();
  return !!domain && adminDomains.includes(domain);
}

async function createRefreshToken(userId: string, sessionId: string): Promise<string> {
  const raw = crypto.randomBytes(64).toString('hex');
  const hash = await bcrypt.hash(raw, BCRYPT_ROUNDS);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await prisma.refreshToken.create({ data: { tokenHash: hash, userId, sessionId, expiresAt } });
  return raw;
}

// Platform staff must always carry a platform role — a DB CHECK constraint
// enforces it, so assigning ADMINISTRATOR without one is a failed INSERT, not a
// degraded account. Resolved by key rather than by the seeded id so a renamed or
// re-seeded row still matches.
//
// Returns null when the role is missing, which is only possible on a database
// that has not had db/b2b.sql applied. Callers treat null as "cannot mint staff".
async function administrationRoleId(): Promise<string | null> {
  const row = await prisma.platformRole.findUnique({
    where: { key: ADMINISTRATION_ROLE_KEY },
    select: { id: true },
  });
  return row?.id ?? null;
}

export async function register(input: RegisterInput): Promise<TokenPair> {
  await assertPasswordNotReused(input.password);
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const slug = generateSlug(input.organizationName);

  // Self-service platform-admin creation is a hole that P3 closes outright. Until
  // then it must at least produce a VALID row: ADMINISTRATOR paired with the
  // Administration platform role.
  const isProviderAdmin = isProviderAdminEmail(input.email);
  const platformRoleId = isProviderAdmin ? await administrationRoleId() : null;
  if (isProviderAdmin && !platformRoleId) {
    throw Object.assign(
      new Error('Platform roles are not provisioned. Run db/provision.sh before registering staff.'),
      { status: 503, code: 'PLATFORM_ROLES_MISSING' },
    );
  }

  const customer = await prisma.customer.create({
    data: {
      name: input.organizationName,
      slug,
      mailId: input.email,
      contactPerson: input.name,
      contactNumber: input.contactNumber,
      domain: deriveDomain(input.email),
      orgCode: await uniqueOrgCode(input.organizationName),
      users: {
        create: {
          email: input.email,
          passwordHash,
          passwordFingerprint: passwordFingerprint(input.password),
          name: input.name,
          role: isProviderAdmin ? 'ADMINISTRATOR' : 'ORG_ADMIN',
          ...(platformRoleId ? { platformRoleId } : {}),
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

  const sessionId = newSessionId();
  const accessToken = signAccessToken(user.id, customer.id, user.role, sessionId);
  const refreshToken = await createRefreshToken(user.id, sessionId);
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

  await assertPasswordNotReused(input.password);
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  // Same pairing rule as register(): ADMINISTRATOR is invalid without a platform role.
  const isProviderAdmin = isProviderAdminEmail(input.email);
  const platformRoleId = isProviderAdmin ? await administrationRoleId() : null;
  if (isProviderAdmin && !platformRoleId) {
    throw Object.assign(
      new Error('Platform roles are not provisioned. Run db/provision.sh before registering staff.'),
      { status: 503, code: 'PLATFORM_ROLES_MISSING' },
    );
  }

  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      passwordFingerprint: passwordFingerprint(input.password),
      name: input.name,
      role: isProviderAdmin ? 'ADMINISTRATOR' : 'USER',
      ...(platformRoleId ? { platformRoleId } : {}),
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

  const sessionId = newSessionId();
  const accessToken = signAccessToken(user.id, customer.id, user.role, sessionId);
  const refreshToken = await createRefreshToken(user.id, sessionId);
  return { accessToken, refreshToken };
}

// Identity of the session the login request itself was made under (parsed from
// the access cookie by the controller) — used to allow same-browser re-login.
export interface CurrentSession {
  userId: string;
  sessionId: string;
}

const invalidCredentials = () => Object.assign(new Error('Invalid credentials'), { status: 401, code: 'INVALID_CREDENTIALS' });
const challengeInvalid = () => Object.assign(new Error('This verification code has expired. Please sign in again.'), { status: 400, code: 'MFA_CHALLENGE_INVALID' });

// Enforce the strict single-active-session rule. Throws SESSION_ACTIVE when
// another browser still holds an active session; a session idle past
// SESSION_INACTIVITY_MINUTES no longer counts. Runs BEFORE a code is emailed so
// a blocked login never sends an MFA email.
async function assertNoActiveOtherSession(
  user: { id: string; role: Role; customerId: string },
  currentSession?: CurrentSession | null,
  rawRefreshToken?: string | null,
): Promise<void> {
  // A re-login from the browser that owns the current session is allowed.
  let sameBrowser = currentSession?.userId === user.id;

  // The access cookie lives only 15 minutes, so the sid claim alone can't prove
  // same-browser after a short idle. The refresh cookie lives 7 days — if this
  // request carries the refresh token of one of this user's sessions, it IS the
  // session's browser.
  if (!sameBrowser && rawRefreshToken) {
    const rows = await prisma.refreshToken.findMany({
      where: { userId: user.id, expiresAt: { gt: new Date() } },
      select: { tokenHash: true },
    });
    for (const row of rows) {
      if (await bcrypt.compare(rawRefreshToken, row.tokenHash)) { sameBrowser = true; break; }
    }
  }
  if (!sameBrowser) {
    const activeSince = new Date(Date.now() - env.SESSION_INACTIVITY_MINUTES * 60_000);
    const activeSession = await prisma.refreshToken.findFirst({
      where: { userId: user.id, expiresAt: { gt: new Date() }, lastUsedAt: { gte: activeSince } },
      select: { id: true },
    });
    if (activeSession) {
      await prisma.auditLog.create({
        data: {
          action: 'LOGIN_BLOCKED_ACTIVE_SESSION', performedById: user.id, customerId: user.customerId,
          metadata: { role: user.role },
        },
      }).catch(() => {});
      throw Object.assign(
        new Error(`You're already signed in on another device or browser. Sign out there (or stay inactive for ${env.SESSION_INACTIVITY_MINUTES} minutes), then try again.`),
        { status: 409, code: 'SESSION_ACTIVE' },
      );
    }
  }
}

// Issue session tokens for a user whose identity is already proven (password +
// email code). Replaces any existing session — at most one row survives.
async function finalizeLogin(user: { id: string; customerId: string; role: Role; platformRoleId?: string | null }): Promise<TokenPair> {
  await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await prisma.auditLog.create({
    data: { action: 'LOGIN', performedById: user.id, customerId: user.customerId, metadata: { role: user.role } },
  }).catch(() => {});

  const sessionId = newSessionId();
  const accessToken = signAccessToken(user.id, user.customerId, user.role, sessionId, user.platformRoleId ?? null);
  const refreshToken = await createRefreshToken(user.id, sessionId);
  return { accessToken, refreshToken };
}

// Generate, hash, store and email a fresh 6-digit code. Replaces any prior
// challenge for the user so only the newest code is ever valid.
async function issueMfaChallenge(userId: string, email: string): Promise<string> {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + env.MFA_CODE_TTL_MINUTES * 60_000);

  await prisma.emailMfaChallenge.deleteMany({ where: { userId } });
  const challenge = await prisma.emailMfaChallenge.create({
    data: { userId, codeHash, expiresAt, lastSentAt: new Date() },
    select: { id: true },
  });
  await mailService.sendMfaCodeEmail(email, code, env.MFA_CODE_TTL_MINUTES);
  return challenge.id;
}

export interface MfaChallenge {
  challengeId: string;
  email: string;
}

// ─── Trusted devices ("Remember this device") ───────────────────────────────
// After a successful MFA verify with rememberDevice, the browser gets a
// long-lived httpOnly cookie `id.rawToken`; a matching, unexpired row lets the
// same browser skip the email code on later logins. Token stored SHA-256 hashed.
export const TRUSTED_DEVICE_DAYS = 7;
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function createTrustedDevice(userId: string): Promise<{ cookieValue: string; maxAgeMs: number } | null> {
  // Housekeeping: drop this user's expired device rows.
  await prisma.trustedDevice.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } }).catch(() => {});
  const raw = crypto.randomBytes(32).toString('hex');
  const maxAgeMs = TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000;
  try {
    const row = await prisma.trustedDevice.create({
      data: { userId, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + maxAgeMs) },
      select: { id: true },
    });
    return { cookieValue: `${row.id}.${raw}`, maxAgeMs };
  } catch (err) {
    // "Remember this device" is a convenience, not a requirement. If the
    // TrustedDevice store is unavailable (missing table / unreachable DB), the
    // MFA verify still succeeded — just skip the cookie instead of 500-ing login.
    console.error('[auth] createTrustedDevice failed; skipping trusted-device cookie:', err);
    return null;
  }
}

// True when the cookie identifies a live trusted device belonging to THIS user.
async function isTrustedDevice(userId: string, cookieValue: string | null | undefined): Promise<boolean> {
  if (!cookieValue) return false;
  const dot = cookieValue.indexOf('.');
  if (dot <= 0) return false;
  const id = cookieValue.slice(0, dot);
  const raw = cookieValue.slice(dot + 1);
  // A lookup failure (missing table / unreachable DB) must not break login —
  // treat this browser as untrusted and fall through to the normal MFA code.
  const row = await prisma.trustedDevice.findUnique({ where: { id } }).catch(() => null);
  if (!row || row.userId !== userId || row.expiresAt < new Date()) return false;
  if (sha256(raw) !== row.tokenHash) return false;
  await prisma.trustedDevice.update({ where: { id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return true;
}

export type LoginOutcome =
  | { mfaRequired: true; challenge: MfaChallenge }
  | { mfaRequired: false; tokens: TokenPair };

// Step 1 of login: validate credentials, role, and the session lock. On a
// TRUSTED device the session is issued immediately (no email code); otherwise
// a one-time code is emailed and verifyMfa issues the tokens.
export async function initiateLogin(
  input: LoginInput,
  currentSession?: CurrentSession | null,
  rawRefreshToken?: string | null,
  trustedDeviceCookie?: string | null,
): Promise<LoginOutcome> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, email: true, customerId: true, role: true, platformRoleId: true, passwordHash: true, mfaEnabled: true, customer: { select: { mfaRequired: true } } },
  });
  if (!user) throw invalidCredentials();

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) throw invalidCredentials();

  // The ADMINISTRATOR (provider) role is restricted to the configured provider domain(s).
  if (user.role === 'ADMINISTRATOR' && !isProviderAdminEmail(user.email)) {
    throw Object.assign(
      new Error('Administrator access is restricted to the provider organization.'),
      { status: 403, code: 'ADMIN_DOMAIN_FORBIDDEN' },
    );
  }

  await assertNoActiveOtherSession(user, currentSession, rawRefreshToken);

  // ─── Conditional MFA ──────────────────────────────────────────────────────
  // Email MFA is opt-in per user (User.mfaEnabled, default off — toggled from
  // the profile page), and can additionally be enforced org-wide by an org admin
  // (Customer.mfaRequired). When neither is set, the password alone completes the
  // login and NO email code is issued — there is no mandatory OTP step.
  const mfaOn = user.mfaEnabled || user.customer.mfaRequired;
  if (!mfaOn) {
    return { mfaRequired: false, tokens: await finalizeLogin(user) };
  }

  // Trusted device → password alone completes the login (MFA was proven on this
  // browser within the last TRUSTED_DEVICE_DAYS).
  if (await isTrustedDevice(user.id, trustedDeviceCookie)) {
    await prisma.auditLog.create({
      data: { action: 'LOGIN_TRUSTED_DEVICE', performedById: user.id, customerId: user.customerId, metadata: { role: user.role } },
    }).catch(() => {});
    return { mfaRequired: false, tokens: await finalizeLogin(user) };
  }

  const challengeId = await issueMfaChallenge(user.id, user.email);
  await prisma.auditLog.create({
    data: { action: 'MFA_CHALLENGE_SENT', performedById: user.id, customerId: user.customerId, metadata: { role: user.role } },
  }).catch(() => {});
  return { mfaRequired: true, challenge: { challengeId, email: user.email } };
}

// Step 2 of login: validate the emailed code and issue session tokens.
export async function verifyMfa(challengeId: string, code: string): Promise<TokenPair & { userId: string }> {
  const challenge = await prisma.emailMfaChallenge.findUnique({
    where: { id: challengeId },
    include: { user: { select: { id: true, customerId: true, role: true, platformRoleId: true } } },
  });

  if (!challenge || challenge.consumedAt || challenge.expiresAt < new Date()) throw challengeInvalid();

  if (challenge.attempts >= env.MFA_MAX_ATTEMPTS) {
    await prisma.emailMfaChallenge.delete({ where: { id: challenge.id } }).catch(() => {});
    throw Object.assign(new Error('Too many incorrect attempts. Please sign in again.'), { status: 429, code: 'MFA_TOO_MANY_ATTEMPTS' });
  }

  const ok = await bcrypt.compare(code, challenge.codeHash);
  if (!ok) {
    const updated = await prisma.emailMfaChallenge.update({
      where: { id: challenge.id }, data: { attempts: { increment: 1 } }, select: { attempts: true },
    });
    const remaining = Math.max(0, env.MFA_MAX_ATTEMPTS - updated.attempts);
    throw Object.assign(
      new Error(remaining > 0 ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.` : 'Too many incorrect attempts. Please sign in again.'),
      { status: 400, code: 'MFA_CODE_INVALID', remaining },
    );
  }

  // Burn the challenge so the code can't be replayed.
  await prisma.emailMfaChallenge.delete({ where: { id: challenge.id } }).catch(() => {});
  const tokens = await finalizeLogin(challenge.user);
  return { ...tokens, userId: challenge.user.id };
}

// Re-send a fresh code for an in-flight challenge (subject to a short cooldown).
// The challengeId stays stable so the client need not update it.
export async function resendMfaCode(challengeId: string): Promise<{ email: string }> {
  const challenge = await prisma.emailMfaChallenge.findUnique({
    where: { id: challengeId },
    include: { user: { select: { email: true } } },
  });
  if (!challenge || challenge.consumedAt) throw challengeInvalid();

  const waitMs = challenge.lastSentAt.getTime() + env.MFA_RESEND_COOLDOWN_SECONDS * 1000 - Date.now();
  if (waitMs > 0) {
    throw Object.assign(
      new Error(`Please wait ${Math.ceil(waitMs / 1000)}s before requesting another code.`),
      { status: 429, code: 'MFA_RESEND_COOLDOWN', retryAfter: Math.ceil(waitMs / 1000) },
    );
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + env.MFA_CODE_TTL_MINUTES * 60_000);
  await prisma.emailMfaChallenge.update({
    where: { id: challenge.id },
    data: { codeHash, expiresAt, attempts: 0, lastSentAt: new Date() },
  });
  await mailService.sendMfaCodeEmail(challenge.user.email, code, env.MFA_CODE_TTL_MINUTES);
  return { email: challenge.user.email };
}

export async function refreshTokens(rawRefreshToken: string): Promise<TokenPair> {
  // Find all non-expired tokens and check against each
  const tokens = await prisma.refreshToken.findMany({
    where: { expiresAt: { gt: new Date() } },
    include: { user: { select: { id: true, customerId: true, role: true, platformRoleId: true } } },
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

  // One-time-use rotation: replace the token but keep the same session identity
  // so outstanding access tokens (sid claim) remain valid.
  await prisma.refreshToken.delete({ where: { id: matched.id } });

  const { user } = matched;
  const accessToken = signAccessToken(user.id, user.customerId, user.role, matched.sessionId, user.platformRoleId);
  const refreshToken = await createRefreshToken(user.id, matched.sessionId);
  return { accessToken, refreshToken };
}

// Revoke every session for a user (logout via the access token's identity —
// works even when the path-scoped refresh cookie isn't sent with the request).
export async function logoutByUser(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, customerId: true, role: true },
  });
  if (!user) return;

  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.auditLog.create({
    data: { action: 'LOGOUT', performedById: user.id, customerId: user.customerId, metadata: { role: user.role } },
  }).catch(() => {});
}

export async function logout(rawRefreshToken: string): Promise<void> {
  const tokens = await prisma.refreshToken.findMany({
    where: { expiresAt: { gt: new Date() } },
    include: { user: { select: { id: true, customerId: true, role: true, platformRoleId: true } } },
    take: 500,
  });

  for (const t of tokens) {
    const ok = await bcrypt.compare(rawRefreshToken, t.tokenHash);
    if (ok) {
      // Single-session model: explicit logout revokes every session for the user,
      // which also releases the login lock immediately.
      await prisma.refreshToken.deleteMany({ where: { userId: t.user.id } });
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

export async function forgotPassword(input: ForgotPasswordInput): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
  });

  // Do NOT reveal whether the email is registered (prevents account enumeration).
  // The controller returns the same generic response regardless; here we simply
  // skip token creation + email when there is no matching account.
  if (!user) return;

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = await bcrypt.hash(rawToken, BCRYPT_ROUNDS);

  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 1); // Token expires in 1 hour

  await prisma.passwordResetToken.create({
    data: {
      tokenHash,
      userId: user.id,
      expiresAt,
    },
  });

  // Delegate to mail service. The link host is configurable (FRONTEND_URL) so it
  // works in every environment, not just local dev.
  const resetLink = `${env.FRONTEND_URL.replace(/\/$/, '')}/reset-password?token=${rawToken}`;
  await mailService.sendPasswordResetEmail(user.email, resetLink);
}

export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  // Find all valid (unexpired) reset tokens
  const tokens = await prisma.passwordResetToken.findMany({
    where: { expiresAt: { gt: new Date() } },
    include: { user: true },
  });

  let matchedToken = null;
  for (const t of tokens) {
    if (await bcrypt.compare(input.token, t.tokenHash)) {
      matchedToken = t;
      break;
    }
  }

  if (!matchedToken) {
    throw Object.assign(new Error('Invalid or expired reset token'), { status: 400, code: 'INVALID_TOKEN' });
  }

  // Reject a password another account already uses (self excluded — reusing your OWN
  // previous password is a different policy and not blocked here).
  await assertPasswordNotReused(input.newPassword, matchedToken.userId);
  const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);

  await prisma.user.update({
    where: { id: matchedToken.userId },
    data: { passwordHash, passwordFingerprint: passwordFingerprint(input.newPassword) },
  });

  // Clean up ALL reset tokens for this user
  await prisma.passwordResetToken.deleteMany({
    where: { userId: matchedToken.userId },
  });

  // Revoke every active session — a password reset must log the user out
  // everywhere (mirrors changeMyPassword) — and drop all trusted devices so
  // the next login on any browser goes through MFA again.
  await prisma.refreshToken.deleteMany({ where: { userId: matchedToken.userId } });
  await prisma.trustedDevice.deleteMany({ where: { userId: matchedToken.userId } }).catch(() => {});

  await prisma.auditLog.create({
    data: { action: 'PASSWORD_RESET', performedById: matchedToken.userId, customerId: matchedToken.user.customerId, metadata: { role: matchedToken.user.role } },
  }).catch(() => {});
}
