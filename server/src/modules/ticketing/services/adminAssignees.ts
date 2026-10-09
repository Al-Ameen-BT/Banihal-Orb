import { prisma } from '../../../config/database';
import { runWithTicketDb } from '../../../config/ticketDatabase';
import { resolveTicketActor } from '../identity';
import { listStaff } from '../ticketing.client';

// The admin-store assignee pool = every active user that EXISTS in b2b_ticketing_admin
// (admin / manager / developer / tester), i.e. the real roster the ticketing system
// was seeded with — not just the platform's own ADMINISTRATOR accounts.
//
// The bridge loop below still runs first: it additively upserts a Users row for each
// platform ADMINISTRATOR, which is what guarantees an administrator who has never
// created a ticket is still assignable. Those bridged rows then come back from the
// roster query like any other, so nobody is listed twice. Pre-existing admin-DB rows
// are never removed or altered.
//
// Returned `id` is the admin-store Users.id (the value used for Tickets.assigneeId).
// Shape matches db.listStaff() so the assignee dropdowns work unchanged.
//
// The whole body runs inside an EXPLICIT runWithTicketDb('admin'): the bridge loop
// WRITES (resolveTicketActor upserts a Users row into whatever store the ambient
// scope selects), so an ambient scope of 'default' here would silently seed every
// platform administrator into the CLIENT store, permanently and invisibly. The
// caller has always been an ADMINISTRATOR whose scope is already 'admin' — this
// makes that an enforced precondition rather than a documented assumption.
export async function listAdminAssignees(): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMINISTRATOR' },
    select: { id: true },
    orderBy: { name: 'asc' },
  });

  return runWithTicketDb('admin', async () => {
    for (const a of admins) {
      await resolveTicketActor(a.id, 'ADMINISTRATOR'); // bridge → admin store (additive)
    }
    return listStaff({ includeAdmins: true });
  });
}
