import { Router } from 'express';
import * as usersController from './users.controller';
import { requireRole, requirePermissionIfPlatform } from '../../middleware/rbac.middleware';

const router = Router();

// My Profile has no permission key on purpose: a permission that is always true
// is dead config, and revoking it would break password change and the MFA toggle.
router.get('/me', usersController.getMe);
router.patch('/me', usersController.updateMe);
router.patch('/me/password', usersController.changeMyPassword);

// Org user management. An ORG_ADMIN passes on their role; platform staff must
// also hold users.manage, so an Intern cannot list or remove accounts.
const manageUsers = [requireRole('ORG_ADMIN', 'ADMINISTRATOR'), requirePermissionIfPlatform('users.manage')];

router.get('/', manageUsers, usersController.listUsers);
router.post('/invite', manageUsers, usersController.inviteUser);
router.patch('/:id/role', manageUsers, usersController.changeRole);
router.delete('/:id', manageUsers, usersController.removeUser);

export default router;
