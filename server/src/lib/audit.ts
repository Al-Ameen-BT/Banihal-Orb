import { prisma, customerContext } from '../config/database';
import type { AuditAction } from '../config/auditActions';

// ─── The audit writer ────────────────────────────────────────────────────────
// One way in, replacing hand-written prisma.auditLog.create calls that had
// drifted into two inconsistent behaviours: some swallowed failures with
// `.catch(() => {})` and some did not, and some logged BEFORE the mutation (so a
// failed update left a row for a change that never happened) while others logged
// after (so a failed write lost the record of a change that did).
//
// `action` is typed, so a typo is a compile error rather than a row nothing can
// ever query — the failure mode the old string literals had.

export interface AuditEntry {
  action: AuditAction;
  /** The actor. Null only for machine actors (AD ingest authenticates by API key). */
  performedById: string | null;
  /** What was acted ON, when that differs from the actor. */
  targetId?: string | null;
  /** Required by the schema: AuditLog.customerId is NOT NULL. */
  customerId: string;
  /**
   * Context for "what changed". NEVER put a secret here — no passwords, temp
   * passwords, tokens or decrypted credentials. Log THAT it happened, not the value.
   */
  metadata?: Record<string, unknown>;
}

// The AuditLog.performedById FK is ON DELETE SET NULL: deleting the actor's account
// later would anonymize every row they ever wrote — the "user" and "role" columns
// of the system-activity page collapse to '—'. Snapshot the identity into metadata
// at write time so the trail stays attributable after the account is gone. Resolved
// OUTSIDE the tenant context: an ADMINISTRATOR auditing another org's event must not
// have the performer lookup tenant-filtered away.
async function actorSnapshot(performedById: string | null): Promise<Record<string, string> | null> {
  if (!performedById) return null;
  const actor = await customerContext.exit(() =>
    prisma.user.findUnique({ where: { id: performedById }, select: { name: true, email: true, role: true } }),
  );
  return actor ? { performedByName: actor.name, performedByEmail: actor.email, performedByRole: actor.role } : null;
}

/** Write an audit row. Blocking: a failure propagates and fails the request. */
export async function audit(entry: AuditEntry): Promise<void> {
  const actor = await actorSnapshot(entry.performedById);
  await prisma.auditLog.create({
    data: {
      action: entry.action,
      performedById: entry.performedById,
      targetId: entry.targetId ?? null,
      customerId: entry.customerId,
      metadata: { ...entry.metadata, ...actor },
    },
  });
}