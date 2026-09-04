import { Router } from 'express';
import * as saasAdminController from './saas-admin.controller';
import { requirePermission } from '../../middleware/rbac.middleware';

// Mounted at /api/saas-admin behind requireRole('ADMINISTRATOR') (app.ts).
//
// That router-level gate proves only "works for the vendor" — EVERY platform role
// satisfies it, Intern included. So it is not authorization, it is an audience
// filter, and each route below carries its own permission key.
//
// There is deliberately no `onlyAdministrator` helper here any more: it was
// requireRole('ADMINISTRATOR'), identical to the mount gate, so it read like a
// restriction while granting everyone. Where a surface really is
// Administration-only, that is expressed by which roles hold the key — and
// `administration` holds every key by construction.
const router = Router();

// ─── Platform roles (IAM matrix) ─────────────────────────────────────────────
router.get('/roles', requirePermission('roles.manage'), saasAdminController.listPlatformRoles);
router.get('/roles/catalog', requirePermission('roles.manage'), saasAdminController.permissionCatalog);
router.post('/roles', requirePermission('roles.manage'), saasAdminController.createPlatformRole);
router.patch('/roles/:id', requirePermission('roles.manage'), saasAdminController.updatePlatformRole);
router.delete('/roles/:id', requirePermission('roles.manage'), saasAdminController.deletePlatformRole);

// Organizations (the key's label is "Organizations, flags & impersonation").
router.get('/orgs', requirePermission('orgs.manage'), saasAdminController.listOrgs);
router.get('/orgs/overview', requirePermission('orgs.manage'), saasAdminController.getOrgsOverview);
router.patch('/orgs/:id', requirePermission('orgs.manage'), saasAdminController.updateOrg);
router.get('/orgs/:id/detail', requirePermission('orgs.manage'), saasAdminController.getOrgDetail);

// People (org admins / impersonation / cross-org user mgmt)
router.get('/admins', requirePermission('users.manage'), saasAdminController.listOrgAdmins);
router.get('/all-users', requirePermission('users.manage'), saasAdminController.listAllOrgUsers);
router.post('/impersonate/:userId', requirePermission('orgs.manage'), saasAdminController.impersonateUser);
router.patch('/users/:id', requirePermission('users.manage'), saasAdminController.updateUser);
router.delete('/users/:id', requirePermission('users.manage'), saasAdminController.removeUser);
router.post('/users/:id/reset-password', requirePermission('users.manage'), saasAdminController.resetUserPassword);

// Metrics. /metrics is deliberately ungated: Employee and Intern legitimately see
// org counts and open-ticket totals on their dashboard. Its ONE sensitive field
// (mrr) is withheld field-level by the controller via can(req, 'revenue.view').
router.get('/metrics', saasAdminController.getMetrics);
router.get('/top-clients', requirePermission('nav.control_plane'), saasAdminController.getTopClients);
router.get('/sla-breaches', requirePermission('tickets.view'), saasAdminController.getSlaBreaches);
router.get('/chat-analytics', requirePermission('nav.control_plane'), saasAdminController.getChatAnalytics);

// Ticket escalations forwarded by org admins (categorized by org client-side)
router.get('/escalations', requirePermission('tickets.view'), saasAdminController.listEscalations);
router.patch('/escalations/:id', requirePermission('tickets.write'), saasAdminController.updateEscalation);

// Announcements (platform broadcasts)
router.get('/announcements', requirePermission('nav.control_plane'), saasAdminController.listAnnouncements);
router.post('/announcements', requirePermission('nav.control_plane'), saasAdminController.createAnnouncement);
router.patch('/announcements/:id', requirePermission('nav.control_plane'), saasAdminController.updateAnnouncement);
router.delete('/announcements/:id', requirePermission('nav.control_plane'), saasAdminController.deleteAnnouncement);

// Service requests
router.get('/requests', requirePermission('customer_services.manage'), saasAdminController.listRequests);
router.patch('/requests/:id', requirePermission('customer_services.manage'), saasAdminController.updateRequest);

// Customer services (each org's own services w/ expiry management)
router.get('/services', requirePermission('customer_services.manage'), saasAdminController.listServices);
router.post('/customers/:customerId/services', requirePermission('customer_services.manage'), saasAdminController.assignService);
router.patch('/services/:id', requirePermission('customer_services.manage'), saasAdminController.updateService);
router.post('/services/:id/renew', requirePermission('customer_services.manage'), saasAdminController.renewService);
router.delete('/services/:id', requirePermission('customer_services.manage'), saasAdminController.removeService);

// Service catalog (platform master list)
router.get('/catalog', requirePermission('catalog.manage'), saasAdminController.listCatalog);
router.post('/catalog', requirePermission('catalog.manage'), saasAdminController.createCatalogItem);
router.patch('/catalog/:id', requirePermission('catalog.manage'), saasAdminController.updateCatalogItem);
router.delete('/catalog/:id', requirePermission('catalog.manage'), saasAdminController.deleteCatalogItem);

// Feature flags — same key as organizations, per the key's own label.
router.get('/flags', requirePermission('orgs.manage'), saasAdminController.listFlags);
router.patch('/flags/:key', requirePermission('orgs.manage'), saasAdminController.toggleFlag);

// Ticket-number format — ticketing configuration, so it rides tickets.write.
router.get('/ticket-number-format', requirePermission('tickets.view'), saasAdminController.getTicketNumberFormat);
router.put('/ticket-number-format', requirePermission('tickets.write'), saasAdminController.updateTicketNumberFormat);

// Audit surfaces + staff directory ("Audit log, logins & staff directory").
router.get('/activity', requirePermission('platform_audit.view'), saasAdminController.getSadminActivity);
router.get('/system-activity', requirePermission('system_activity.view'), saasAdminController.getSystemActivity);
router.get('/logins-by-org', requirePermission('system_activity.view'), saasAdminController.getLoginsByOrg);
router.get('/sadmins', requirePermission('platform_audit.view'), saasAdminController.listSadmins);

// Staff lifecycle. Reading the directory is an audit action; changing a staff
// account is a user-management one, so the keys differ deliberately.
router.post('/staff', requirePermission('staff.invite'), saasAdminController.inviteStaff);
router.patch('/sadmins/:id', requirePermission('users.manage'), saasAdminController.updateSadmin);
router.delete('/sadmins/:id', requirePermission('users.manage'), saasAdminController.removeSadmin);
router.post('/sadmins/:id/reset-password', requirePermission('users.manage'), saasAdminController.resetSadminPassword);

// Security: accounts sharing the same password (platform-wide) — it enumerates
// users across every organization, so it is an audit surface.
router.get('/password-reuse', requirePermission('platform_audit.view'), saasAdminController.getPasswordReuse);

export default router;
