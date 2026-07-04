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
  global: { windowMs: 15 * 60 * 1000, max: 100 },
  auth: { windowMs: 15 * 60 * 1000, max: 100 },
  // Per authenticated user (see chatRateLimiter keyGenerator). Generous headroom
  // so an interactive assistant session is never throttled in normal use; the cap
  // only guards the LLM backend against a single runaway/abusive user.
  chat: { windowMs: 60 * 1000, max: 60 },
};
