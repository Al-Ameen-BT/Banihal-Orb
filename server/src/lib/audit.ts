import { prisma } from '../config/database';
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

/** Write an audit row. Blocking: a failure propagates and fails the request. */
export async function audit(entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action: entry.action,
      performedById: entry.performedById,
      targetId: entry.targetId ?? null,
      customerId: entry.customerId,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    },
  });
}
