import { Router } from 'express';
import * as ticketingController from './ticketing.controller';
import { can, requireRole, requirePermission, requirePermissionIfPlatform } from '../../middleware/rbac.middleware';
import { runWithTicketDb } from '../../config/ticketDatabase';
import { upload } from './uploads';

const router = Router();
// Management surfaces. An ORG_ADMIN passes on their role alone (their own
// authorization was decided when they were made an org admin); platform staff
// must additionally hold the key.
//
// The split is the whole point of the view/write pair: an Intern holds
// tickets.view but not tickets.write, so they READ the ops dashboard, SLAs and
// analytics while every mutation below returns PERMISSION_DENIED.
const staffRead  = [requireRole('ORG_ADMIN', 'ADMINISTRATOR'), requirePermissionIfPlatform('tickets.view')];
const staffWrite = [requireRole('ORG_ADMIN', 'ADMINISTRATOR'), requirePermissionIfPlatform('tickets.write')];
const onlyOrgAdmin = requireRole('ORG_ADMIN');                  // escalation is an org-side action
const adminStore = requirePermission('ticket.store.admin');     // platform admin store

// Scope every ticketing request to a store by the caller's PERMISSION, not their
// role: ticket.store.admin → the isolated admin store (b2b_ticketing_admin);
// everyone else → the shared client store (b2b_ticket). All ticketing.client
// queries read this scope via getTicketDb(). (Escalation overrides it per-op.)
//
// can() returns false for USER / ORG_ADMIN whatever the database says, so the
// customer side is structurally pinned to the shared store — the same guarantee
// the old role check gave, now expressed by the key that documents it.
router.use((req, _res, next) =>
  runWithTicketDb(can(req, 'ticket.store.admin') ? 'admin' : 'default', () => next()));

// Ticketing at all is tickets.view for platform staff. Customers fall straight
// through — their access was already decided by being in the org. Without this a
// custom platform role with no ticketing keys still reached every route below.
router.use(requirePermissionIfPlatform('tickets.view'));

// All authenticated users: raise + view tickets, see projects + the assignee pool.
router.get('/tickets', ticketingController.listTickets);
router.post('/tickets', ticketingController.createTicket);
router.get('/tickets/:id', ticketingController.getTicket);
router.get('/projects', ticketingController.listProjects);
router.get('/assignees', ticketingController.listAssignees);
// @ picker pool — platform users only, in whichever store the scope selected.
router.get('/mention-candidates', ticketingController.listMentionCandidates);

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

// Admin-store only: its client pool (New Ticket form's client picker).
router.get('/customers', adminStore, ticketingController.listCustomers);

// Escalation notifications + first-wins claim (admin store). Claiming is a write,
// so it needs tickets.write on top of reaching the store at all.
router.get('/admin/escalation-alerts', adminStore, ticketingController.escalationAlerts);
router.post('/admin/tickets/:id/claim', adminStore, requirePermission('tickets.write'), ticketingController.claimTicket);

// Edit / delete — OPEN to every authenticated user, with the actual authorization
// (creator + ADMINISTRATOR + ORG_ADMIN) enforced in assertCanEditTicket. A ticket's
// CREATOR may edit it whatever their role — including a plain USER — so the old
// staffWrite gate (ORG_ADMIN/ADMINISTRATOR) would lock the creator out. Platform
// staff still need tickets.write to reach a mutation.
router.patch('/tickets/:id', requirePermissionIfPlatform('tickets.write'), ticketingController.updateTicket);
// Permanent, and it cascades the ticket's comments, attachments and history. Same
// creator-or-admin authorization as PATCH, enforced in assertCanEditTicket.
router.delete('/tickets/:id', requirePermissionIfPlatform('tickets.write'), ticketingController.deleteTicket);
router.post('/projects', staffWrite, ticketingController.createProject);
router.patch('/projects/:id', staffWrite, ticketingController.updateProject);
router.delete('/projects/:id', staffWrite, ticketingController.deleteProject);
router.get('/slas', staffRead, ticketingController.listSlas);
router.post('/slas', staffWrite, ticketingController.createSla);
router.patch('/slas/:id', staffWrite, ticketingController.updateSla);
router.delete('/slas/:id', staffWrite, ticketingController.deleteSla);
// Ops-dashboard aggregate. Scoped by the same role→store rule as everything else
// above, so an ORG_ADMIN's dashboard can only ever aggregate their own store.
router.get('/dashboard', staffRead, ticketingController.dashboardOverview);
router.get('/stats', staffRead, ticketingController.getStats);
router.get('/analytics', staffRead, ticketingController.getAnalytics);
router.get('/reports', staffRead, ticketingController.getReport);
router.get('/alerts', staffRead, ticketingController.getAlerts);

export default router;
