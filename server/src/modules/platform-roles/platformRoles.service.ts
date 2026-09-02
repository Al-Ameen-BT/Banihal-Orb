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
// Staleness is bounded two ways — a 60s TTL so a second API instance converges on
// its own, and an explicit bust() on every write in this process. A role
// REASSIGNMENT is separately bounded by the 15-minute access-token lifetime,
// exactly as the `role` claim already is; where that matters the caller deletes
// the target's refresh tokens, which kills the session on the next request.

const TTL_MS = 60_000;

interface Snapshot { byId: Map<string, Set<PermissionKey>>; keyById: Map<string, string>; at: number }
let snapshot: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;

async function load(): Promise<Snapshot> {
  const rows = await prisma.platformRole.findMany({
    select: { id: true, key: true, permissions: true },
  });

  const byId = new Map<string, Set<PermissionKey>>();
  const keyById = new Map<string, string>();

  for (const row of rows) {
    keyById.set(row.id, row.key);
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

  return { byId, keyById, at: Date.now() };
}

/** Collapse concurrent misses onto one query rather than a thundering herd. */
async function current(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.at < TTL_MS) return snapshot;
  if (!inflight) {
    inflight = load()
      .then((s) => { snapshot = s; return s; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Drop the cache after a write so this process sees the change immediately. */
export function bustRoleCache(): void {
  snapshot = null;
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

/** The role's stable key (`administration`, `intern`, …), or null. */
export async function roleKeyFor(platformRoleId: string | null): Promise<string | null> {
  if (!platformRoleId) return null;
  const { keyById } = await current();
  return keyById.get(platformRoleId) ?? null;
}

// ─── Reads for the roles matrix ──────────────────────────────────────────────

export async function listRoles() {
  const rows = await prisma.platformRole.findMany({
    orderBy: [{ system: 'desc' }, { name: 'asc' }],
    select: { id: true, key: true, name: true, description: true, system: true, permissions: true, createdAt: true },
  });

  const counts = await prisma.user.groupBy({
    by: ['platformRoleId'],
    _count: { _all: true },
    where: { platformRoleId: { not: null } },
  });
  const memberCount = new Map(counts.map((c) => [c.platformRoleId, c._count._all]));

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
    // Administration's column is rendered locked in the UI; this says why.
    locked: r.key === ADMINISTRATION_ROLE_KEY,
    members: memberCount.get(r.id) ?? 0,
    createdAt: r.createdAt,
  }));
}
