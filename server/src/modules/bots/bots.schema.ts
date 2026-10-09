import { z } from 'zod';

// Org-admin creates a ticket assigned to a bot. Standard ticket fields + the bot's
// dynamic form values (validated server-side against the bot's field schema).
export const CreateBotTicketSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().min(1).max(10_000),
  projectId: z.string().uuid(),
  type: z.enum(['bug', 'feature', 'task', 'story']).default('task'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  values: z.record(z.unknown()).default({}),
});
