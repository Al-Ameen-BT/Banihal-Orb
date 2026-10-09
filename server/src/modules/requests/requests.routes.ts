import { Router } from 'express';
import * as requestsController from './requests.controller';
import { requireRole } from '../../middleware/rbac.middleware';

const router = Router();

// All routes are tenant-scoped (mounted under withTenant) and operate on the
// authenticated user's own tickets (createdById = req.user.userId).
router.post('/', requestsController.createRequest);
router.get('/', requestsController.listMyRequests);

// Org-admin view of every ticket in the organization (declared before /:id so it
// isn't captured as an id param).
router.get('/org', requireRole('ORG_ADMIN', 'ADMINISTRATOR'), requestsController.listOrgRequests);

router.get('/:id', requestsController.getMyRequest);
router.patch('/:id/close', requestsController.closeMyRequest);

export default router;
