import { z } from 'zod';
import { EXTERNAL_SCOPES, EXTERNAL_STORES, type ExternalScope, type ExternalStore } from './external-keys';
import { EXTERNAL_WEBHOOK_EVENTS, type ExternalWebhookEvent } from './external-webhooks';

const Scope = z.enum([...EXTERNAL_SCOPES] as [ExternalScope, ...ExternalScope[]]);
const Store = z.enum([...EXTERNAL_STORES] as [ExternalStore, ...ExternalStore[]]);
const WebhookEvent = z.enum([...EXTERNAL_WEBHOOK_EVENTS] as [ExternalWebhookEvent, ...ExternalWebhookEvent[]]);

export const CreateExternalKeySchema = z.object({
  name: z.string().min(2).max(80),
  scopes: z.array(Scope).min(1),
  ticketStore: Store,
  customerIds: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const CreateExternalWebhookSchema = z.object({
  url: z.string().max(500),
  events: z.array(WebhookEvent).min(1),
});