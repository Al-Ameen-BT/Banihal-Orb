import { prisma } from '../../config/database';
import { audit } from '../../lib/audit';
import {
  ALL_PERMISSION_KEYS,
  ADMINISTRATION_ROLE_KEY,
  isPermissionKey,
  type PermissionKey,
} from '../../config/permissions';

// ─── Platform role resolution ────────────────────────────────────────────────
// Resolves a platformRoleId to the permission keys it grants. This runs on EVERY
// authenticated request (auth.middleware), so it is served from a process-local
// map rather than a query: the table has at most a handful of rows and changes
// only when an administrator edits the matrix.
//
// Staleness is bounded by a 60s TTL, so an edit on one API instance reaches the
// others within a minute. A role REASSIGNMENT is separately bounded by the
// 15-minute access-token lifetime, exactly as the `role` claim already is; where
// that matters the caller deletes the target's refresh tokens, which kills the
// session on the next request.
//
// The role-editor writes land in P6 and will want an explicit cache bust; add it
// then, next to the code that writes.

const TTL_MS = 60_000;

interface Snapshot { byId: Map<string, Set<PermissionKey>>; at: number }
let snapshot: Snapshot | null = null;

async function load(): Promise<Snapshot> {
  const rows = await prisma.platformRole.findMany({
    select: { id: true, key: true, permissions: true },
  });

  const byId = new Map<string, Set<PermissionKey>>();

  for (const row of rows) {
    // Administration's permissions are NEVER read from the column. Computing them
    // is what makes the role impossible to strip, and what makes a newly-shipped
    // key automatically held rather than needing a data migration.
    if (row.key === ADMINISTRATION_ROLE_KEY) {
      byId.set(row.id, new Set(ALL_PERMISSION_KEYS));
      continue;
    }
    // Unknown keys are dropped rather than trusted: a key removed from the code
    // registry must stop granting anything, even while stale rows still name it.
    const stored = Array.isArray(row.permissions) ? row.permissions : [];
    byId.set(row.id, new Set(stored.filter((k): k is PermissionKey => typeof k === 'string' && isPermissionKey(k))));
  }

  return { byId, at: Date.now() };
}

async function current(): Promise<Snapshot> {
  if (!snapshot || Date.now() - snapshot.at >= TTL_MS) snapshot = await load();
  return snapshot;
}

/**
 * The permission keys a platform role grants. Unknown or null id → empty set, so
 * a user whose role was deleted holds nothing rather than everything.
 */
export async function permissionsFor(platformRoleId: string | null): Promise<Set<PermissionKey>> {
  if (!platformRoleId) return new Set();
  const { byId } = await current();
  return byId.get(platformRoleId) ?? new Set();
}

/**
 * Every platform staff member who holds `key` — the people to notify when a
 * decision needs one of them.
 *
 * Resolved through the same snapshot `permissionsFor` uses, so Administration is
 * included automatically: its permissions are computed as the whole registry, and
 * re-deriving that rule in a JSONB query would mean a second place to keep in sync
 * (and would silently miss administrators, since their stored column is '[]').
 *
 * The `role: 'ADMINISTRATOR'` filter is a security boundary, not an optimisation.
 * can() in rbac.middleware refuses every customer role before it looks at
 * permissions, so an ORG_ADMIN carrying a stale platformRoleId must never be
 * selected here — otherwise a customer would receive platform-staff mail.
 */
export async function usersWithPermission(key: PermissionKey): Promise<
  { id: string; name: string; email: string; customerId: string }[]
> {
  const { byId } = await current();
  const roleIds = [...byId.entries()].filter(([, keys]) => keys.has(key)).map(([id]) => id);
  if (roleIds.length === 0) return [];

  return prisma.user.findMany({
    where: { role: 'ADMINISTRATOR', platformRoleId: { in: roleIds } },
    select: { id: true, name: true, email: true, customerId: true },
    orderBy: { email: 'asc' },
  });
}

// ─── Reads for the roles matrix ──────────────────────────────────────────────

export async function listRoles() {
  const rows = await prisma.platformRole.findMany({
    orderBy: [{ system: 'desc' }, { name: 'asc' }],
    select: { id: true, key: true, name: true, description: true, system: true, permissions: true, createdAt: true },
  });

  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    system: r.system,
    // Report Administration's effective (computed) set, not its empty column —
    // the matrix must show what the role actually grants.
    permissions: r.key === ADMINISTRATION_ROLE_KEY
      ? [...ALL_PERMISSION_KEYS]
      : (Array.isArray(r.permissions) ? r.permissions.filter((k): k is string => typeof k === 'string') : []),
    createdAt: r.createdAt,
  }));
}

// ─── Writes ──────────────────────────────────────────────────────────────────
// Every write busts the snapshot so the editing instance sees its own change at
// once; other instances converge within the TTL above.

const bust = (): void => { snapshot = null; };

const badRequest = (msg: string, code: string) =>
  Object.assign(new Error(msg), { status: 400, code });

/** Reject anything that is not a known permission key. */
function validateKeys(keys: string[]): PermissionKey[] {
  const bad = keys.filter((k) => !isPermissionKey(k));
  if (bad.length) throw badRequest(`Unknown permission keys: ${bad.join(', ')}`, 'UNKNOWN_PERMISSION');
  return keys as PermissionKey[];
}

/**
 * No privilege escalation: you cannot hand out a key you do not hold yourself.
 *
 * Without this, `roles.manage` and `staff.invite` are each a path to full
 * platform access — an HR Admin holds both by default and could mint an
 * Administration account, or simply add the missing keys to their own role.
 * Administration holds every key, so this never constrains them.
 */
function assertGrantable(granted: Iterable<string>, holder: Set<PermissionKey>): void {
  const over = [...granted].filter((k) => !holder.has(k as PermissionKey));
  if (over.length) {
    throw Object.assign(
      new Error(`You cannot grant permissions you do not hold: ${over.join(', ')}`),
      { status: 403, code: 'PERMISSION_DENIED' },
    );
  }
}

/** Assert the caller may put someone into `platformRoleId`. Used by staff invite + edit. */
export async function assertRoleAssignable(platformRoleId: string, holder: Set<PermissionKey>): Promise<void> {
  const row = await prisma.platformRole.findUnique({ where: { id: platformRoleId }, select: { key: true } });
  if (!row) throw badRequest('Unknown platform role', 'UNKNOWN_ROLE');
  // Administration's set is computed, so read it the same way can() would.
  const target = row.key === ADMINISTRATION_ROLE_KEY ? ALL_PERMISSION_KEYS : [...(await permissionsFor(platformRoleId))];
  assertGrantable(target, holder);
}

export async function createRole(
  input: { key: string; name: string; description?: string | null; permissions: string[] },
  holder: Set<PermissionKey>,
  actor: { userId: string; customerId: string },
) {
  const keys = validateKeys(input.permissions);
  assertGrantable(keys, holder);
  if (input.key === ADMINISTRATION_ROLE_KEY) throw badRequest('That role key is reserved', 'RESERVED_KEY');

  const existing = await prisma.platformRole.findUnique({ where: { key: input.key }, select: { id: true } });
  if (existing) throw Object.assign(new Error('A role with that key already exists'), { status: 409, code: 'DUPLICATE_KEY' });

  const row = await prisma.platformRole.create({
    data: { key: input.key, name: input.name, description: input.description ?? null, permissions: keys, system: false },
    select: { id: true, key: true, name: true, description: true, system: true, permissions: true, createdAt: true },
  });
  // Creating a role IS a permission grant — it decides who can hold users.manage
  // or credentials.reveal. Unlogged before this.
  await audit({
    action: 'ROLE_CREATED', performedById: actor.userId, targetId: row.id, customerId: actor.customerId,
    metadata: { key: row.key, name: row.name, permissions: keys },
  });
  bust();
  return row;
}

export async function updateRole(
  id: string,
  input: { name?: string; description?: string | null; permissions?: string[] },
  holder: Set<PermissionKey>,
  actor: { userId: string; customerId: string },
) {
  const row = await prisma.platformRole.findUnique({ where: { id }, select: { key: true, name: true, permissions: true } });
  if (!row) throw Object.assign(new Error('Role not found'), { status: 404, code: 'NOT_FOUND' });

  // Administration is not editable. Its permissions are computed, never stored,
  // so an edit would be a silent no-op — and the point of the role is that it
  // cannot be stripped, including by itself.
  if (row.key === ADMINISTRATION_ROLE_KEY) {
    throw Object.assign(new Error('The Administration role cannot be edited'), { status: 400, code: 'ROLE_IMMUTABLE' });
  }

  const data: { name?: string; description?: string | null; permissions?: PermissionKey[] } = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.permissions !== undefined) {
    const keys = validateKeys(input.permissions);
    assertGrantable(keys, holder);
    data.permissions = keys;
  }

  const updated = await prisma.platformRole.update({
    where: { id }, data,
    select: { id: true, key: true, name: true, description: true, system: true, permissions: true, createdAt: true },
  });
  // The BEFORE set is the point: "who can do what changed" is unanswerable from
  // the after-image alone.
  await audit({
    action: 'ROLE_UPDATED', performedById: actor.userId, targetId: id, customerId: actor.customerId,
    metadata: { key: row.key, changes: input, previousPermissions: row.permissions },
  });
  bust();
  return updated;
}

export async function deleteRole(id: string, actor: { userId: string; customerId: string }) {
  const row = await prisma.platformRole.findUnique({ where: { id }, select: { key: true, name: true, system: true, permissions: true } });
  if (!row) throw Object.assign(new Error('Role not found'), { status: 404, code: 'NOT_FOUND' });
  if (row.system) throw badRequest('Seeded roles cannot be deleted', 'ROLE_SYSTEM');

  // A user whose role vanished resolves to an empty permission set, which is safe
  // but silently strips them. Refuse instead — reassign first.
  const inUse = await prisma.user.count({ where: { platformRoleId: id } });
  if (inUse > 0) throw badRequest(`${inUse} staff account(s) still hold this role`, 'ROLE_IN_USE');

  // Captured before the row is gone — otherwise the log cannot say what was lost.
  await audit({
    action: 'ROLE_DELETED', performedById: actor.userId, targetId: id, customerId: actor.customerId,
    metadata: { key: row.key, name: row.name, permissions: row.permissions },
  });
  await prisma.platformRole.delete({ where: { id } });
  bust();
}
