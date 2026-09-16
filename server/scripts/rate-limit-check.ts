import express from 'express';
import request from 'supertest';
import { externalKeyRateLimiter } from '../src/middleware/rateLimiter';

// The Vitest suite skips limiters (NODE_ENV/VITEST), so hammer the real handler
// here: 600 are allowed, the 601st within the window is 429 RATE_LIMITED, and the
// budget is keyed per external key (a second key is unaffected).
const app = express();
app.use((req, _res, next) => {
  const key = req.headers['x-key'] as string;
  (req as any).external = { keyId: key, scopes: [], store: 'default', orgs: [] };
  next();
});
app.get('/', externalKeyRateLimiter, (_req, res) => res.json({ ok: true }));

async function main() {
  for (let i = 0; i < 600; i++) {
    const r = await request(app).get('/').set('x-key', 'key-A');
    if (r.status !== 200) throw new Error(`hit-${i}: expected 200, got ${r.status}`);
  }
  const blocked = await request(app).get('/').set('x-key', 'key-A');
  if (blocked.status !== 429 || blocked.body.code !== 'RATE_LIMITED') {
    throw new Error(`expected 429 RATE_LIMITED, got ${blocked.status} ${JSON.stringify(blocked.body)}`);
  }
  if (!blocked.headers['x-ratelimit-limit']) throw new Error('legacy X-RateLimit-* headers missing');

  const other = await request(app).get('/').set('x-key', 'key-B');
  if (other.status !== 200) throw new Error(`other key must be independent, got ${other.status}`);
  console.log('RATE LIMITER OK: 600 allowed, 601st 429, per-key isolation, legacy headers present');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });