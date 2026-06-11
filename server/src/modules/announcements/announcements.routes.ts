import { Router } from 'express';
import * as announcementsController from './announcements.controller';

const router = Router();

// Active platform announcements visible to the caller's organization.
router.get('/', announcementsController.listAnnouncements);

export default router;
