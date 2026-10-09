import { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { token } from './token.controller';
import { externalTokenRateLimiter, externalKeyRateLimiter } from '../../middleware/rateLimiter';
import { externalAuth, requireExternalScope, requireExternalReadScope } from './external-auth.middleware';
import * as controller from './external-tickets.controller';
import { applyChangeRequest, broadcastChangeRequestUpdate } from '../squid/squid.service';
import { audit } from '../../lib/audit';

// HMAC signature verification middleware for webhooks
function verifyWebhookSignature(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const signature = req.get('X-Webhook-Signature');
  if (!signature) {
    res.status(401).json({ error: 'Missing signature', code: 'MISSING_SIGNATURE' });
    return;
  }

  const payload = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha256', env.WEBHOOK_HMAC_SECRET)
    .update(payload)
    .digest('hex');

  // Compare using timing-safe comparison
  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    res.status(401).json({ error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
    return;
  }

  next();
}

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

// ─── Webhook for ticket approval callbacks (public, verified by signature) ───
// External ticketing system calls this when a ticket is approved/rejected
router.post(
  '/webhooks/ticket-status',
  express.json(),
  verifyWebhookSignature,
  async (req, res, next) => {
    try {
      const { ticketId, status, decidedBy, comment, changeRequestId } = req.body;
      
      if (!ticketId || !status || !changeRequestId) {
        res.status(400).json({ error: 'Missing required fields', code: 'VALIDATION_ERROR' });
        return;
      }

      const cr = await prisma.squidChangeRequest.findUnique({ where: { id: changeRequestId } });
      if (!cr) {
        res.status(404).json({ error: 'Change request not found', code: 'NOT_FOUND' });
        return;
      }

      if (cr.ticketId !== ticketId) {
        res.status(400).json({ error: 'Ticket ID mismatch', code: 'TICKET_MISMATCH' });
        return;
      }

      if (status === 'approved') {
        await prisma.squidChangeRequest.update({
          where: { id: changeRequestId },
          data: { status: 'APPROVED' },
        });

        // Broadcast the status update
        const updatedCr = await prisma.squidChangeRequest.findUnique({ where: { id: changeRequestId } });
        if (updatedCr) {
          broadcastChangeRequestUpdate(cr.proxyId, {
            id: updatedCr.id,
            status: updatedCr.status,
            action: updatedCr.action,
            summary: updatedCr.summary,
            ticketId: updatedCr.ticketId,
            ticketUrl: updatedCr.ticketUrl,
            appliedSeq: updatedCr.appliedSeq,
            error: updatedCr.error,
            updatedAt: updatedCr.updatedAt,
          });
        }

        // Apply the change (async, non-blocking)
        applyChangeRequest(changeRequestId, decidedBy || 'webhook').catch(async (e) => {
          await prisma.squidChangeRequest.update({
            where: { id: changeRequestId },
            data: { status: 'FAILED', error: e.message },
          });
          await audit({
            action: 'SQUID_CHANGE_FAILED', performedById: null, customerId: cr.customerId, targetId: changeRequestId,
            metadata: { error: e.message, action: cr.action },
          });

          // Broadcast the failure
          const failedCr = await prisma.squidChangeRequest.findUnique({ where: { id: changeRequestId } });
          if (failedCr) {
            broadcastChangeRequestUpdate(cr.proxyId, {
              id: failedCr.id,
              status: failedCr.status,
              action: failedCr.action,
              summary: failedCr.summary,
              ticketId: failedCr.ticketId,
              ticketUrl: failedCr.ticketUrl,
              appliedSeq: failedCr.appliedSeq,
              error: failedCr.error,
              updatedAt: failedCr.updatedAt,
            });
          }
        });

        await audit({
          action: 'SQUID_CHANGE_APPROVED', performedById: null, customerId: cr.customerId, targetId: changeRequestId,
          metadata: { ticketId, decidedBy, comment },
        });
      } else if (status === 'declined' || status === 'rejected') {
        await prisma.squidChangeRequest.update({
          where: { id: changeRequestId },
          data: { status: 'REJECTED', error: comment || 'Declined by approver' },
        });

        // Broadcast the rejection
        const rejectedCr = await prisma.squidChangeRequest.findUnique({ where: { id: changeRequestId } });
        if (rejectedCr) {
          broadcastChangeRequestUpdate(cr.proxyId, {
            id: rejectedCr.id,
            status: rejectedCr.status,
            action: rejectedCr.action,
            summary: rejectedCr.summary,
            ticketId: rejectedCr.ticketId,
            ticketUrl: rejectedCr.ticketUrl,
            appliedSeq: rejectedCr.appliedSeq,
            error: rejectedCr.error,
            updatedAt: rejectedCr.updatedAt,
          });
        }

        await audit({
          action: 'SQUID_CHANGE_REJECTED', performedById: null, customerId: cr.customerId, targetId: changeRequestId,
          metadata: { ticketId, decidedBy, comment },
        });
      }

      res.json({ ok: true });
    } catch (e) { next(e); }
  }
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