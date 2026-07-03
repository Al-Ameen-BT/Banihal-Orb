import { Router } from 'express';
import * as c from './slackBots.controller';

// Mounted at /api/slack-bots behind requireRole('ADMINISTRATOR') WITHOUT the tenant
// middleware — administrators manage bots cross-tenant.
const router = Router();

router.get('/', c.list);
router.get('/customers', c.customers);           // org picker for assignment
router.post('/', c.create);
router.get('/:id', c.get);
router.patch('/:id', c.update);
router.delete('/:id', c.remove);
router.post('/:id/connect', c.connect);
router.post('/:id/disconnect', c.disconnect);

// Per-bot dynamic form schema
router.get('/:id/fields', c.listFields);
router.post('/:id/fields', c.addField);
router.patch('/:id/fields/:fieldId', c.updateField);
router.delete('/:id/fields/:fieldId', c.deleteField);

// Per-organization assignment
router.get('/:id/orgs', c.listOrgs);
router.post('/:id/orgs', c.assignOrg);
router.delete('/:id/orgs/:customerId', c.unassignOrg);

export default router;
