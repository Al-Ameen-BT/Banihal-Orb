import { prisma, customerContext } from '../../../config/database';
import { getTicketDb, getTicketDbScope } from '../../../config/ticketDatabase';
import { resolveTicketActor } from '../identity';
import { BOT_EMAIL_DOMAIN } from '../ticketing.client';

/**
 * MENTION CANDIDATES — platform users only, by email.
 *
 * The @ picker draws from here, not from listStaff/listAdminAssignees. A user is a
 * candidate only when BOTH lists know them by the same email:
 *   1. the platform users list  (b2b_saas `User`, the "Application users list"), and
 *   2. this ticket store's Users table (the "Admin-ticketing DB users list").
 * Tickets are cross-referenced by email everywhere (identity.ts), so this join is
 * the exact boundary: native ticketing staff, Slack bots and thumbprint rows — who
 * have no B2B account — fall out of the intersection and cannot be mentioned.
 *
 * `id` is the TICKET-STORE Users.id, which is what a comment's `mentions` array
 * carries and what deliverMentions re-checks at delivery time.
 */
export async function listMentionCandidates(): Promise<Array<{ id: string; name: string; email: string }>> {
  // In the ADMIN store, mirror listAdminAssignees and additively bridge every
  // platform ADMINISTRATOR first — otherwise an administrator who has never claimed
  // or created a ticket has no store row and would silently miss the picker. The
  // shared (org) store skips this: platform admins do not belong to an org's pool.
  if (getTicketDbScope() === 'admin') {
    const admins = await prisma.user.findMany({ where: { role: 'ADMINISTRATOR' }, select: { id: true } });
    for (const a of admins) await resolveTicketActor(a.id, 'ADMINISTRATOR').catch(() => {});
  }

  // Platform users list — outside the tenant context: the Prisma user extension
  // would inject the ACTING user's customerId into the query.
  const platformEmails = new Set((await customerContext.exit(() =>
    prisma.user.findMany({ select: { email: true } }),
  )).map((u) => u.email.toLowerCase()).filter(Boolean));

  const rows = await getTicketDb().users.findMany({
    where: {
      isActive: true,
      NOT: { email: { endsWith: BOT_EMAIL_DOMAIN } },
    },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  return rows
    .filter((u) => u.email && platformEmails.has(u.email.toLowerCase()))
    .map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), email: u.email }));
}