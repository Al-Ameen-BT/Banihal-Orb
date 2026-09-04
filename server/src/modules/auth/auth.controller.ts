import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { RegisterSchema, RegisterUserSchema, LoginSchema, ForgotPasswordSchema, ResetPasswordSchema, VerifyMfaSchema, ResendMfaSchema, VerifyEmailSchema, ResendVerificationSchema } from './auth.schema';
import * as authService from './auth.service';
import { env } from '../../config/env';

// Partially mask an email for display on the verification screen (j***e@acme.com).
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  const visible = local.length <= 2 ? local.charAt(0) : `${local.charAt(0)}${'*'.repeat(Math.min(local.length - 2, 4))}${local.charAt(local.length - 1)}`;
  return `${visible}@${domain}`;
}

// Exported for tests/security-headers.test.ts — these three flags are the
// session's security posture and should not change silently.
export const COOKIE_OPTS = {
  httpOnly: true,
  secure: env.COOKIE_SECURE ?? (env.NODE_ENV === 'production'),
  sameSite: 'lax' as const,
};

const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function setTokenCookies(res: Response, tokens: { accessToken: string; refreshToken: string }): void {
  res.cookie('accessToken', tokens.accessToken, { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
  // Path covers /api/auth/refresh AND /api/auth/logout (a path of /api/auth/refresh
  // meant browsers never sent the cookie to logout, so sessions were never revoked).
  res.cookie('refreshToken', tokens.refreshToken, { ...COOKIE_OPTS, maxAge: REFRESH_MAX_AGE_MS, path: '/api/auth' });
  // Value-less marker whose ONLY job is to be visible at path '/'. The client's Next
  // middleware gates page routes on cookies, and accessToken (15 min) is the only one
  // it can see — refreshToken is scoped to /api/auth, so browsers never send it with a
  // page request. Without this, a session idle for 15 minutes looked signed out to the
  // middleware and got bounced to /login despite a refresh token good for another week.
  // It carries no token and grants nothing: authMiddleware still demands a valid
  // accessToken on every /api route, so forging this only buys you a page shell that
  // immediately refreshes or redirects itself.
  res.cookie('hasSession', '1', { ...COOKIE_OPTS, maxAge: REFRESH_MAX_AGE_MS, path: '/' });
}

// Neither register handler sets session cookies any more. Registration used to
// return a live session, which made signing up its own login and left the
// email-verification gate with nothing to guard. Both now answer with the masked
// address the confirmation link went to.
export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = RegisterSchema.parse(req.body);
    const result = await authService.register(input);
    res.status(201).json({
      message: 'Registration successful. Check your email to confirm your address.',
      email: maskEmail(result.email),
      emailSent: result.emailSent,
    });
  } catch (err) {
    next(err);
  }
}

export async function registerUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = RegisterUserSchema.parse(req.body);
    const result = await authService.registerUser(input);
    res.status(201).json({
      message: 'Registration successful. Check your email to confirm your address.',
      email: maskEmail(result.email),
      emailSent: result.emailSent,
    });
  } catch (err) {
    next(err);
  }
}

export async function verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token } = VerifyEmailSchema.parse(req.body);
    const { email } = await authService.verifyEmail(token);
    res.json({ message: 'Email confirmed. You can sign in now.', email: maskEmail(email) });
  } catch (err) {
    next(err);
  }
}

// Always the same response, whether or not the address is registered or already
// confirmed — the same anti-enumeration rule forgotPassword follows. The one
// exception is the 429 cooldown, which only a real pending account can trigger.
export async function resendVerification(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email } = ResendVerificationSchema.parse(req.body);
    await authService.resendEmailVerification(email);
    res.json({ message: 'If that address needs confirming, a new link is on its way.' });
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

// Step 1 of login: validate the password. On a TRUSTED device (valid
// `trustedDevice` cookie from a prior "remember this device" MFA verify) the
// session cookies are issued immediately; otherwise a one-time code is emailed
// and the client must complete /auth/mfa/verify.
export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = LoginSchema.parse(req.body);
    // Refresh cookie (path /api/auth) is the durable same-browser proof — the
    // access cookie expires after 15 minutes and may be absent here.
    const rawRefresh = (req.cookies['refreshToken'] as string | undefined) ?? null;
    const trusted = (req.cookies['trustedDevice'] as string | undefined) ?? null;
    const outcome = await authService.initiateLogin(input, parseCurrentSession(req), rawRefresh, trusted);
    if (!outcome.mfaRequired) {
      setTokenCookies(res, outcome.tokens);
      res.json({ mfaRequired: false, message: 'Login successful' });
      return;
    }
    res.json({ mfaRequired: true, challengeId: outcome.challenge.challengeId, email: maskEmail(outcome.challenge.email) });
  } catch (err) {
    next(err);
  }
}

// Step 2 of login: verify the emailed code and issue session cookies. With
// rememberDevice, also set the trusted-device cookie so this browser skips the
// code for the next TRUSTED_DEVICE_DAYS.
export async function verifyMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = VerifyMfaSchema.parse(req.body);
    const tokens = await authService.verifyMfa(input.challengeId, input.code);
    setTokenCookies(res, tokens);
    if (input.rememberDevice) {
      const device = await authService.createTrustedDevice(tokens.userId);
      // device is null when the trusted-device store is unavailable; the user is
      // still logged in, they just won't skip MFA next time. Path /api/auth: the
      // cookie only needs to reach the login endpoint.
      if (device) {
        res.cookie('trustedDevice', device.cookieValue, { ...COOKIE_OPTS, maxAge: device.maxAgeMs, path: '/api/auth' });
      }
    }
    res.json({ message: 'Login successful' });
  } catch (err) {
    next(err);
  }
}

export async function resendMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ResendMfaSchema.parse(req.body);
    const { email } = await authService.resendMfaCode(input.challengeId);
    res.json({ message: 'A new code has been sent.', email: maskEmail(email) });
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
    // Must be cleared with the same path it was set on, or the marker outlives the
    // session and the middleware keeps waving signed-out users through to a shell.
    res.clearCookie('hasSession', { ...COOKIE_OPTS, path: '/' });
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ForgotPasswordSchema.parse(req.body);
    await authService.forgotPassword(input);
    res.json({ message: 'If an account exists, a password reset link has been sent.' });
  } catch (err) {
    next(err);
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = ResetPasswordSchema.parse(req.body);
    await authService.resetPassword(input);
    res.json({ message: 'Password has been successfully reset.' });
  } catch (err) {
    next(err);
  }
}
