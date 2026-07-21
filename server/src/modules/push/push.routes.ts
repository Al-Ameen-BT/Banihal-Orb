import { Router } from 'express';
import * as pushController from './push.controller';

// Mounted at /api/push behind the global auth middleware, so every handler has a
// verified req.user. No tenant middleware: PushSubscription is scoped explicitly
// by userId/tenantId and is excluded from the tenant Prisma extension.
const router = Router();

router.get('/vapid-public-key', pushController.getVapidPublicKey);
router.post('/subscribe', pushController.subscribe);
router.post('/unsubscribe', pushController.unsubscribe);

export default router;
