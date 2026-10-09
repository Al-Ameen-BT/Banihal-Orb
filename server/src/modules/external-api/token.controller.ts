import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/database';
import { TokenRequestSchema } from './token.schema';
import { verifySecret } from './external-keys';
import { issueAccessToken, storeRefresh, redeemRefresh, EXT_ACCESS_TTL_SECONDS } from './tokens';
import type { ExternalScope, ExternalStore } from './external-keys';

// ─── POST /api/external/token ────────────────────────────────────────────────
// client_credentials: client_id + client_secret → access JWT + refresh token.
// refresh_token:      single-use refresh → rotated pair (Redis-backed).
// OAuth-style error payloads so the client error shapes read like the rest of
// the spec; anything unexpected goes to the shared error handler.

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

async function loadKey(clientId: string) {
  const key = await prisma.externalApiKey.findUnique({
    where: { clientId },
    select: {
      id: true, secretHash: true, enabled: true, expiresAt: true,
      scopes: true, ticketStore: true, customerIds: true, clientId: true,
    },
  });
  return key;
}

async function grantClientCredentials(body: z.infer<typeof TokenRequestSchema>, res: Response): Promise<void> {
  const { client_id, client_secret, scope } = body;
  if (!client_id || !client_secret) {
    return oauthError(res, 400, 'invalid_request', 'client_id and client_secret are required for client_credentials');
  }
  const key = await loadKey(client_id);
  if (!key || !key.enabled || !verifySecret(key, client_secret) || (key.expiresAt && key.expiresAt.getTime() < Date.now())) {
    return oauthError(res, 401, 'invalid_client', 'Unknown client or bad credentials');
  }

  let scopes = key.scopes as ExternalScope[];
  if (scope) {
    const wanted = scope.split(' ').filter(Boolean) as ExternalScope[];
    if (!wanted.every((s) => scopes.includes(s))) {
      return oauthError(res, 400, 'invalid_scope', 'Requested scope exceeds what the key holds');
    }
    scopes = wanted;
  }

  const store = key.ticketStore as ExternalStore;
  const orgs = key.customerIds as string[];
  const accessToken = issueAccessToken({ type: 'external', cid: key.clientId, kid: key.id, scp: scopes, store, orgs });
  const refreshToken = await storeRefresh(key.clientId); // null when Redis is down
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: EXT_ACCESS_TTL_SECONDS,
    scope: scopes.join(' '),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  });
}

async function grantRefresh(body: z.infer<typeof TokenRequestSchema>, res: Response): Promise<void> {
  if (!body.refresh_token) {
    return oauthError(res, 400, 'invalid_request', 'refresh_token is required for grant_type=refresh_token');
  }
  const clientId = await redeemRefresh(body.refresh_token);
  if (!clientId) {
    return oauthError(res, 400, 'invalid_grant', 'Refresh token is unknown, expired or already used');
  }
  const key = await loadKey(clientId);
  if (!key || !key.enabled || (key.expiresAt && key.expiresAt.getTime() < Date.now())) {
    return oauthError(res, 400, 'invalid_grant', 'The associated API key is disabled or expired');
  }

  let scopes = key.scopes as ExternalScope[];
  if (body.scope) {
    const wanted = body.scope.split(' ').filter(Boolean) as ExternalScope[];
    if (!wanted.every((s) => scopes.includes(s))) {
      return oauthError(res, 400, 'invalid_scope', 'Requested scope exceeds what the key holds');
    }
    scopes = wanted;
  }

  const store = key.ticketStore as ExternalStore;
  const orgs = key.customerIds as string[];
  const accessToken = issueAccessToken({ type: 'external', cid: key.clientId, kid: key.id, scp: scopes, store, orgs });
  const refreshToken = await storeRefresh(key.clientId); // rotation: new token for the consumed one
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: EXT_ACCESS_TTL_SECONDS,
    scope: scopes.join(' '),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  });
}

export async function token(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = TokenRequestSchema.parse(req.body);
    if (body.grant_type === 'client_credentials') return grantClientCredentials(body, res);
    if (body.grant_type === 'refresh_token') return grantRefresh(body, res);
    return oauthError(res, 400, 'unsupported_grant_type', 'Supported: client_credentials, refresh_token');
  } catch (err) {
    next(err);
  }
}