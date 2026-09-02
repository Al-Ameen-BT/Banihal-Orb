import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import type { PermissionKey } from '../config/permissions';

export const requireRole = (...allowedRoles: Role[]) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions', code: 'FORBIDDEN' });
      return;
    }
    next();
  };

// ─── Platform permissions ────────────────────────────────────────────────────
// requireRole above governs the CUSTOMER side (USER / ORG_ADMIN) and is unchanged.
// Everything below governs the vendor's own staff, whose fine-grained role lives
// in User.platformRoleId and whose permission set is resolved once per request in
// auth.middleware.

/**
 * Does this caller hold `key`?
 *
 * Fails closed, in this order — the first branch is the load-bearing one. A
 * customer role can NEVER hold a platform permission, whatever the database says,
 * so "the permission engine covers platform staff only" is structural rather than
 * a convention someone has to remember. It also means a corrupted or hostile
 * platformRoleId on a customer account grants nothing.
 */
export function can(req: Request, key: PermissionKey): boolean {
  if (!req.user || req.user.role !== 'ADMINISTRATOR') return false;
  return req.user.permissions.has(key);
}

// PERMISSION_DENIED, deliberately NOT the FORBIDDEN that requireRole returns. The
// browser client hard-navigates to /403 on FORBIDDEN, which is right for "you may
// not open this page" and wrong for "you may not click this button" — the distinct
// code is what lets lib/api.ts show an inline toast instead. See client §7.
const deny = (res: Response): void => {
  res.status(403).json({ error: 'Insufficient permissions', code: 'PERMISSION_DENIED' });
};

/**
 * Platform-only route: the caller must be vendor staff AND hold `key`.
 * Customer roles are rejected outright.
 */
export const requirePermission = (key: PermissionKey) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (!can(req, key)) { deny(res); return; }
    next();
  };

/**
 * Shared route serving both audiences: customer roles pass through untouched
 * (their own requireRole guard already decided), while platform staff must
 * additionally hold `key`. This is what stops an Intern reaching a surface that
 * today is open to every ADMINISTRATOR.
 */
export const requirePermissionIfPlatform = (key: PermissionKey) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (req.user?.role !== 'ADMINISTRATOR') { next(); return; }
    if (!can(req, key)) { deny(res); return; }
    next();
  };
