import { z } from 'zod';

// Only USER and ORG_ADMIN are assignable via API — SADMIN / ADMINISTRATOR never are.
const AssignableRole = z.enum(['USER', 'ORG_ADMIN']);

export const UpdateMeSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  mfaEnabled: z.boolean().optional(),
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/,
      'Password must contain uppercase, lowercase, number, and special character',
    ),
});

export const InviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(80),
  role: AssignableRole.default('USER'),
});

export const ChangeRoleSchema = z.object({
  role: AssignableRole,
});

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(200).optional(),
});

export type UpdateMeInput = z.infer<typeof UpdateMeSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
export type InviteUserInput = z.infer<typeof InviteUserSchema>;
export type ChangeRoleInput = z.infer<typeof ChangeRoleSchema>;
export type PaginationInput = z.infer<typeof PaginationSchema>;
