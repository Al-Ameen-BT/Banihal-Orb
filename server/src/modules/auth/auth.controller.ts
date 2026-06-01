import { Request, Response, NextFunction } from 'express';
import { RegisterSchema, LoginSchema } from './auth.schema';
import * as authService from './auth.service';
import { env } from '../../config/env';

const COOKIE_OPTS = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
};

function setTokenCookies(res: Response, tokens: { accessToken: string; refreshToken: string }): void {
  res.cookie('accessToken', tokens.accessToken, { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
  res.cookie('refreshToken', tokens.refreshToken, { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/api/auth/refresh' });
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

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = LoginSchema.parse(req.body);
    const tokens = await authService.login(input);
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
    const raw = req.cookies['refreshToken'] as string | undefined;
    if (raw) await authService.logout(raw);
    res.clearCookie('accessToken', COOKIE_OPTS);
    res.clearCookie('refreshToken', { ...COOKIE_OPTS, path: '/api/auth/refresh' });
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
}
