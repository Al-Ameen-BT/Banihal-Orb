import { prisma } from '../../config/database';
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
