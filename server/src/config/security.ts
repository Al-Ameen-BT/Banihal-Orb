import { CorsOptions } from 'cors';
import { env } from './env';

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
    // Allow when: no Origin header (same-origin / curl / server-to-server),
    // a wildcard is configured, or the origin is explicitly allow-listed.
    // With credentials enabled, the cors lib reflects the actual origin (never a literal "*").
    if (!origin || allowed.includes('*') || allowed.includes(origin)) {
      callback(null, true);
    } else {
      // Reject cleanly (omit CORS headers) instead of throwing — throwing surfaces
      // as a 500 with no CORS headers, which is confusing in the browser console.
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

export const rateLimitConfig = {
  // Global cap across ALL routes, keyed by client IP. This app is a dashboard SPA: a single
  // page load fires ~10–15 API calls, so a low budget was exhausted after roughly
  // seven page views and threw 429s during normal navigation. 4000/15min keeps a real bound
  // while leaving room for an active session. Brute-force protection is NOT weakened by this:
  // /auth has its own stricter authRateLimiter mounted separately (see auth.routes.ts).
  global: { windowMs: 15 * 60 * 1000, max: 4000 },
  auth: { windowMs: 15 * 60 * 1000, max: 400 },
  // Per authenticated user (see chatRateLimiter keyGenerator). Generous headroom
  // so an interactive assistant session is never throttled in normal use; the cap
  // only guards the LLM backend against a single runaway/abusive user.
  chat: { windowMs: 60 * 1000, max: 240 },
};
