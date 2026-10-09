import type { Role } from '@prisma/client';
import { prisma, customerContext } from '../../config/database';
import { getTicketDb, getTicketDbScope } from '../../config/ticketDatabase';
import { BOT_EMAIL_DOMAIN } from './ticketing.client';

// ─── Identity bridge ─────────────────────────────────────────────────────────
// The B2B-Site login is the source of truth. The full ticketing schema has its
// OWN Users table (admin/manager/developer/tester) referenced by reporterId /
// assigneeId / createdBy / Activities.userId. We lazily upsert a ticketing Users
// row for each B2B user (keyed by email) and map the platform role onto a
// ticketing staff role. Bridged users never log into the ticketing system
// directly — `password` is a non-usable sentinel.

type TicketStaffRole = 'admin' | 'manager' | 'developer' | 'tester';

// Platform RBAC → ticketing staff role.
const ROLE_MAP: Record<Role, TicketStaffRole> = {
  ADMINISTRATOR: 'admin',
  ORG_ADMIN: 'manager',
  USER: 'developer',
};

// Direct ticketing-system login is bypassed for bridged users; this sentinel can
// never match a bcrypt check, so the client portal / staff login stays closed.
const BRIDGED_PASSWORD = '__sso_bridged__';

// scope+email → ticketing Users.id (avoids an upsert on every request). Keyed by
// DB scope too: the SAME email maps to DIFFERENT Users.id rows in the shared vs
// admin ticket stores, so the caches must never collide.
const cache = new Map<string, string>();

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  const firstName = parts.shift() || name || 'User';
  return { firstName, lastName: parts.join(' ') || '' };
}

export interface TicketActor {
  id: string;            // ticketing Users.id
  role: TicketStaffRole;
}

/**
 * Resolve (and lazily provision) the ticketing Users row for a B2B-Site user.
 * Returns the ticketing user id + mapped staff role.
 */
export async function resolveTicketActor(b2bUserId: string, platformRole: Role): Promise<TicketActor> {
  const role = ROLE_MAP[platformRole] ?? 'developer';

  const b2bUser = await prisma.user.findUnique({
    where: { id: b2bUserId },
    select: { name: true, email: true },
  });
  if (!b2bUser) throw Object.assign(new Error('User not found'), { status: 401, code: 'AUTH_REQUIRED' });

  const email = b2bUser.email.toLowerCase();
  // Key the cache by the ACTIVE DB scope (not the role): escalation bridges an
  // ORG_ADMIN into the admin store too, so the same email is a different Users.id
  // row depending on which store the current AsyncLocalStorage scope selects.
  const cacheKey = `${getTicketDbScope()}:${email}`;
  const cached = cache.get(cacheKey);
  if (cached) return { id: cached, role };

  const { firstName, lastName } = splitName(b2bUser.name);
  const row = await getTicketDb().users.upsert({
    where: { email },
    create: { email, firstName, lastName, password: BRIDGED_PASSWORD, role },
    update: { role, firstName, lastName, lastLogin: new Date() },
    select: { id: true },
  });
  cache.set(cacheKey, row.id);
  return { id: row.id, role };
}

// ─── Reverse bridge: ticketing Users.id → B2B-Site account ───────────────────
// Web Push is addressed to a B2B-Site account (userId + tenantId), but ticketing
// only ever knows its own Users.id. Map back through email — the same key the
// forward bridge above uses. Rows with no human behind them (Slack bots, staff
// created natively in the ticketing system) simply resolve to null.

export interface B2bIdentity {
  userId: string;    // b2b_saas User.id
  tenantId: string;  // that user's customerId — the PushSubscription tenant key
}

// scope+ticketUserId → b2b identity. Only POSITIVE results are cached: a null can
// become resolvable later (the person registers / is bridged), and assignments are
// rare enough that re-querying two indexed columns costs nothing.
const reverseCache = new Map<string, B2bIdentity>();

export async function resolveB2bIdentity(ticketUserId: string): Promise<B2bIdentity | null> {
  const cacheKey = `${getTicketDbScope()}:${ticketUserId}`;
  const cached = reverseCache.get(cacheKey);
  if (cached) return cached;

  const row = await getTicketDb().users.findUnique({
    where: { id: ticketUserId },
    select: { email: true },
  });
  if (!row?.email || row.email.endsWith(BOT_EMAIL_DOMAIN)) return null;

  // Resolved OUTSIDE the tenant context: the Prisma extension would inject the
  // ACTING user's customerId, and the shared ticket store's assignee pool spans
  // organizations. Safe — the only fields read are the recipient's own id and
  // customerId, purely to address a notification to them.
  const b2bUser = await customerContext.exit(() =>
    prisma.user.findFirst({
      where: { email: { equals: row.email, mode: 'insensitive' } },
      select: { id: true, customerId: true },
    }),
  );
  if (!b2bUser) return null;

  const identity: B2bIdentity = { userId: b2bUser.id, tenantId: b2bUser.customerId };
  reverseCache.set(cacheKey, identity);
  return identity;
}
