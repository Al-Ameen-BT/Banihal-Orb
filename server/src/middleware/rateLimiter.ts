import rateLimit from 'express-rate-limit';
import { rateLimitConfig } from '../config/security';

// Disable rate limiting under the test runner so the suite's rapid auth calls
// aren't throttled (NODE_ENV=test in CI; VITEST is set by vitest itself).
const isTestEnv = process.env['NODE_ENV'] === 'test' || process.env['VITEST'] === 'true';

export const globalRateLimiter = rateLimit({
  windowMs: rateLimitConfig.global.windowMs,
  max: rateLimitConfig.global.max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTestEnv,
  message: { error: 'Too many requests', code: 'RATE_LIMITED' },
});

export const authRateLimiter = rateLimit({
  windowMs: rateLimitConfig.auth.windowMs,
  max: rateLimitConfig.auth.max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTestEnv,
  message: { error: 'Too many authentication attempts', code: 'AUTH_RATE_LIMITED' },
});

export const chatRateLimiter = rateLimit({
  windowMs: rateLimitConfig.chat.windowMs,
  max: rateLimitConfig.chat.max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTestEnv,
  message: { error: 'Too many messages, please slow down', code: 'CHAT_RATE_LIMITED' },
});
