import { Router } from 'express';
import * as chatController from './chat.controller';
import { chatRateLimiter } from '../../middleware/rateLimiter';

const router = Router();

router.post('/', chatRateLimiter, chatController.sendMessage);

export default router;
