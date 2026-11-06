import { z } from 'zod';

export const StatusEnum = z.enum(['todo', 'in_progress', 'client_pending', 'completed', 'declined']);
export const PriorityEnum = z.enum(['low', 'medium', 'high', 'urgent']);
export const TypeEnum = z.enum(['bug', 'feature', 'task', 'story']);
export const TimeUnitEnum = z.enum(['minutes', 'hours', 'days']);

/**
 * A cleared filter arrives as `?status=` — an EMPTY string, not an absent key.
 * `.optional()` does not accept that: it rejects, the whole request 400s, and the
 * ticket list dies because someone set a dropdown back to "All".
 *
 * Blank means "no filter" in every UI convention, so normalise it to `undefined`
 * BEFORE the enum/uuid check. Applied here rather than at each call site because
 * every filter funnels through this schema — fixing it once covers the filters
 * that do not exist yet.
 *
 * A non-blank but malformed value still fails: `?assigneeId=nonsense` is a real
 * error, and silently ignoring it would show EVERY ticket to someone who asked
 * for one person's queue — wrong data that looks right.
 */
const blank = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

export const ListTicketsSchema = z.object({
  status: blank(StatusEnum),
  priority: blank(PriorityEnum),
  type: blank(TypeEnum),
  projectId: blank(z.string().uuid()),
  assigneeId: blank(z.string().uuid()),
  mine: blank(z.coerce.boolean()),
  escalatedOnly: blank(z.coerce.boolean()),
  search: blank(z.string().max(200)),
});

export const CreateTicketSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().min(1).max(10_000),
  type: TypeEnum.default('task'),
  priority: PriorityEnum.default('medium'),
  status: StatusEnum.default('todo'),
  projectId: z.string().uuid(),
  assigneeId: z.string().uuid().nullable().optional(),
  // ADMINISTRATOR only (stripped for every other role in the controller). `null` means
  // the admin explicitly chose "no client" — distinct from omitting the key, which still
  // falls back to linking the creator's own organization. See ticketing.service.createTicket.
  customerId: z.string().uuid().nullable().optional(),
  // ADMINISTRATOR only. Written onto the SELECTED client's Customers row — the Tickets
  // table has no contactPerson column, so this is per-client, not per-ticket.
  contactPerson: z.string().max(255).nullable().optional(),
  // ADMINISTRATOR only. Same deal as contactPerson: the New Ticket form prefills it from
  // the picked client and writes back whatever the administrator leaves in the field, so a
  // client that had no email on file gets one.
  customerEmail: z.string().email().max(255).nullable().optional(),
  storyPoints: z.number().int().min(0).max(100).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  labels: z.array(z.string().max(60)).max(30).optional(),
  branch: z.string().max(255).nullable().optional(),
  onSiteSupportRequired: z.coerce.boolean().optional(),
  // ORG_ADMIN only: chose the "Banihal Support" (auto-escalation) assignee. The ticket
  // is created unassigned in the org store, then auto-escalated to the platform
  // administrators' store. Enforced server-side in the controller.
  escalateToAdministrators: z.boolean().optional(),

});

// Comments previously read a bare req.body.content with no schema at all. `mentions`
// carries ticket-store user ids chosen from the @ picker — ids rather than parsed
// text, so there is no ambiguity to resolve server-side. They are still validated
// against the roster before anything is sent (see service.addComment).
export const AddCommentSchema = z.object({
  content: z.string().trim().min(1).max(10_000),
  mentions: z.preprocess(
    // multipart sends one repeated field per value, which arrives as a bare string
    // when there is exactly one — normalise before validating.
    (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]),
    z.array(z.string().uuid()).max(10),
  ).optional(),
});
export type AddCommentInput = z.infer<typeof AddCommentSchema>;

export const UpdateTicketSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().min(1).max(10_000).optional(),
  status: StatusEnum.optional(),
  priority: PriorityEnum.optional(),
  type: TypeEnum.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().optional(),
  customerId: z.string().uuid().nullable().optional(),
  storyPoints: z.number().int().min(0).max(100).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  labels: z.array(z.string().max(60)).max(30).optional(),
  branch: z.string().max(255).nullable().optional(),
  onSiteSupportRequired: z.coerce.boolean().optional(),
  reasonForDelay: z.string().max(2000).nullable().optional(),
  resolvedMethods: z.string().max(2000).nullable().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

// Activity Log feed. Every filter goes through blank() for the same reason the
// ticket list does: a cleared dropdown sends `?type=`, and .optional() rejects the
// empty string — which would 400 the whole page because someone chose "All".
export const ActivityFeedSchema = z.object({
  type: blank(z.enum([
    'created', 'updated', 'commented', 'status_changed',
    'priority_changed', 'assigned', 'attachment_added', 'mentioned',
  ])),
  ticketId: blank(z.string().uuid()),
  from: blank(z.coerce.date()),
  to: blank(z.coerce.date()),
  search: blank(z.string().max(200)),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: blank(z.string().uuid()),
});

export const CreateProjectSchema = z.object({
  name: z.string().min(2).max(255),
  description: z.string().max(2000).optional(),
  category: z.string().min(1).max(255).default('general'),
  type: z.enum(['software', 'marketing', 'research', 'other']).default('software'),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  leadId: z.string().uuid().nullable().optional(),
  settings: z.record(z.unknown()).optional(),
  startDate: z.string().datetime().nullable().optional(),
  endDate: z.string().datetime().nullable().optional(),
});

export const UpdateProjectSchema = z.object({
  name: z.string().min(2).max(255).optional(),
  description: z.string().max(2000).optional(),
  status: z.string().max(255).optional(),
  category: z.string().min(1).max(255).optional(),
  type: z.enum(['software', 'marketing', 'research', 'other']).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  leadId: z.string().uuid().optional(),
  settings: z.record(z.unknown()).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

export const CreateSlaSchema = z.object({
  name: z.string().min(2).max(255),
  description: z.string().max(2000).optional(),
  priority: PriorityEnum.nullable().optional(),
  responseTime: z.number().int().min(1),
  resolutionTime: z.number().int().min(1),
  timeUnit: TimeUnitEnum.default('hours'),
  workingDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  businessHours: z.record(z.unknown()).nullable().optional(),
  isActive: z.coerce.boolean().optional(),
});

export const UpdateEscalationSchema = z.object({
  status: z.enum(['TODO', 'IN_PROGRESS', 'COMPLETED']).optional(),
  assignee: z.string().max(120).nullable().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

/**
 * Comma-separated-list filter (the merged client ids). Same cleared/filter contract
 * as blank(): an empty or absent `?customerId=` is "no filter", so it maps to `[]`.
 * Every comma item is validated as a UUID at the end of the pipe, so a malformed
 * value still 400s rather than silently widening the report.
 */
const csvIds = <T extends z.ZodType<string[]>>(schema: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? '' : v ?? ''),
    z.string()
      .transform((s) => (s === '' ? [] : s.split(',').map((p) => p.trim()).filter(Boolean)))
      .pipe(schema),
  );

// Ticket report. The four types are groupings, not different queries — `client` and
// `assignee` group the same rows differently, `overall` doesn't group, and `sla_breach`
// filters to breached-and-open before grouping by client.
//
// Every filter goes through blank(): the report bar sends `?customerId=` when "All
// clients" is chosen, and .uuid().optional() rejects the empty string — which would
// 400 the whole report over a filter the user deliberately cleared.
export const ReportSchema = z.object({
  type: z.enum(['client', 'assignee', 'overall', 'sla_breach']).default('overall'),
  customerId: csvIds(z.array(z.string().uuid()).max(200)),
  assigneeId: blank(z.string().uuid()),
  from: blank(z.coerce.date()),
  to: blank(z.coerce.date()),
});
