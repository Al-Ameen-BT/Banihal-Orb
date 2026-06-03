import { Router } from 'express';
import * as authController from './auth.controller';
import { authRateLimiter } from '../../middleware/rateLimiter';

const router = Router();

router.use(authRateLimiter);

router.post('/register', authController.register);
router.post('/register-saas', authController.registerSaas);
router.post('/login', authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

export default router;
