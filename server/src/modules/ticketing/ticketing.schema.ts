import { z } from 'zod';

export const StatusEnum = z.enum(['todo', 'in_progress', 'client_pending', 'completed']);
export const PriorityEnum = z.enum(['low', 'medium', 'high', 'urgent']);
export const TypeEnum = z.enum(['bug', 'feature', 'task', 'story']);
export const TimeUnitEnum = z.enum(['minutes', 'hours', 'days']);

export const ListTicketsSchema = z.object({
  status: StatusEnum.optional(),
  priority: PriorityEnum.optional(),
  type: TypeEnum.optional(),
  projectId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  mine: z.coerce.boolean().optional(),
  escalatedOnly: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
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
  // ORG_ADMIN only: chose "Escalate to Administrators" as the assignee. The ticket
  // is created unassigned in the org store, then auto-escalated to the platform
  // administrators' store. Enforced server-side in the controller.
  escalateToAdministrators: z.boolean().optional(),
});

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

export const ReportSchema = z.object({
  type: z.enum(['status', 'priority', 'type', 'project', 'assignee']).default('status'),
  from: z.string().optional(),
  to: z.string().optional(),
});
