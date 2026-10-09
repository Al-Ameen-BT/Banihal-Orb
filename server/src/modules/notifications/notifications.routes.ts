import { Router } from 'express';
import * as controller from './notifications.controller';

// No permission guards: these are the caller's OWN notifications, and every query
// is scoped to req.user.userId in the service. Any authenticated role has some.
const router = Router();

router.get('/', controller.list);
router.post('/read-all', controller.markAllRead);   // before /:id/read — 'read-all' is not an id
router.post('/:id/read', controller.markRead);

export default router;
