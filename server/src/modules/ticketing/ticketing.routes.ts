import { Router } from 'express';
import * as ticketingController from './ticketing.controller';
import { requireRole } from '../../middleware/rbac.middleware';
import { upload } from './uploads';

const router = Router();
const staff = requireRole('ORG_ADMIN', 'ADMINISTRATOR'); // management surfaces

// All authenticated users: raise + view tickets, see projects + the assignee pool.
router.get('/tickets', ticketingController.listTickets);
router.post('/tickets', ticketingController.createTicket);
router.get('/tickets/:id', ticketingController.getTicket);
router.get('/projects', ticketingController.listProjects);
router.get('/assignees', ticketingController.listAssignees);

// Collaboration — comments, attachments, watchers, activity history (any authed user).
router.get('/tickets/:id/comments', ticketingController.getComments);
router.post('/tickets/:id/comments', upload.array('files', 5), ticketingController.addComment);
router.get('/tickets/:id/activity', ticketingController.getActivity);
router.get('/tickets/:id/attachments', ticketingController.getTicketAttachments);
router.post('/tickets/:id/attachments', upload.array('files', 5), ticketingController.uploadTicketAttachments);
router.get('/attachments/:id/download', ticketingController.downloadAttachment);
router.get('/tickets/:id/watchers', ticketingController.getWatchers);
router.post('/tickets/:id/watch', ticketingController.watchTicket);
router.delete('/tickets/:id/watch', ticketingController.unwatchTicket);

// Management surfaces — ORG_ADMIN / ADMINISTRATOR.
router.patch('/tickets/:id', staff, ticketingController.updateTicket);
router.post('/projects', staff, ticketingController.createProject);
router.patch('/projects/:id', staff, ticketingController.updateProject);
router.delete('/projects/:id', staff, ticketingController.deleteProject);
router.get('/slas', staff, ticketingController.listSlas);
router.post('/slas', staff, ticketingController.createSla);
router.patch('/slas/:id', staff, ticketingController.updateSla);
router.delete('/slas/:id', staff, ticketingController.deleteSla);
router.get('/stats', staff, ticketingController.getStats);
router.get('/analytics', staff, ticketingController.getAnalytics);
router.get('/reports', staff, ticketingController.getReport);
router.get('/alerts', staff, ticketingController.getAlerts);

export default router;
