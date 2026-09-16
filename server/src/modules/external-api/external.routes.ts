import { Router } from 'express';
import express from 'express';
import { token } from './token.controller';
import { externalTokenRateLimiter, externalKeyRateLimiter } from '../../middleware/rateLimiter';
import { externalAuth, requireExternalScope, requireExternalReadScope } from './external-auth.middleware';
import * as controller from './external-tickets.controller';

// Machine-facing surface of the ticketing API. Mounted BEFORE the cookie auth
// wall in app.ts (like /api/ad-ingest) — external clients authenticate with
// OAuth client credentials, not browser sessions.
const router = Router();

// ─── Token issuance (public, brute-force limited) ────────────────────────────
// Accepts both form-encoded (OAuth convention) and JSON bodies.
router.post(
  '/token',
  externalTokenRateLimiter,
  express.urlencoded({ extended: false }),
  express.json(),
  token,
);

// ─── Everything below requires a valid external access JWT ───────────────────
router.use(externalAuth);
router.use(express.json());
// Per-key budget for every authenticated resource call, keyed on the API key.
router.use(externalKeyRateLimiter);

// ─── Resource endpoints (require a valid external access JWT) ───────────────
const read = requireExternalReadScope();
const write = requireExternalScope('tickets.write');

router.get('/search', read, controller.searchTickets);
router.get('/projects', read, controller.listProjects);

router.get('/tickets', read, controller.listTickets);
router.post('/tickets', write, controller.createTicket);
router.get('/tickets/:id', read, controller.getTicket);
router.patch('/tickets/:id', write, controller.updateTicket);
router.get('/tickets/:id/comments', read, controller.listComments);
router.post('/tickets/:id/comments', write, controller.addComment);

// An authenticated call to an unknown path must 404 HERE — if it fell through
// to the next app-level layer it would hit the cookie authMiddleware and answer
// AUTH_REQUIRED to a caller that already proved itself with a JWT.
router.use((_req, res) => {
  res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
});

export default router;