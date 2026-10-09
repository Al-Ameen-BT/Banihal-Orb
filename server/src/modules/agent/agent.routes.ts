import { Router } from 'express';
import * as agentController from './agent.controller';
import { requireRole } from '../../middleware/rbac.middleware';
import { chatRateLimiter } from '../../middleware/rateLimiter';

const router = Router();

// Any authenticated user may ask; the answer is scoped to their platform role.
// Shares chatRateLimiter with /api/chat because both land on the same single-slot
// model server — a separate budget here would just let one user starve the other.
router.post('/chat', chatRateLimiter, agentController.chat);

// Aggregate ticket analytics across the estate — management surfaces only, matching
// the guard on the ops dashboard and the rest of ticketing's reporting routes.
router.get('/top-complaints', requireRole('ORG_ADMIN', 'ADMINISTRATOR'), agentController.complaints);

export default router;
