import { Router } from 'express';
import * as c from './external-admin.controller';
import { requirePermission } from '../../middleware/rbac.middleware';

// ─── External ticketing API — admin panel surface ────────────────────────────
// Keys + webhooks management for the /api/external surface.  Mounted at
// /api/external-admin behind requireRole('ADMINISTRATOR') in app.ts (no tenant
// scope — platform staff manage credentials cross-tenant).

const router = Router();

const view   = requirePermission('external_api.view');
const manage = requirePermission('external_api.manage');

router.get('/',                                     view,   c.list);
router.post('/',                                    manage, c.create);
router.post('/:clientId/revoke',                    manage, c.revoke);

router.get('/:clientId/webhooks',                   view,   c.listHooks);
router.post('/:clientId/webhooks',                  manage, c.addHook);
router.delete('/webhooks/:id',                      manage, c.removeHook);

export default router;