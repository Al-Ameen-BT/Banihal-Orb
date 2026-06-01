import { z } from 'zod';

export const QueueQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type QueueQuery = z.infer<typeof QueueQuerySchema>;
