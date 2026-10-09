import { Router } from 'express';
import * as orgsController from './organizations.controller';
import { requireRole, requirePermissionIfPlatform } from '../../middleware/rbac.middleware';

const router = Router();

router.get('/me', orgsController.getMyOrg);
router.patch('/me', requireRole('ORG_ADMIN', 'ADMINISTRATOR'), orgsController.updateMyOrg);
// requireRole alone let EVERY platform account through, Intern included — the
// role check is satisfied by the base ADMINISTRATOR token, not by any capability.
// An ORG_ADMIN still passes on their role; platform staff must hold orgs.manage.
router.patch('/me/security', requireRole('ORG_ADMIN', 'ADMINISTRATOR'), requirePermissionIfPlatform('orgs.manage'), orgsController.updateSecurity);

// Services are visible to all org members (USER + ORG_ADMIN); platform staff
// need services.view, the key behind the Services nav item.
router.get('/me/services', requirePermissionIfPlatform('services.view'), orgsController.getMyServices);

export default router;
