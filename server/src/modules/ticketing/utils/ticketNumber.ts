import { getTicketDb } from '../../../config/ticketDatabase';
import type { NumberFormat } from '../services/numberFormat';

// Ticket number generation: build a base from the configured format
// (PREFIX[sep ORGCODE] sep) and append the next zero-padded sequence for that
// base. When the org code is included the base is org-specific, so each org
// counts independently (TKT-DVB-001, TKT-DVB-002, TKT-ACME-001). Pair with the
// unique-violation retry loop in the create path.
export async function nextTicketNumber(fmt: NumberFormat, orgCode: string | null): Promise<string> {
  const segs = [fmt.prefix];
  if (fmt.includeOrgCode && orgCode) segs.push(orgCode);
  const base = segs.join(fmt.separator) + fmt.separator; // e.g. "TKT-DVB-"
  const next = (await maxSeqForBase(base)) + 1;
  return `${base}${String(next).padStart(fmt.padWidth, '0')}`;
}

// Number allocation for ESCALATED COPIES in the ADMIN store. The copy keeps its
// origin org's code, but the DIGITS continue the WHOLE store's master sequence —
// not a per-org one. Platform-created tickets (TKT-001, TKT-002, …) and escalated
// copies (TKT-DVB-003, TKT-ACME-004, …) all advance one shared clock: the next
// escalated ticket always gets max(digit of every admin ticket) + 1. That is the
// contract administrators rely on: "last platform number was N, so this org copy is
// N+1". `minSeq` lets the create retry-loop walk past a legacy collision that shares
// the digit range (an org that already holds TKT-<CODE>-050 while the store-wide max
// is lower): without it the retry would recompute the same candidate forever.
export async function nextGlobalTicketNumber(fmt: NumberFormat, orgCode: string | null, minSeq?: number): Promise<string> {
  const base = fmt.prefix + fmt.separator; // e.g. "TKT-" — every ticket in the store
  const next = Math.max((await maxSeqForBase(base)) + 1, minSeq ?? 0);
  const segs = [fmt.prefix];
  if (fmt.includeOrgCode && orgCode) segs.push(orgCode);
  const name = segs.join(fmt.separator) + fmt.separator;
  return `${name}${String(next).padStart(fmt.padWidth, '0')}`;
}

// Max trailing sequence digit among every `TKT-`-prefixed number in the current
// store, 0 when the store is empty. Drivers: per-org numbering scans the org base
// (TKT-DVB-), escalation copies scan the whole store (TKT-) so they share the
// platform clock. Pair with the unique-violation retry loop in the callers.
async function maxSeqForBase(base: string): Promise<number> {
  // Match by literal prefix via starts_with() — NOT LIKE (a '_' separator would
  // act as a wildcard), NOT a SQL regex (the external ticket DB mangles backslash
  // escapes), and NOT left(col, n) (Prisma binds the JS length as bigint and
  // Postgres has no left(varchar, bigint)). Parse the trailing digits in JS.
  const rows = await getTicketDb().$queryRaw<{ ticketNumber: string }[]>`
    SELECT "ticketNumber" FROM "Tickets" WHERE starts_with("ticketNumber", ${base})`;

  let max = 0;
  for (const r of rows) {
    const m = /(\d+)\s*$/.exec(r.ticketNumber);
    if (m) { const n = parseInt(m[1]!, 10); if (Number.isFinite(n) && n > max) max = n; }
  }
  return max;
}
