import { Router } from 'express';
import * as c from './bots.controller';
import { requireRole, requirePermissionIfPlatform } from '../../middleware/rbac.middleware';

// Mounted at /api/bots WITH the tenant middleware — reads/writes auto-scope to the
// caller's organization. Creating a bot ticket is an ORG_ADMIN action.
const router = Router();

router.get('/', requirePermissionIfPlatform('bots.view'), c.list);
router.post('/:id/tickets', requireRole('ORG_ADMIN'), c.createTicket);

export default router;
