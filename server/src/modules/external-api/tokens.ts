import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../../config/env';
import { JWT_ISSUER } from '../auth/jwtClaims';
import { redis } from '../../lib/redis';
import { hashApiKey } from '../../config/slackCrypto';
import type { ExternalScope, ExternalStore } from './external-keys';

// ─── External ticketing API tokens ───────────────────────────────────────────
// Access tokens are 15-minute JWTs, HS256 under JWT_ACCESS_SECRET. The audience
// differs from the platform client's ('b2b-saas-external' vs 'b2b-saas-client'),
// so a token minted for one surface can never authenticate on the other even
// though they share a signing key — the same separation jwtClaims.ts documents.
//
// Refresh tokens are NOT JWTs: 32 CSPRNG bytes, stored only as a SHA-256 hash in
// Redis with a 30-day TTL, rotated (delete-then-set) on every use. Every
// redemption re-validates the key against the database (enabled + expiry), so a
// revoked key's refresh tokens die at the next attempt even before its access
// JWT expires.

export const EXT_AUDIENCE = 'b2b-saas-external';
export const EXT_ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface ExternalClaims {
  type: 'external';
  cid: string; // clientId
  kid: string; // key row id
  scp: ExternalScope[];
  store: ExternalStore;
  orgs: string[];
}

export function issueAccessToken(claims: ExternalClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    expiresIn: EXT_ACCESS_TTL_SECONDS,
    algorithm: 'HS256',
    issuer: JWT_ISSUER,
    audience: EXT_AUDIENCE,
  });
}

function refreshStore(): NonNullable<typeof redis> {
  const client = redis;
  if (!client) {
    throw Object.assign(new Error('Refresh tokens are unavailable (Redis not configured)'), { status: 503, code: 'REFRESH_UNAVAILABLE' });
  }
  return client;
}

/** Mint a new refresh token bound to a clientId, or null when Redis is
 *  unavailable — the client_credentials grant still succeeds, the client just
 *  re-authenticates with its key instead (Redis is not a source of truth). */
export async function storeRefresh(clientId: string): Promise<string | null> {
  if (!redis) return null;
  const raw = `ext_rt_${crypto.randomBytes(32).toString('base64url')}`;
  try {
    await refreshStore().set(`ext:refresh:${hashApiKey(raw)}`, JSON.stringify({ clientId }), 'EX', REFRESH_TTL_SECONDS);
    return raw;
  } catch {
    return null;
  }
}

/**
 * Redeem a refresh token — single-use: consumed on read, and the caller mints
 * the replacement (rotation). Returns the bound clientId, or null when the
 * token is unknown/expired/revoked.
 */
export async function redeemRefresh(raw: string): Promise<string | null> {
  const hash = hashApiKey(raw);
  const val = await refreshStore().get(`ext:refresh:${hash}`);
  if (!val) return null;
  await refreshStore().del(`ext:refresh:${hash}`);
  return (JSON.parse(val) as { clientId?: string }).clientId ?? null;
}