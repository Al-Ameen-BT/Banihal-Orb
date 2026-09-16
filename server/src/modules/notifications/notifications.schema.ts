import { z } from 'zod';

export const ListNotificationsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  // Cursor: return notifications older than this ISO timestamp.
  before: z.string().datetime().optional(),
});
