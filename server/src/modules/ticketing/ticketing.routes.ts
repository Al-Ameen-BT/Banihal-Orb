import { Router } from 'express';
import * as ticketingController from './ticketing.controller';
import { requireRole } from '../../middleware/rbac.middleware';

const router = Router();
const orgAdmin = requireRole('ORG_ADMIN', 'ADMINISTRATOR');

// Users + org admins: raise and view tickets, see project list (for the form).
router.get('/tickets', ticketingController.listTickets);
router.post('/tickets', ticketingController.createTicket);
router.get('/projects', ticketingController.listProjects);

// Escalation to platform Administrators — strictly ORG_ADMIN (per requirement,
// the escalate action belongs to org admins only).
router.post('/tickets/:id/escalate', requireRole('ORG_ADMIN'), ticketingController.escalateTicket);

// Org-admin control system: workflow, stats, analytics, projects, reports, alerts.
router.patch('/tickets/:id', orgAdmin, ticketingController.updateTicket);
router.get('/stats', orgAdmin, ticketingController.getStats);
router.get('/analytics', orgAdmin, ticketingController.getAnalytics);
router.post('/projects', orgAdmin, ticketingController.createProject);
router.delete('/projects/:id', orgAdmin, ticketingController.deleteProject);
router.get('/reports', orgAdmin, ticketingController.getReport);
router.get('/alerts', orgAdmin, ticketingController.getAlerts);

export default router;
