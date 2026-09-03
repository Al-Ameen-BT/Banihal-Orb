// The seeded permission sets, transcribed from db/b2b.sql.
//
// Shared by permissions.test.ts (truth table) and escalation-access.test.ts
// (delivery chain) so the transcription exists once. If someone edits the SQL
// seed without editing this file, those tests fail — which is the point: a typo
// in that jsonb array is otherwise a silent, permanent denial.
export const SEEDED: Record<string, string[]> = {
  hr_admin: [
    'nav.control_plane', 'catalog.manage', 'customer_services.manage', 'orgs.manage',
    'platform_audit.view', 'revenue.view', 'users.manage', 'staff.invite', 'roles.manage',
    'services.view', 'nav.chat', 'tickets.view', 'tickets.write', 'ticket.store.admin',
  ],
  employee: [
    'nav.chat', 'tickets.view', 'tickets.write', 'ticket.store.admin',
    'credentials.view', 'credentials.reveal', 'bots.view', 'bots.manage',
  ],
  intern: [
    'nav.chat', 'tickets.view', 'ticket.store.admin', 'credentials.view', 'bots.view',
  ],
};
