import { prisma } from '../../../config/database';
import { resolveTicketActor } from '../identity';

// The admin-store assignee pool = the platform's ADMINISTRATOR users. Each is
// bridged into b2b_ticketing_admin by email (additive upsert via resolveTicketActor,
// which runs in the current — admin — DB scope). Pre-existing admin-DB system users
// are never removed or altered; we only ensure an administrator row exists.
//
// Returned `id` is the admin-store Users.id (the value used for Tickets.assigneeId).
// Shape matches db.listStaff() so the assignee dropdowns work unchanged.
export async function listAdminAssignees(): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMINISTRATOR' },
    select: { id: true, name: true, email: true },
    orderBy: { name: 'asc' },
  });

  const out: Array<{ id: string; name: string; email: string; role: string }> = [];
  for (const a of admins) {
    const actor = await resolveTicketActor(a.id, 'ADMINISTRATOR'); // bridge → admin store (additive)
    out.push({ id: actor.id, name: a.name, email: a.email, role: 'ADMINISTRATOR' });
  }
  return out;
}
