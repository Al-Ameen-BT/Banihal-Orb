import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../../config/database';
import { audit } from '../../lib/audit';
import { assertPasswordNotReused, passwordFingerprint } from '../auth/passwordReuse';
import { chatPrisma } from '../../config/chatDatabase';
import { permissionsFor } from '../platform-roles/platformRoles.service';
import { sendInviteEmail } from '../mail/mail.service';
import type { UpdateMeInput, InviteUserInput, ChangeRoleInput, PaginationInput, ChangePasswordInput } from './users.schema';

const userSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  mfaEnabled: true,
  lastLoginAt: true,
  createdAt: true,
  customerId: true,
  emailVerifiedAt: true,
  platformRole: { select: { key: true, name: true } },
  // The org's enforcement flag travels WITH the user's own. Login decides with
  // `mfaEnabled || customer.mfaRequired`; every display read only the first half,
  // so a user their org already forces through MFA showed as unprotected.
  customer: { select: { mfaRequired: true } },
  // passwordHash intentionally omitted
} as const;

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...userSelect, platformRoleId: true },
  });
  if (!user) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });

  // The client gates nav and controls on these. Expanded server-side, so
  // `administration` arrives as the full key list and the browser needs no
  // special case. Empty for customer accounts — the client's can() is a UX
  // affordance; every route is independently enforced server-side.
  const { platformRoleId, ...rest } = user;
  const permissions = user.role === 'ADMINISTRATOR' ? [...(await permissionsFor(platformRoleId))] : [];
  return { ...rest, permissions };
}

/**
 * Turning MFA OFF is refused while the organization requires it. Enabling is
 * always allowed.
 *
 * Without this the toggle was a lie in both directions: the write succeeded, so
 * the UI showed MFA off, while `initiateLogin` still challenged the user on every
 * untrusted device because it reads `mfaEnabled || customer.mfaRequired`.
 */
async function assertMayDisableMfa(userId: string): Promise<void> {
  const row = await prisma.user.findUnique({
    where: { id: userId }, select: { customer: { select: { mfaRequired: true } } },
  });
  if (row?.customer?.mfaRequired) {
    throw Object.assign(
      new Error('Your organization requires two-factor authentication, so it cannot be turned off.'),
      { status: 400, code: 'MFA_REQUIRED_BY_ORG' },
    );
  }
}

export async function updateMe(userId: string, input: UpdateMeInput) {
  if (input.mfaEnabled === false) await assertMayDisableMfa(userId);
  const updated = await prisma.user.update({ where: { id: userId }, data: input, select: userSelect });
  await audit({
    action: 'USER_PROFILE_UPDATED', performedById: userId, targetId: userId,
    customerId: updated.customerId, metadata: { changes: input },
  });
  return updated;
}

export async function changeMyPassword(userId: string, input: ChangePasswordInput) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true, customerId: true } });
  if (!user) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });

  const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
  if (!valid) throw Object.assign(new Error('Current password is incorrect'), { status: 400, code: 'INVALID_PASSWORD' });

  // Block a password that another account already uses (self excluded).
  await assertPasswordNotReused(input.newPassword, userId);
  const newHash = await bcrypt.hash(input.newPassword, 12);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newHash, passwordFingerprint: passwordFingerprint(input.newPassword) },
  });
  // Revoke all refresh tokens so other sessions are logged out, and drop trusted
  // devices so every browser goes back through MFA on its next login.
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.trustedDevice.deleteMany({ where: { userId } }).catch(() => {});

  // THAT it changed, never the value. Admin-forced resets were logged while
  // self-service changes were not, so a stolen session could rotate the password
  // and leave nothing behind but a LOGIN.
  await audit({
    action: 'PASSWORD_CHANGED', performedById: userId, targetId: userId, customerId: user.customerId,
  });
}

export async function listUsers(input: PaginationInput) {
  const skip = (input.page - 1) * input.limit;

  const where = input.search
    ? { OR: [{ name: { contains: input.search, mode: 'insensitive' as const } }, { email: { contains: input.search, mode: 'insensitive' as const } }] }
    : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({ where, skip, take: input.limit, select: userSelect, orderBy: { createdAt: 'desc' } }),
    prisma.user.count({ where }),
  ]);

  return { users, total, page: input.page, limit: input.limit, pages: Math.ceil(total / input.limit) };
}

export async function inviteUser(input: InviteUserInput, customerId: string, actorId: string) {
  // 16 random bytes is far past anything a human types, so this is only ever
  // usable via the invitation email below — which is the whole point: before it
  // existed the password was generated, hashed and DISCARDED, leaving an account
  // nobody could ever sign in to while the UI reported "Invitation sent".
  const tempPassword = crypto.randomBytes(16).toString('hex') + 'A1!';
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash,
      // Random temp password — no reuse check needed (collision is negligible), but record
      // the fingerprint so the account is covered by the reuse report from day one.
      passwordFingerprint: passwordFingerprint(tempPassword),
      // Pre-verified: an administrator chose this address and the temporary
      // password is emailed to it, so the invite already proves delivery. Leaving
      // it null would gate every invited user out of login.
      emailVerifiedAt: new Date(),
      customerId,
    },
    select: userSelect,
  });

  // Read OUTSIDE the tenant extension's reach is unnecessary here — Customer is a
  // global model, and this is the invitee's own org either way.
  // Account creation on the org side was invisible, while the platform-side
  // equivalent logged ADMINISTRATOR_STAFF_INVITED. Never the temp password.
  await audit({
    action: 'USER_INVITED', performedById: actorId, targetId: user.id, customerId,
    metadata: { targetEmail: user.email, targetName: user.name, role: input.role },
  });

  const org = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true } });
  const delivered = await sendInviteEmail(user.email, {
    name: user.name,
    tempPassword,
    roleLabel: input.role === 'ORG_ADMIN' ? 'Organization Admin' : 'User',
    orgName: org?.name ?? 'your organization',
  });

  // Surface the password ONLY when the mail failed, so a misconfigured SMTP host
  // degrades to "hand it over yourself" instead of a silently unusable account.
  return {
    user,
    delivered,
    ...(delivered ? {} : { tempPassword }),
    message: delivered
      ? `Invitation sent to ${user.email}.`
      : 'Email could not be sent. Communicate this temporary password securely.',
  };
}

export async function changeRole(targetUserId: string, input: ChangeRoleInput, actorId: string) {
  // ADMINISTRATOR role is NEVER settable through this path
  if ((input.role as string) === 'ADMINISTRATOR') {
    throw Object.assign(new Error('ADMINISTRATOR role cannot be assigned via API'), { status: 403, code: 'FORBIDDEN' });
  }
  const before = await prisma.user.findUnique({
    where: { id: targetUserId }, select: { customerId: true, email: true, role: true },
  });
  if (!before) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });

  const updated = await prisma.user.update({ where: { id: targetUserId }, data: { role: input.role }, select: userSelect });
  // USER ↔ ORG_ADMIN is a privilege change and wrote nothing before — while the
  // platform-side equivalent (saas-admin.updateUser) logged previousRole.
  await audit({
    action: 'USER_ROLE_CHANGED', performedById: actorId, targetId: targetUserId, customerId: before.customerId,
    metadata: { targetEmail: before.email, previousRole: before.role, newRole: input.role },
  });
  return updated;
}

export async function removeUser(targetUserId: string, requestingUserId: string) {
  if (targetUserId === requestingUserId) {
    throw Object.assign(new Error('Cannot remove yourself'), { status: 400, code: 'SELF_REMOVE' });
  }

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, customerId: true, email: true, name: true, role: true }
  });

  if (target) {
    await prisma.auditLog.create({
      data: {
        action: 'USER_REMOVED',
        performedById: requestingUserId,
        targetId: targetUserId,
        customerId: target.customerId,
        metadata: { targetEmail: target.email, targetName: target.name, targetRole: target.role }
      }
    });
  }

  await prisma.user.delete({ where: { id: targetUserId } });
  // Chat history lives in the dedicated chat DB — no cross-database cascade,
  // so clean it up explicitly (messages cascade from sessions within that DB).
  await chatPrisma.chatSession.deleteMany({ where: { userId: targetUserId } }).catch(() => {});
}
