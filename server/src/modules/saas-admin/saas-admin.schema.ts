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
  // Short code embedded in ticket numbers (ADMINISTRATOR-controlled). Uppercased.
  orgCode: z.string().trim().regex(/^[A-Za-z0-9]{1,8}$/, 'Org code must be 1–8 letters or numbers')
    .transform((s) => s.toUpperCase()).optional(),
});

// Global ticket-number format (ADMINISTRATOR-only).
export const TicketNumberFormatSchema = z.object({
  prefix: z.string().trim().regex(/^[A-Za-z0-9]{1,8}$/, 'Prefix must be 1–8 letters or numbers').transform((s) => s.toUpperCase()),
  includeOrgCode: z.boolean(),
  separator: z.enum(['-', '_', '/', '.', '']),
  padWidth: z.number().int().min(1).max(8),
});
export type TicketNumberFormatInput = z.infer<typeof TicketNumberFormatSchema>;

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
  assignedTo: z.string().max(200).nullable().optional(),
  // Platform-admin working notes; stripped from all org-facing responses.
  internalNotes: z.string().max(4000).nullable().optional(),
});

// ─── Announcements (platform broadcasts) ─────────────────────────────────────
export const CreateAnnouncementSchema = z.object({
  title: z.string().min(3).max(120),
  message: z.string().min(3).max(1000),
  level: z.enum(['INFO', 'WARNING', 'CRITICAL']).default('INFO'),
  customerId: z.string().nullable().optional(), // null / omitted = all organizations
  expiresAt: z.coerce.date().nullable().optional(),
});

// ─── Ticket escalations (forwarded by org admins) ────────────────────────────
export const ListEscalationsSchema = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).optional(),
  since: z.coerce.date().optional(),   // createdAt > since (notification polling)
});

export const UpdateEscalationSchema = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']),
});

export const UpdateAnnouncementSchema = z.object({
  title: z.string().min(3).max(120).optional(),
  message: z.string().min(3).max(1000).optional(),
  level: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
  active: z.boolean().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

// ─── Customer services (purchased) ──────────────────────────────────────────
export const ListServicesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  status: z.enum(['ACTIVE', 'EXPIRING', 'EXPIRED']).optional(),
  orgId: z.string().optional(),
});

export const UpdateServiceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  monthlyPrice: z.number().int().min(0).optional(),
  endDate: z.coerce.date().optional(),
  notes: z.string().max(500).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

export const RenewServiceSchema = z.object({
  months: z.coerce.number().int().min(1).max(60).default(12),
});

// Add a service to a customer (each org defines its own services).
export const AssignServiceSchema = z.object({
  name: z.string().min(1).max(120),
  monthlyPrice: z.coerce.number().int().min(0).default(0),
  endDate: z.coerce.date(),
  description: z.string().max(500).optional(),
  purchaseDate: z.coerce.date().optional(),
  notes: z.string().max(500).optional(),
});

// ─── Service catalog (platform-level master list) ───────────────────────────
export const CreateCatalogServiceSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  category: z.string().max(80).optional(),
  basePrice: z.coerce.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
});

export const UpdateCatalogServiceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  category: z.string().max(80).optional(),
  basePrice: z.coerce.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

// ─── System-wide activity log (ADMINISTRATOR audit console) ─────────────────
export const SystemActivitySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().max(60).optional(),                          // exact action match; '*' = all actions
  role: z.enum(['USER', 'ORG_ADMIN', 'ADMINISTRATOR']).optional(), // performer's role
  orgId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// ─── Logins-by-organization summary (ADMINISTRATOR login monitoring) ────────
// Groups successful LOGIN events per org over an optional date window. `role`
// narrows to a single actor role (e.g. only ORG_ADMIN logins).
export const LoginsByOrgSchema = z.object({
  role: z.enum(['USER', 'ORG_ADMIN', 'ADMINISTRATOR']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// ─── Users (ADMINISTRATOR edits org users / admins) ─────────────────────────
export const UpdateUserSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  email: z.string().email().optional(),
  mfaEnabled: z.boolean().optional(),
  role: z.enum(['USER', 'ORG_ADMIN']).optional(),  // ADMINISTRATOR never assignable via this schema
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
export type CreateCatalogServiceInput = z.infer<typeof CreateCatalogServiceSchema>;
export type UpdateCatalogServiceInput = z.infer<typeof UpdateCatalogServiceSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
export type SystemActivityInput = z.infer<typeof SystemActivitySchema>;
export type LoginsByOrgInput = z.infer<typeof LoginsByOrgSchema>;
export type CreateAnnouncementInput = z.infer<typeof CreateAnnouncementSchema>;
export type UpdateAnnouncementInput = z.infer<typeof UpdateAnnouncementSchema>;
export type ListEscalationsInput = z.infer<typeof ListEscalationsSchema>;
export type UpdateEscalationInput = z.infer<typeof UpdateEscalationSchema>;
