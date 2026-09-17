import { Router } from 'express';
import * as c from './squid.controller';
import { requireRole } from '../../middleware/rbac.middleware';

// Org-facing squid proxy management. Mounted at /api/squid WITH the tenant
// middleware — every read/write auto-scopes to the caller's organization via the
// prisma tenant extension... except BUNDLE (below), which any logged-in megacert
// employee may hold for setup documents handed to branch engineers.
//
// Customers: management is an ORG_ADMIN action; USERs read. Platform staff
// additionally need squid.view/squid.manage (gunpowder gates nothing for them —
// this router is the CUSTOMER surface).

const router = Router();

router.get('/', requireRole('USER', 'ORG_ADMIN'), c.listProxies);
router.get('/bundle-key', requireRole('USER', 'ORG_ADMIN'), c.getBundleKey);
router.get('/:proxyId', requireRole('USER', 'ORG_ADMIN'), c.getProxy);
router.post('/', requireRole('ORG_ADMIN'), c.createProxy);
router.patch('/:proxyId', requireRole('ORG_ADMIN'), c.updateProxy);
router.delete('/:proxyId', requireRole('ORG_ADMIN'), c.deleteProxy);
router.post('/:proxyId/rotate-key', requireRole('ORG_ADMIN'), c.rotateKey);

router.get('/:proxyId/branches', requireRole('ORG_ADMIN'), c.listBranches);
router.post('/:proxyId/branches', requireRole('ORG_ADMIN'), c.createBranch);
router.patch('/:proxyId/branches/:branchId', requireRole('ORG_ADMIN'), c.updateBranch);
router.delete('/:proxyId/branches/:branchId', requireRole('ORG_ADMIN'), c.deleteBranch);
router.put('/:proxyId/branches/:branchId/lists', requireRole('ORG_ADMIN'), c.setBranchLists);

router.put('/:proxyId/ports', requireRole('ORG_ADMIN'), c.setPorts);
router.put('/:proxyId/full-access', requireRole('ORG_ADMIN'), c.setFullAccess);

export default router;