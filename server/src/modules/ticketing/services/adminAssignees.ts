import { prisma } from '../../../config/database';
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
export async function listAdminAssignees(): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMINISTRATOR' },
    select: { id: true },
    orderBy: { name: 'asc' },
  });
  for (const a of admins) {
    await resolveTicketActor(a.id, 'ADMINISTRATOR'); // bridge → admin store (additive)
  }

  // Safe here (and only here): the caller is an ADMINISTRATOR, so getTicketDb() is
  // already scoped to the admin store — no org-level form can reach this pool.
  return listStaff({ includeAdmins: true });
}
