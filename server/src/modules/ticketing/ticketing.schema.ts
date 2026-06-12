import { z } from 'zod';

export const TicketStatusEnum = z.enum(['TODO', 'IN_PROGRESS', 'COMPLETED']);
export const TicketPriorityEnum = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const ListTicketsSchema = z.object({
  status: TicketStatusEnum.optional(),
  projectId: z.string().optional(),
  mine: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
});

export const CreateTicketSchema = z.object({
  subject: z.string().min(5).max(200),
  description: z.string().max(2000).default(''),
  issueType: z.string().min(2).max(80),
  priority: TicketPriorityEnum.default('MEDIUM'),
  projectId: z.string().nullable().optional(),
});

export const UpdateTicketSchema = z.object({
  status: TicketStatusEnum.optional(),
  priority: TicketPriorityEnum.optional(),
  assignee: z.string().max(120).nullable().optional(),
  projectId: z.string().nullable().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

export const CreateProjectSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).default(''),
  category: z.string().min(2).max(40).default('other'),
  priority: TicketPriorityEnum.default('MEDIUM'),
  assignees: z.array(z.string().min(1).max(120)).max(20).default([]),
});

export const ReportSchema = z.object({
  type: z.enum(['status', 'user', 'project', 'issue']).default('issue'),
  from: z.string().optional(),  // ISO date
  to: z.string().optional(),
});

export const AlertsSchema = z.object({
  since: z.string().min(1),
});

export const EscalateSchema = z.object({
  note: z.string().max(1000).optional(),
});
