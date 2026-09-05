import { Router } from 'express';
import * as authController from './auth.controller';
import { authRateLimiter } from '../../middleware/rateLimiter';

const router = Router();

router.use(authRateLimiter);

router.post('/register', authController.register);
router.post('/register-user', authController.registerUser);
router.post('/login', authController.login);
router.post('/mfa/verify', authController.verifyMfa);
router.post('/mfa/resend', authController.resendMfa);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-verification', authController.resendVerification);
router.post('/org-approval/verify', authController.verifyOrgApproval);
router.post('/org-approval/resend', authController.resendOrgApproval);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

export default router;
