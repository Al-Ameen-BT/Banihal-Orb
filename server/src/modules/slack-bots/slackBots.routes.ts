import { Router } from 'express';
import * as c from './slackBots.controller';
import { requirePermission } from '../../middleware/rbac.middleware';

// Mounted at /api/slack-bots behind requireRole('ADMINISTRATOR') WITHOUT the tenant
// middleware — administrators manage bots cross-tenant.
const router = Router();

// Platform-only surface: bots.view to look, bots.manage to change anything. The
// mount's requireRole('ADMINISTRATOR') only proves vendor staff, not which kind.
const view = requirePermission('bots.view');
const manage = requirePermission('bots.manage');

router.get('/', view, c.list);
router.get('/customers', view, c.customers);           // org picker for assignment
router.post('/', manage, c.create);
router.get('/:id', view, c.get);
router.patch('/:id', manage, c.update);
router.delete('/:id', manage, c.remove);
router.post('/:id/connect', manage, c.connect);
router.post('/:id/disconnect', manage, c.disconnect);
router.post('/:id/api-key', manage, c.generateApiKey); // AD-automation machine key (returned once)

// Per-bot dynamic form schema
router.get('/:id/fields', view, c.listFields);
router.post('/:id/fields', manage, c.addField);
router.patch('/:id/fields/:fieldId', manage, c.updateField);
router.delete('/:id/fields/:fieldId', manage, c.deleteField);

// Per-organization assignment
router.get('/:id/orgs', view, c.listOrgs);
router.post('/:id/orgs', manage, c.assignOrg);
router.delete('/:id/orgs/:customerId', manage, c.unassignOrg);

export default router;
