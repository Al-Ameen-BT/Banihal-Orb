import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { adKeyAuth } from './adKeyAuth.middleware';
import * as c from './adSecrets.controller';

// Machine ingest for the AD automation — mounted BEFORE the cookie auth middleware.
// Authenticated by a per-bot API key (Authorization: Bearer adk_…), not a session.
const router = Router();

const ingestLimiter = rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false });

router.post('/deliver', ingestLimiter, adKeyAuth, c.deliver);

export default router;
