import { z } from 'zod';

export const BOT_FIELD_TYPES = ['TEXT', 'TEXTAREA', 'NUMBER', 'SELECT', 'CHECKBOX', 'USER_EMAIL'] as const;

// Slack Incoming Webhook — posts ticket notifications into the bot's channel.
const WebhookUrl = z.string().url().max(500).refine(
  (u) => u.startsWith('https://hooks.slack.com/'),
  'Must be a Slack incoming webhook URL (https://hooks.slack.com/…)',
);

export const CreateBotSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).nullable().optional(),
  botToken: z.string().min(10).max(500),
  appToken: z.string().min(10).max(500).nullable().optional(),
  webhookUrl: WebhookUrl.nullable().optional(),
});

export const UpdateBotSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  botToken: z.string().min(10).max(500).optional(),
  appToken: z.string().min(10).max(500).nullable().optional(), // null clears the app token
  webhookUrl: WebhookUrl.nullable().optional(),                // null clears the webhook
  enabled: z.boolean().optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

export const FieldSchema = z.object({
  key: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/, 'lowercase letters, numbers, underscore'),
  label: z.string().min(1).max(120),
  type: z.enum(BOT_FIELD_TYPES).default('TEXT'),
  required: z.coerce.boolean().optional(),
  options: z.array(z.string().max(120)).max(40).nullable().optional(),
  placeholder: z.string().max(160).nullable().optional(),
  helpText: z.string().max(300).nullable().optional(),
  order: z.number().int().min(0).optional(),
});

export const UpdateFieldSchema = FieldSchema.partial().refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

export const AssignOrgSchema = z.object({ customerId: z.string().min(1) });
