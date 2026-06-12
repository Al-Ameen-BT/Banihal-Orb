import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../config/database';

interface AccessTokenPayload {
  userId: string;
  customerId: string;
  role: Role;
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

  // Verify customer is not suspended
  const customer = await prisma.customer.findUnique({
    where: { id: payload.customerId },
    select: { suspended: true },
  });

  if (!customer) {
    res.status(401).json({ error: 'Customer not found', code: 'CUSTOMER_NOT_FOUND' });
    return;
  }

  if (customer.suspended) {
    res.status(403).json({ error: 'Customer is suspended', code: 'CUSTOMER_SUSPENDED' });
    return;
  }

  req.user = { userId: payload.userId, customerId: payload.customerId, role: payload.role };
  next();
}
