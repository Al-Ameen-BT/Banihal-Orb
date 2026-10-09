import { z } from 'zod';

export const CreateRequestSchema = z.object({
  subject: z.string().min(5, 'Subject must be at least 5 characters').max(200),
  type: z.enum(['SUPPORT', 'INCIDENT', 'FEATURE_REQUEST', 'ONBOARDING', 'BILLING']).default('SUPPORT'),
  priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
  service: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).optional(),
});

export const ListMyRequestsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ESCALATED']).optional(),
});

// Org-admin view: all tickets raised by users across the organization.
export const ListOrgRequestsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ESCALATED']).optional(),
  priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
  type: z.enum(['SUPPORT', 'INCIDENT', 'FEATURE_REQUEST', 'ONBOARDING', 'BILLING']).optional(),
});

export type CreateRequestInput = z.infer<typeof CreateRequestSchema>;
export type ListMyRequestsInput = z.infer<typeof ListMyRequestsSchema>;
export type ListOrgRequestsInput = z.infer<typeof ListOrgRequestsSchema>;
