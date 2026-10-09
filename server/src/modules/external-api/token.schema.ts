import { z } from 'zod';

// OAuth-ish token request. Machine callers send either form-encoded or JSON —
// both are accepted (see external.routes.ts mounting express.urlencoded).

export const CLIENT_ID = /^ext_ck_[a-f0-9]+$/;
export const CLIENT_SECRET = /^ext_sk_[A-Za-z0-9_-]+$/;
export const REFRESH_TOKEN = /^ext_rt_[A-Za-z0-9_-]+$/;

export const TokenRequestSchema = z.object({
  grant_type: z.enum(['client_credentials', 'refresh_token']),
  client_id: z.string().regex(CLIENT_ID).optional(),
  client_secret: z.string().regex(CLIENT_SECRET).optional(),
  refresh_token: z.string().regex(REFRESH_TOKEN).optional(),
  // OAuth convention: space-separated scope list, used only to NARROW the key's
  // scopes for this token (a client cannot grant itself more than it has).
  scope: z.string().max(200).optional(),
});