import { Router } from 'express';
import * as orgsController from './organizations.controller';
import { requireRole } from '../../middleware/rbac.middleware';

const router = Router();

router.get('/me', orgsController.getMyOrg);
router.patch('/me', requireRole('ORG_ADMIN', 'SAAS_ADMIN'), orgsController.updateMyOrg);
router.patch('/me/security', requireRole('ORG_ADMIN', 'SAAS_ADMIN'), orgsController.updateSecurity);

// Services are visible to all org members (USER + ORG_ADMIN)
router.get('/me/services', orgsController.getMyServices);

export default router;
