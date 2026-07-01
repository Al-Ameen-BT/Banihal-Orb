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
  const next = max + 1;
  return `${base}${String(next).padStart(fmt.padWidth, '0')}`;
}
