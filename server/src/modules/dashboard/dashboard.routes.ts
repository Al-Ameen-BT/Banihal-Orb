import { Router } from 'express';
import * as dashboardController from './dashboard.controller';
import { requireRole } from '../../middleware/rbac.middleware';

const router = Router();

router.get('/kpis', requireRole('ORG_ADMIN', 'SAAS_ADMIN'), dashboardController.getKpis);
router.get('/queue', dashboardController.getQueue);

export default router;
