import { Router } from 'express';
import * as saasAdminController from './saas-admin.controller';

const router = Router();

// Organizations
router.get('/orgs', saasAdminController.listOrgs);
router.get('/orgs/overview', saasAdminController.getOrgsOverview);
router.patch('/orgs/:id', saasAdminController.updateOrg);
router.get('/orgs/:id/detail', saasAdminController.getOrgDetail);

// People (org admins / impersonation / cross-org user mgmt)
router.get('/admins', saasAdminController.listOrgAdmins);
router.post('/impersonate/:userId', saasAdminController.impersonateUser);
router.patch('/users/:id', saasAdminController.updateUser);
router.delete('/users/:id', saasAdminController.removeUser);
router.post('/users/:id/reset-password', saasAdminController.resetUserPassword);

// Metrics
router.get('/metrics', saasAdminController.getMetrics);
router.get('/top-clients', saasAdminController.getTopClients);

// Service requests
router.get('/requests', saasAdminController.listRequests);
router.patch('/requests/:id', saasAdminController.updateRequest);

// Organization services (subscriptions w/ renewals)
router.get('/services', saasAdminController.listServices);
router.patch('/services/:id', saasAdminController.updateService);
router.post('/services/:id/renew', saasAdminController.renewService);

// Feature flags
router.get('/flags', saasAdminController.listFlags);
router.patch('/flags/:key', saasAdminController.toggleFlag);

export default router;
