import type { Role } from '@prisma/client';
import { prisma } from '../../config/database';
import { getTicketDb, getTicketDbScope } from '../../config/ticketDatabase';

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
