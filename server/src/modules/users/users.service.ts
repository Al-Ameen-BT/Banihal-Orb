import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../../config/database';
import { assertPasswordNotReused, passwordFingerprint } from '../auth/passwordReuse';
import { chatPrisma } from '../../config/chatDatabase';
import { permissionsFor } from '../platform-roles/platformRoles.service';
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

export async function updateMe(userId: string, input: UpdateMeInput) {
  return prisma.user.update({ where: { id: userId }, data: input, select: userSelect });
}

export async function changeMyPassword(userId: string, input: ChangePasswordInput) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
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

export async function inviteUser(input: InviteUserInput, customerId: string) {
  const tempPassword = crypto.randomBytes(16).toString('hex') + 'A1!';
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  return prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash,
      // Random temp password — no reuse check needed (collision is negligible), but record
      // the fingerprint so the account is covered by the reuse report from day one.
      passwordFingerprint: passwordFingerprint(tempPassword),
      customerId,
    },
    select: userSelect,
  });
}

export async function changeRole(targetUserId: string, input: ChangeRoleInput) {
  // ADMINISTRATOR role is NEVER settable through this path
  if ((input.role as string) === 'ADMINISTRATOR') {
    throw Object.assign(new Error('ADMINISTRATOR role cannot be assigned via API'), { status: 403, code: 'FORBIDDEN' });
  }
  return prisma.user.update({ where: { id: targetUserId }, data: { role: input.role }, select: userSelect });
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
