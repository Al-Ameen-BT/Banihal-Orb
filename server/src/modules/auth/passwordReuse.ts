import crypto from 'crypto';
import { prisma } from '../../config/database';
import { env } from '../../config/env';

// ─── Password-reuse detection ────────────────────────────────────────────────
// WHY a separate value instead of comparing passwordHash: bcrypt uses a random salt per
// hash, so two accounts with the SAME password store completely different hashes. Reuse
// is therefore undetectable from passwordHash alone.
//
// Instead we record a keyed fingerprint — HMAC-SHA256(pepper, password) — whenever the
// plaintext legitimately passes through (register / change / reset). Identical passwords
// produce an identical fingerprint, so reuse becomes a plain indexed lookup. The value is
// one-way and useless without the pepper, which lives in env (never in the database).
//
// Trade-off worth knowing: it IS deterministic. If both the database and the pepper leak,
// an attacker can group accounts that share a password. That is the unavoidable cost of
// being able to answer "is this password used by more than one user?" at all.

const PEPPER = env.PASSWORD_PEPPER ?? env.JWT_ACCESS_SECRET;

/** One-way, deterministic fingerprint used only for reuse detection. */
export function passwordFingerprint(password: string): string {
  return crypto.createHmac('sha256', PEPPER).update(password, 'utf8').digest('hex');
}

const reused = () => Object.assign(
  new Error('That password is already in use by another account. Please choose a different one.'),
  { status: 409, code: 'PASSWORD_REUSED' },
);

/**
 * Throw when ANY other account already uses this password (platform-wide).
 *
 * Uses $queryRaw deliberately: the tenant Prisma extension in config/database.ts
 * auto-injects `customerId` into model queries on `User`, which would silently narrow
 * this to the caller's own organization. Client-level raw queries bypass that extension,
 * keeping the check global as intended.
 */
export async function assertPasswordNotReused(password: string, excludeUserId?: string): Promise<void> {
  const fingerprint = passwordFingerprint(password);
  // cuid ids never equal '' — the sentinel keeps a single SQL shape for both cases.
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "User"
     WHERE "passwordFingerprint" = ${fingerprint}
       AND "id" <> ${excludeUserId ?? ''}
     LIMIT 1`;
  if (rows.length > 0) throw reused();
}
