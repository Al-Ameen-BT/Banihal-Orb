import { Router } from 'express';
import * as usersController from './users.controller';
import { requireRole } from '../../middleware/rbac.middleware';

const router = Router();

router.get('/me', usersController.getMe);
router.patch('/me', usersController.updateMe);
router.patch('/me/password', usersController.changeMyPassword);

router.get('/', requireRole('ORG_ADMIN', 'ADMINISTRATOR'), usersController.listUsers);
router.post('/invite', requireRole('ORG_ADMIN', 'ADMINISTRATOR'), usersController.inviteUser);
router.patch('/:id/role', requireRole('ORG_ADMIN', 'ADMINISTRATOR'), usersController.changeRole);
router.delete('/:id', requireRole('ORG_ADMIN', 'ADMINISTRATOR'), usersController.removeUser);

export default router;
