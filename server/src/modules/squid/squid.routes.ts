import { Router } from 'express';
import * as c from './squid.controller';
import { requireRole, requirePermissionIfPlatform } from '../../middleware/rbac.middleware';
import { squidControlRoutes } from './squidControl.routes';

// Human API: connection management and approval-ticket requests only.
// Configuration delivery remains on the authenticated machine API.
const router = Router();
router.use(squidControlRoutes(false));
const view = [requireRole('ORG_ADMIN', 'ADMINISTRATOR'), requirePermissionIfPlatform('squid.view')];
const manage = [requireRole('ORG_ADMIN', 'ADMINISTRATOR'), requirePermissionIfPlatform('squid.manage')];
router.get('/', ...view, c.listProxies);
router.get('/bundle-key', ...view, c.getBundleKey);
router.get('/:proxyId/change-requests', ...view, c.listChangeRequests);
router.post('/:proxyId/change-requests', ...manage, requirePermissionIfPlatform('tickets.write'), c.createChangeRequest);
router.get('/:proxyId/change-requests/stream', ...view, c.streamChangeRequests);
router.post('/:proxyId/rotate-key', ...manage, c.rotateKey);
router.post('/:proxyId/verify-token', ...manage, c.verifyToken);
router.post('/:proxyId/external-api-key', ...manage, c.linkExternalApiKey);
router.delete('/:proxyId/external-api-key', ...manage, c.unlinkExternalApiKey);
export default router;
