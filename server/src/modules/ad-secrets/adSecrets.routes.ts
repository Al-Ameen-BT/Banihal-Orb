import { Router } from 'express';
import * as c from './adSecrets.controller';

// Org-facing reveal surface — mounted with the tenant middleware (cookie auth).
// Only the target user or the requesting org-admin can see / reveal their own
// deliveries; the service enforces that + one-time reveal.
const router = Router();

router.get('/', c.list);
router.post('/:id/reveal', c.reveal);

export default router;
