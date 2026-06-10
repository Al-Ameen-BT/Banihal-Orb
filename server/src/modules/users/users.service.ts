import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../../config/database';
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
  // passwordHash intentionally omitted
} as const;

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: userSelect });
  if (!user) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
  return user;
}

export async function updateMe(userId: string, input: UpdateMeInput) {
  return prisma.user.update({ where: { id: userId }, data: input, select: userSelect });
}

export async function changeMyPassword(userId: string, input: ChangePasswordInput) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user) throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });

  const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
  if (!valid) throw Object.assign(new Error('Current password is incorrect'), { status: 400, code: 'INVALID_PASSWORD' });

  const newHash = await bcrypt.hash(input.newPassword, 12);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: newHash } });
  // Revoke all refresh tokens so other sessions are logged out
  await prisma.refreshToken.deleteMany({ where: { userId } });
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
}
