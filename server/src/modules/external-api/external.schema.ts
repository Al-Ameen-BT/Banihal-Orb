import { z } from 'zod';
import { PriorityEnum, StatusEnum, TypeEnum } from '../ticketing/ticketing.schema';

// Query/list filters. A cleared filter arrives as an EMPTY string, so normalize
// it away before the enum/uuid check (same convention as ListTicketsSchema).
const blank = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

export const ExternalListTicketsSchema = z.object({
  status: blank(StatusEnum),
  priority: blank(PriorityEnum),
  type: blank(TypeEnum),
  projectId: blank(z.string().uuid()),
  assigneeId: blank(z.string().uuid()),
  search: blank(z.string().max(200)),
}).strict();

export const ExternalSearchSchema = z.object({ q: z.string().trim().min(1).max(200) }).strict();

export const ExternalCommentSchema = z.object({ content: z.string().trim().min(1).max(10_000) }).strict();

// `.strict()`: a typo'd field is a programmer error the caller should see as a
// 400 immediately, not an ignored payload.
export const ExternalCreateTicketSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().min(1).max(10_000),
  type: TypeEnum.default('task'),
  priority: PriorityEnum.default('medium'),
  status: StatusEnum.default('todo'),
  projectId: z.string().uuid(),
  // The machine persona — a ticket-store user id that becomes both reporter and
  // assignee and posts this key's later comments. Required: no phantom reporters.
  assigneeId: z.string().uuid(),
  // Default store only: the org (main-DB customerId — a cuid, not a uuid) this
  // ticket belongs to. Must be one of the key's allowedIds — the cross-tenant
  // check lives in the service.
  orgCustomerId: z.string().min(1).max(60).optional(),
  // Default store only — orgCustomerId is REQUIRED there; this is admin-store only.
  customerId: z.string().uuid().nullable().optional(),
  storyPoints: z.number().int().min(0).max(100).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  labels: z.array(z.string().max(60)).max(30).optional(),
  branch: z.string().max(255).nullable().optional(),
  onSiteSupportRequired: z.coerce.boolean().optional(),
}).strict();

export type ExternalCreateTicketInput = z.infer<typeof ExternalCreateTicketSchema>;

export const ExternalUpdateTicketSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().min(1).max(10_000).optional(),
  status: StatusEnum.optional(),
  priority: PriorityEnum.optional(),
  type: TypeEnum.optional(),
  assigneeId: z.string().uuid().optional(),
  storyPoints: z.number().int().min(0).max(100).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  labels: z.array(z.string().max(60)).max(30).optional(),
  branch: z.string().max(255).nullable().optional(),
  onSiteSupportRequired: z.coerce.boolean().optional(),
}).strict();

export type ExternalUpdateTicketInput = z.infer<typeof ExternalUpdateTicketSchema>;