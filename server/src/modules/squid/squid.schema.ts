import { z } from 'zod';
import { BRANCH_NAME_RE } from './aclEngine';

// ─── Org-facing squid proxy management (tenant-scoped) ──────────────────────
const TimeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

export const SiteEntrySchema = z.object({
  value: z.string().trim().min(1).max(255),
  subdomain: z.boolean().default(false),
});

export const AccessWindowSchema = z.object({
  days: z.array(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])).min(1).max(7),
  from: z.string().regex(TimeRe, 'from must be HH:MM (24h)'),
  to: z.string().regex(TimeRe, 'to must be HH:MM (24h)'),
}).refine((w) => w.from < w.to, { message: 'from must be before to', path: ['to'] });

export const FullAccessSchema = z.object({
  src: z.string().trim().min(1).max(64),
  description: z.string().trim().max(200).optional(),
  until: z.string().datetime({ offset: true }).optional(), // ISO — temporary access expires
  window: AccessWindowSchema.optional(),
});

export const CreateProxySchema = z.object({
  name: z.string().regex(BRANCH_NAME_RE, 'Names: 2-32 chars, letters/digits/_/- only'),
  description: z.string().trim().max(500).optional(),
  transport: z.enum(['agent']).default('agent'),
});

export const UpdateProxySchema = z.object({
  name: z.string().regex(BRANCH_NAME_RE, 'Names: 2-32 chars, letters/digits/_/- only').optional(),
  description: z.string().trim().max(500).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

export const ListProxiesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const CreateBranchSchema = z.object({
  name: z.string().regex(BRANCH_NAME_RE, 'Names: 2-32 chars, letters/digits/_/- only'),
  description: z.string().trim().max(500).optional(),
  mode: z.enum(['ADDITIVE', 'EXCLUSIVE']).default('ADDITIVE'),
});

export const UpdateBranchSchema = z.object({
  name: z.string().regex(BRANCH_NAME_RE, 'Names: 2-32 chars, letters/digits/_/- only').optional(),
  description: z.string().trim().max(500).nullable().optional(),
  mode: z.enum(['ADDITIVE', 'EXCLUSIVE']).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

// The traffic-heavy edits. Distinct endpoints so the client posts one concern at
// a time (and each bumps seq exactly once, giving auditors a precise diff).
export const SetBranchListsSchema = z.object({
  sources: z.array(z.string().trim().min(1).max(64)).max(100).default([]),
  whitelist: z.array(SiteEntrySchema).max(2000).default([]),
  blacklist: z.array(SiteEntrySchema).max(2000).default([]),
});

export const SetPortsSchema = z.object({
  safePorts: z.array(z.string().trim().min(1).max(16)).max(64).default([]),
  sslPorts: z.array(z.string().trim().min(1).max(16)).max(64).default([]),
});

export const SetFullAccessSchema = z.object({
  fullAccess: z.array(FullAccessSchema).max(500).default([]),
});

export const AgentResultSchema = z.object({
  seq: z.coerce.number().int().min(0),
  ok: z.boolean(),
  error: z.string().trim().max(500).optional(),
});

export type CreateProxyInput = z.infer<typeof CreateProxySchema>;
export type UpdateProxyInput = z.infer<typeof UpdateProxySchema>;
export type ListProxiesInput = z.infer<typeof ListProxiesSchema>;
export type CreateBranchInput = z.infer<typeof CreateBranchSchema>;
export type UpdateBranchInput = z.infer<typeof UpdateBranchSchema>;
export type SetBranchListsInput = z.infer<typeof SetBranchListsSchema>;
export type SetPortsInput = z.infer<typeof SetPortsSchema>;
export type SetFullAccessInput = z.infer<typeof SetFullAccessSchema>;
export type AgentResultInput = z.infer<typeof AgentResultSchema>;