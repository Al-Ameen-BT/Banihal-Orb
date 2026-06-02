import { z } from 'zod';

export const ListOrgsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  plan: z.enum(['FREE', 'PRO', 'ENTERPRISE']).optional(),
  suspended: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
});

export const UpdateOrgSchema = z.object({
  plan: z.enum(['FREE', 'PRO', 'ENTERPRISE']).optional(),
  suspended: z.boolean().optional(),
  creditLimit: z.number().int().min(0).optional(),
});

export const ToggleFlagSchema = z.object({
  value: z.boolean(),
  description: z.string().max(200).optional(),
});

export const ListRequestsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ESCALATED']).optional(),
  priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
  type: z.enum(['SUPPORT', 'INCIDENT', 'FEATURE_REQUEST', 'ONBOARDING', 'BILLING']).optional(),
  orgId: z.string().optional(),
});

export const UpdateRequestSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ESCALATED']).optional(),
  priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
  assignedTo: z.string().max(200).optional(),
});

// ─── Customer services (purchased) ──────────────────────────────────────────
export const ListServicesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  status: z.enum(['ACTIVE', 'EXPIRING', 'EXPIRED']).optional(),
  orgId: z.string().optional(),
});

export const UpdateServiceSchema = z.object({
  endDate: z.coerce.date().optional(),
  notes: z.string().max(500).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

export const RenewServiceSchema = z.object({
  months: z.coerce.number().int().min(1).max(60).default(12),
});

export const AssignServiceSchema = z.object({
  serviceId: z.string().min(1),
  endDate: z.coerce.date(),
  purchaseDate: z.coerce.date().optional(),
  notes: z.string().max(500).optional(),
});

// ─── Service catalog (main services → sub-services) ─────────────────────────
export const CreateCatalogSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  parentId: z.string().optional(),
  monthlyPrice: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

export const UpdateCatalogSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).optional(),
  monthlyPrice: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

// ─── Users (SAAS_ADMIN edits any user across orgs) ───────────────────────────
export const UpdateUserSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  email: z.string().email().optional(),
  mfaEnabled: z.boolean().optional(),
  role: z.enum(['USER', 'ORG_ADMIN']).optional(),  // SAAS_ADMIN never assignable
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

export type ListOrgsInput = z.infer<typeof ListOrgsSchema>;
export type UpdateOrgInput = z.infer<typeof UpdateOrgSchema>;
export type ToggleFlagInput = z.infer<typeof ToggleFlagSchema>;
export type ListRequestsInput = z.infer<typeof ListRequestsSchema>;
export type UpdateRequestInput = z.infer<typeof UpdateRequestSchema>;
export type ListServicesInput = z.infer<typeof ListServicesSchema>;
export type UpdateServiceInput = z.infer<typeof UpdateServiceSchema>;
export type RenewServiceInput = z.infer<typeof RenewServiceSchema>;
export type AssignServiceInput = z.infer<typeof AssignServiceSchema>;
export type CreateCatalogInput = z.infer<typeof CreateCatalogSchema>;
export type UpdateCatalogInput = z.infer<typeof UpdateCatalogSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
