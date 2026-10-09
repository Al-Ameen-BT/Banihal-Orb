import { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { prisma } from '../../config/database';
import { JWT_ISSUER } from '../auth/jwtClaims';
import { EXT_AUDIENCE, type ExternalClaims } from './tokens';
import type { ExternalScope } from './external-keys';

// ─── External ticketing API authentication ───────────────────────────────────
// Bearer JWT issued by /api/external/token. Pins algorithm/issuer/audience like
// authMiddleware does; the distinct audience keeps an external token off the
// platform UI surface and vice versa.
//
// The key row is settled against the DATABASE on every request (enabled, expiry,
// scope intersection) so revocation is immediate — a token may outlive its key
// for the JWT's 15 minutes, but the key being disabled blocks use right away.
// The token's own scope list is intersected with the CURRENT key's scopes, so
// scope can only ever shrink between issuance and use, never grow.

const TOUCH_MS = 60_000; // throttle lastUsedAt writes: at most one per key/minute
const lastTouch = new Map<string, number>();

interface SettledKey {
  id: string;
  enabled: boolean;
  expiresAt: Date | null;
  scopes: string[];
}

async function settleKey(clientId: string): Promise<SettledKey | null> {
  const key = await prisma.externalApiKey.findUnique({
    where: { clientId },
    select: { id: true, enabled: true, expiresAt: true, scopes: true },
  });
  if (!key || !key.enabled) return null;
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return null;
  return key as SettledKey;
}

export async function externalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return;
  }

  let claims: ExternalClaims;
  try {
    claims = jwt.verify(header.slice(7), env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: EXT_AUDIENCE,
    }) as ExternalClaims;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
    return;
  }
  if (claims.type !== 'external') {
    res.status(401).json({ error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
    return;
  }

  const key = await settleKey(claims.cid);
  if (!key) {
    res.status(403).json({ error: 'API key is disabled or expired', code: 'KEY_DISABLED' });
    return;
  }
  // Scope is the intersection of what the token was issued with and what the key
  // still holds — the current DB state is the authority for scope too.
  const scopes = (claims.scp ?? []).filter((s) => key.scopes.includes(s as string)) as ExternalScope[];

  req.external = { clientId: claims.cid, keyId: key.id, scopes, store: claims.store, orgs: claims.orgs ?? [] };
  next();

  const now = Date.now();
  const last = lastTouch.get(key.id);
  if (!last || now - last > TOUCH_MS) {
    lastTouch.set(key.id, now);
    prisma.externalApiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
}

export function requireExternalScope(scope: ExternalScope): RequestHandler {
  return (req, res, next) => {
    const granted = req.external?.scopes.includes(scope);
    if (!granted) {
      res.status(403).json({ error: `Scope '${scope}' not granted to this key`, code: 'INSUFFICIENT_SCOPE' });
      return;
    }
    next();
  };
}

// Read anything = tickets.view, OR tickets.write (write implies read: a key that
// can create/edit tickets can certainly read the tickets it touches).
export function requireExternalReadScope(): RequestHandler {
  return (req, res, next) => {
    const granted = req.external?.scopes.some((s) => s === 'tickets.view' || s === 'tickets.write');
    if (!granted) {
      res.status(403).json({ error: "Scope 'tickets.view' not granted to this key", code: 'INSUFFICIENT_SCOPE' });
      return;
    }
    next();
  };
}

/** True when the calling key may act for the given org (default store only). */
export function keyAllowsOrg(req: Request, orgCustomerId: string): boolean {
  if (req.external?.store === 'admin') return true; // admin store: no org axis
  return req.external?.orgs.includes(orgCustomerId) ?? false;
}