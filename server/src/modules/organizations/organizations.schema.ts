import { z } from 'zod';

export const UpdateOrgSchema = z.object({
  name: z.string().min(2).max(100).optional(),
});

export const SecuritySettingsSchema = z.object({
  ssoEnabled: z.boolean().optional(),
  mfaRequired: z.boolean().optional(),
});

export type UpdateOrgInput = z.infer<typeof UpdateOrgSchema>;
export type SecuritySettingsInput = z.infer<typeof SecuritySettingsSchema>;
