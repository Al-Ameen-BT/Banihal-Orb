import { Router } from 'express';
import * as ticketingController from './ticketing.controller';
import { requireRole } from '../../middleware/rbac.middleware';
import { runWithTicketDb } from '../../config/ticketDatabase';
import { upload } from './uploads';

const router = Router();
const staff = requireRole('ORG_ADMIN', 'ADMINISTRATOR'); // management surfaces
const onlyOrgAdmin = requireRole('ORG_ADMIN');            // escalation is an org-side action
const onlyAdministrator = requireRole('ADMINISTRATOR');   // platform admin store

// Scope every ticketing request to a store by the caller's platform role:
// ADMINISTRATOR → the isolated admin store (b2b_ticketing_admin); everyone else →
// the shared client store (b2b_ticket). All ticketing.client queries read this
// scope via getTicketDb(). (Escalation overrides the scope per-operation.)
router.use((req, _res, next) =>
  runWithTicketDb(req.user?.role === 'ADMINISTRATOR' ? 'admin' : 'default', () => next()));

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

// Notifications — updates on your own tickets (any authenticated role).
router.get('/my-updates', ticketingController.myUpdates);

// Escalation — ORG_ADMIN copies an unclosed client (b2b_ticket) ticket into the
// ADMINISTRATOR store, routed to the administrator group (unassigned, notify-all).
router.post('/tickets/:id/escalate', onlyOrgAdmin, ticketingController.escalateTicket);

// ADMINISTRATOR-only: the admin store's client pool (New Ticket form's client picker).
router.get('/customers', onlyAdministrator, ticketingController.listCustomers);

// ADMINISTRATOR escalation notifications + first-wins claim (admin store).
router.get('/admin/escalation-alerts', onlyAdministrator, ticketingController.escalationAlerts);
router.post('/admin/tickets/:id/claim', onlyAdministrator, ticketingController.claimTicket);

// Management surfaces — ORG_ADMIN / ADMINISTRATOR.
router.patch('/tickets/:id', staff, ticketingController.updateTicket);
router.post('/projects', staff, ticketingController.createProject);
router.patch('/projects/:id', staff, ticketingController.updateProject);
router.delete('/projects/:id', staff, ticketingController.deleteProject);
router.get('/slas', staff, ticketingController.listSlas);
router.post('/slas', staff, ticketingController.createSla);
router.patch('/slas/:id', staff, ticketingController.updateSla);
router.delete('/slas/:id', staff, ticketingController.deleteSla);
// Ops-dashboard aggregate. Scoped by the same role→store rule as everything else
// above, so an ORG_ADMIN's dashboard can only ever aggregate their own store.
router.get('/dashboard', staff, ticketingController.dashboardOverview);
router.get('/stats', staff, ticketingController.getStats);
router.get('/analytics', staff, ticketingController.getAnalytics);
router.get('/reports', staff, ticketingController.getReport);
router.get('/alerts', staff, ticketingController.getAlerts);

export default router;
