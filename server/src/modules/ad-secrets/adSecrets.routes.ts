import { Router } from 'express';
import * as c from './adSecrets.controller';
import { requirePermissionIfPlatform } from '../../middleware/rbac.middleware';

// Org-facing reveal surface — mounted with the tenant middleware (cookie auth).
// Only the target user or the requesting org-admin can see / reveal their own
// deliveries; the service enforces that + one-time reveal.
const router = Router();

// Customers pass through — the service already restricts each delivery to its
// target user or the org-admin who requested it. Platform staff additionally need
// the keys, which is what makes an Intern see deliveries but never reveal one.
router.get('/', requirePermissionIfPlatform('credentials.view'), c.list);
router.post('/:id/reveal', requirePermissionIfPlatform('credentials.reveal'), c.reveal);

export default router;
