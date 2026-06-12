import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { RegisterSchema, RegisterUserSchema, LoginSchema } from './auth.schema';
import * as authService from './auth.service';
import { env } from '../../config/env';

const COOKIE_OPTS = {
  httpOnly: true,
  secure: env.COOKIE_SECURE ?? (env.NODE_ENV === 'production'),
  sameSite: 'lax' as const,
};

function setTokenCookies(res: Response, tokens: { accessToken: string; refreshToken: string }): void {
  res.cookie('accessToken', tokens.accessToken, { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
  // Path covers /api/auth/refresh AND /api/auth/logout (a path of /api/auth/refresh
  // meant browsers never sent the cookie to logout, so sessions were never revoked).
  res.cookie('refreshToken', tokens.refreshToken, { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/api/auth' });
}

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = RegisterSchema.parse(req.body);
    const tokens = await authService.register(input);
    setTokenCookies(res, tokens);
    res.status(201).json({ message: 'Registration successful' });
  } catch (err) {
    next(err);
  }
}

export async function registerUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = RegisterUserSchema.parse(req.body);
    const tokens = await authService.registerUser(input);
    setTokenCookies(res, tokens);
    res.status(201).json({ message: 'Registration successful' });
  } catch (err) {
    next(err);
  }
}

// If the login request was made from a browser that already holds a valid
// access token, identify that session so the service can allow a same-browser
// re-login (e.g. right after registration) instead of blocking it.
function parseCurrentSession(req: Request): authService.CurrentSession | null {
  const token = req.cookies['accessToken'] as string | undefined;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as { userId?: string; sid?: string; type?: string };
    if (payload.type !== 'access' || !payload.userId || !payload.sid) return null;
    return { userId: payload.userId, sessionId: payload.sid };
  } catch {
    return null;
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = LoginSchema.parse(req.body);
    const tokens = await authService.login(input, parseCurrentSession(req));
    setTokenCookies(res, tokens);
    res.json({ message: 'Login successful' });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = req.cookies['refreshToken'] as string | undefined;
    if (!raw) {
      res.status(401).json({ error: 'Refresh token missing', code: 'REFRESH_TOKEN_MISSING' });
      return;
    }
    const tokens = await authService.refreshTokens(raw);
    setTokenCookies(res, tokens);
    res.json({ message: 'Token refreshed' });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Prefer the access token's identity (always sent); fall back to the refresh
    // token for requests where the access token has already expired.
    const current = parseCurrentSession(req);
    const raw = req.cookies['refreshToken'] as string | undefined;
    if (current) await authService.logoutByUser(current.userId);
    else if (raw) await authService.logout(raw);

    res.clearCookie('accessToken', COOKIE_OPTS);
    res.clearCookie('refreshToken', { ...COOKIE_OPTS, path: '/api/auth' });
    res.clearCookie('refreshToken', { ...COOKIE_OPTS, path: '/api/auth/refresh' }); // legacy path
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
}
