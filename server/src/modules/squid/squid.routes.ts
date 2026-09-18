import { Router } from 'express';
import * as c from './squid.controller';
import { requireRole, requirePermissionIfPlatform } from '../../middleware/rbac.middleware';

// Org-facing squid proxy management. Mounted at /api/squid WITH the tenant
// middleware — every read/write auto-scopes to the caller's organization via the
// prisma tenant extension... except BUNDLE (below), which any logged-in megacert
// employee may hold for setup documents handed to branch engineers.
//
// Customers: only ORG_ADMIN may reach this surface — plain USERs have no squid
// options. Platform staff pass through the role guard and are then gated on
// squid.view (read) / squid.manage (write) — the shared-surface pattern.

const router = Router();

const view  = [requireRole('ORG_ADMIN', 'ADMINISTRATOR'), requirePermissionIfPlatform('squid.view')];
const manage = [requireRole('ORG_ADMIN', 'ADMINISTRATOR'), requirePermissionIfPlatform('squid.manage')];

router.get('/', ...view, c.listProxies);
router.get('/bundle-key', ...view, c.getBundleKey);
router.get('/:proxyId', ...view, c.getProxy);
router.get('/:proxyId/change-requests', ...view, c.listChangeRequests);
router.get('/:proxyId/telemetry', ...view, c.getTelemetry);
router.get('/:proxyId/activity', ...view, c.listActivity);
router.get('/:proxyId/report.csv', ...view, c.report);
router.post('/:proxyId/dependency-scan', ...manage, c.runDependencyScan);
router.post('/', ...manage, c.createProxy);
router.patch('/:proxyId', ...manage, c.updateProxy);
router.delete('/:proxyId', ...manage, c.deleteProxy);
router.post('/:proxyId/rotate-key', ...manage, c.rotateKey);
router.post('/:proxyId/verify-token', ...manage, c.verifyToken);

router.get('/:proxyId/branches', ...view, c.listBranches);
router.post('/:proxyId/branches', ...manage, c.createBranch);
router.patch('/:proxyId/branches/:branchId', ...manage, c.updateBranch);
router.delete('/:proxyId/branches/:branchId', ...manage, c.deleteBranch);
router.put('/:proxyId/branches/:branchId/lists', ...manage, c.setBranchLists);

router.put('/:proxyId/ports', ...manage, c.setPorts);
router.put('/:proxyId/full-access', ...manage, c.setFullAccess);

export default router;