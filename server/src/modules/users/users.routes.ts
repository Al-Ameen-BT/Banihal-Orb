import { Router } from 'express';
import * as usersController from './users.controller';
import { requireRole } from '../../middleware/rbac.middleware';

const router = Router();

router.get('/me', usersController.getMe);
router.patch('/me', usersController.updateMe);

router.get('/', requireRole('ORG_ADMIN', 'SAAS_ADMIN'), usersController.listUsers);
router.post('/invite', requireRole('ORG_ADMIN', 'SAAS_ADMIN'), usersController.inviteUser);
router.patch('/:id/role', requireRole('ORG_ADMIN', 'SAAS_ADMIN'), usersController.changeRole);
router.delete('/:id', requireRole('ORG_ADMIN', 'SAAS_ADMIN'), usersController.removeUser);

export default router;
