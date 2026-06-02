import { z } from 'zod';

export const RegisterSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z
    .string()
    .min(12)
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/,
      'Password must contain uppercase, lowercase, number, and special character',
    ),
  organizationName: z.string().min(2).max(100),
  contactNumber: z.string().min(7, 'Contact number is required').max(20),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const UpdateMeSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  mfaEnabled: z.boolean().optional(),
});

export const InviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(80),
  role: z.enum(['USER', 'ORG_ADMIN']),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type UpdateMeInput = z.infer<typeof UpdateMeSchema>;
export type InviteUserInput = z.infer<typeof InviteUserSchema>;

// ─── 3-tier RBAC: USER → ORG_ADMIN → SAAS_ADMIN ─────────────────────────────
export type Role = 'USER' | 'ORG_ADMIN' | 'SAAS_ADMIN';
export type Plan = 'FREE' | 'PRO' | 'ENTERPRISE';
export type ServiceStatus = 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'SUSPENDED';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  mfaEnabled: boolean;
  customerId: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Customer {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  suspended: boolean;
  ssoEnabled: boolean;
  mfaRequired: boolean;
  creditLimit: number;
  mailId: string;
  contactPerson: string;
  contactNumber: string;
  domain: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationService {
  id: string;
  name: string;
  description: string | null;
  status: ServiceStatus;
  enabled: boolean;
  monthlyPrice: number;
  purchasedAt: string;
  renewsAt: string;
  lastBilledAt: string | null;
}

// ─── Service catalog (main services → sub-services) ─────────────────────────
export interface CatalogService {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  active: boolean;
  monthlyPrice: number;
  _count?: { purchases: number };
}

export interface CatalogMain extends CatalogService {
  children: CatalogService[];
}
