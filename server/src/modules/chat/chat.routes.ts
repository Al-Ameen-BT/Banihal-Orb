import { Router } from 'express';
import * as chatController from './chat.controller';
import { requirePermissionIfPlatform } from '../../middleware/rbac.middleware';
import { chatRateLimiter } from '../../middleware/rateLimiter';

const router = Router();

// The Assistant. Customers pass through; platform staff need nav.chat.
router.use(requirePermissionIfPlatform('nav.chat'));

router.post('/', chatRateLimiter, chatController.sendMessage);

// Persisted conversation history (scoped to the authenticated user)
router.get('/sessions', chatController.listSessions);
router.get('/sessions/:id', chatController.getSession);
router.delete('/sessions/:id', chatController.deleteSession);

export default router;
