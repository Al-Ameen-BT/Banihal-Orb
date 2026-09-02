import { Router } from 'express';
import * as saasAdminController from './saas-admin.controller';
import { requireRole, requirePermission } from '../../middleware/rbac.middleware';

const router = Router();
const onlyAdministrator = requireRole('ADMINISTRATOR');

// ─── Platform roles (read-only for now; the matrix editor lands in P6) ───────
// Both are needed by the roles UI and by the staff-invite role picker.
router.get('/roles', requirePermission('roles.manage'), saasAdminController.listPlatformRoles);
router.get('/roles/catalog', requirePermission('roles.manage'), saasAdminController.permissionCatalog);

// Organizations
router.get('/orgs', saasAdminController.listOrgs);
router.get('/orgs/overview', saasAdminController.getOrgsOverview);
router.patch('/orgs/:id', saasAdminController.updateOrg);
router.get('/orgs/:id/detail', saasAdminController.getOrgDetail);

// People (org admins / impersonation / cross-org user mgmt)
router.get('/admins', saasAdminController.listOrgAdmins);
router.get('/all-users', onlyAdministrator, saasAdminController.listAllOrgUsers);
router.post('/impersonate/:userId', saasAdminController.impersonateUser);
router.patch('/users/:id', saasAdminController.updateUser);
router.delete('/users/:id', saasAdminController.removeUser);
router.post('/users/:id/reset-password', saasAdminController.resetUserPassword);

// Metrics
router.get('/metrics', saasAdminController.getMetrics);
router.get('/top-clients', saasAdminController.getTopClients);
router.get('/sla-breaches', saasAdminController.getSlaBreaches);
router.get('/chat-analytics', saasAdminController.getChatAnalytics);

// Ticket escalations forwarded by org admins (categorized by org client-side)
router.get('/escalations', saasAdminController.listEscalations);
router.patch('/escalations/:id', saasAdminController.updateEscalation);

// Announcements (platform broadcasts)
router.get('/announcements', saasAdminController.listAnnouncements);
router.post('/announcements', saasAdminController.createAnnouncement);
router.patch('/announcements/:id', saasAdminController.updateAnnouncement);
router.delete('/announcements/:id', saasAdminController.deleteAnnouncement);

// Service requests
router.get('/requests', saasAdminController.listRequests);
router.patch('/requests/:id', saasAdminController.updateRequest);

// Customer services (each org's own services w/ expiry management)
router.get('/services', saasAdminController.listServices);
router.post('/customers/:customerId/services', saasAdminController.assignService);
router.patch('/services/:id', saasAdminController.updateService);
router.post('/services/:id/renew', saasAdminController.renewService);
router.delete('/services/:id', saasAdminController.removeService);

// Service catalog (platform master list)
router.get('/catalog', saasAdminController.listCatalog);
router.post('/catalog', saasAdminController.createCatalogItem);
router.patch('/catalog/:id', saasAdminController.updateCatalogItem);
router.delete('/catalog/:id', saasAdminController.deleteCatalogItem);

// Feature flags
router.get('/flags', saasAdminController.listFlags);
router.patch('/flags/:key', saasAdminController.toggleFlag);

// Ticket-number format (whole router is already ADMINISTRATOR-gated)
router.get('/ticket-number-format', saasAdminController.getTicketNumberFormat);
router.put('/ticket-number-format', saasAdminController.updateTicketNumberFormat);

// Administrator-only: SADMIN activity feed + Sadmin management
router.get('/activity', onlyAdministrator, saasAdminController.getSadminActivity);
router.get('/system-activity', onlyAdministrator, saasAdminController.getSystemActivity);
router.get('/logins-by-org', onlyAdministrator, saasAdminController.getLoginsByOrg);
router.get('/sadmins', onlyAdministrator, saasAdminController.listSadmins);
router.patch('/sadmins/:id', onlyAdministrator, saasAdminController.updateSadmin);
router.delete('/sadmins/:id', onlyAdministrator, saasAdminController.removeSadmin);
router.post('/sadmins/:id/reset-password', onlyAdministrator, saasAdminController.resetSadminPassword);

// Security: accounts sharing the same password (platform-wide). ADMINISTRATOR only —
// it enumerates users across every organization.
router.get('/password-reuse', onlyAdministrator, saasAdminController.getPasswordReuse);

export default router;
