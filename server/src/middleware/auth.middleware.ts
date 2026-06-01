import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../config/database';

interface AccessTokenPayload {
  userId: string;
  orgId: string;
  role: Role;
  type: 'access' | 'impersonation';
}

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

  // Verify org is not suspended
  const org = await prisma.organization.findUnique({
    where: { id: payload.orgId },
    select: { suspended: true },
  });

  if (!org) {
    res.status(401).json({ error: 'Organization not found', code: 'ORG_NOT_FOUND' });
    return;
  }

  if (org.suspended) {
    res.status(403).json({ error: 'Organization is suspended', code: 'ORG_SUSPENDED' });
    return;
  }

  req.user = { userId: payload.userId, orgId: payload.orgId, role: payload.role };
  next();
}
