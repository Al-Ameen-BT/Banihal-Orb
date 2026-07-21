import { z } from 'zod';

// Shape of a PushSubscription serialized by the browser (PushSubscription.toJSON()).
// The endpoint MUST be an https:// URL (push services are always TLS); userId and
// tenantId are intentionally NOT accepted here — they are derived from the session.
export const SubscribeSchema = z.object({
  endpoint: z.string().url().refine((u) => u.startsWith('https://'), {
    message: 'endpoint must be an https:// URL',
  }),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().max(512).optional(),
});

export const UnsubscribeSchema = z.object({
  endpoint: z.string().url().refine((u) => u.startsWith('https://'), {
    message: 'endpoint must be an https:// URL',
  }),
});

export type SubscribeInput = z.infer<typeof SubscribeSchema>;
export type UnsubscribeInput = z.infer<typeof UnsubscribeSchema>;
