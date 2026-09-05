import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../config/database';
import { permissionsFor } from '../modules/platform-roles/platformRoles.service';

interface AccessTokenPayload {
  userId: string;
  customerId: string;
  role: Role;
  /** Platform-staff role id; absent on customer tokens and on tokens minted
   *  before this claim existed (those resolve to no permissions, which is the
   *  safe direction — a stale token loses access rather than gaining it). */
  prid?: string | null;
  sid?: string;
  type: 'access' | 'impersonation';
}

// Throttle lastUsedAt writes: one update per session per minute keeps the
// inactivity window accurate without a DB write on every request.
const ACTIVITY_TOUCH_MS = 60_000;

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies['accessToken'] as string | undefined;

  if (!token) {
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return;
  }

  let payload: AccessTokenPayload;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
    return;
  }

  // Single-session enforcement: the access token is only honored while its
  // session (RefreshToken row, matched via the stable `sid` claim) still exists.
  // Logout / revocation elsewhere therefore takes effect immediately.
  if (!payload.sid) {
    res.status(401).json({ error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
    return;
  }
  const session = await prisma.refreshToken.findFirst({
    where: { sessionId: payload.sid },
    select: { id: true, lastUsedAt: true },
  });
  if (!session) {
    res.status(401).json({ error: 'Session has been signed out', code: 'SESSION_REVOKED' });
    return;
  }
  if (Date.now() - session.lastUsedAt.getTime() > ACTIVITY_TOUCH_MS) {
    prisma.refreshToken.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }

  // Verify the customer is still both un-suspended and admitted
  const customer = await prisma.customer.findUnique({
    where: { id: payload.customerId },
    select: { suspended: true, approved: true },
  });

  if (!customer) {
    res.status(401).json({ error: 'Customer not found', code: 'CUSTOMER_NOT_FOUND' });
    return;
  }

  if (customer.suspended) {
    res.status(403).json({ error: 'Customer is suspended', code: 'CUSTOMER_SUSPENDED' });
    return;
  }

  // Login already refuses an unapproved org, so this should be unreachable — which
  // is the point. It bounds the damage of any future path that mints a session
  // without going through initiateLogin, and it means revoking an org's approval
  // takes effect on the next request rather than at the next login.
  if (!customer.approved) {
    res.status(403).json({ error: 'Organization is awaiting approval', code: 'ORG_NOT_APPROVED' });
    return;
  }

  // Resolve the platform permission set. No DB round trip: permissionsFor() reads
  // a process-local map over the tiny PlatformRole table (60s TTL, busted on write).
  // Only vendor staff get one — can() ignores this for customer roles anyway, but
  // keeping it empty means a corrupted `prid` on a customer token grants nothing.
  const platformRoleId = payload.role === 'ADMINISTRATOR' ? (payload.prid ?? null) : null;
  const permissions = await permissionsFor(platformRoleId);

  req.user = {
    userId: payload.userId,
    customerId: payload.customerId,
    role: payload.role,
    platformRoleId,
    permissions,
  };
  next();
}
