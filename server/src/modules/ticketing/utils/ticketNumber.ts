import { ticketPrisma } from '../../../config/ticketDatabase';
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

  // Match by literal prefix via left()/= — NOT LIKE (a '_' separator would act as
  // a wildcard) and NOT a SQL regex (the external ticket DB mangles backslash
  // escapes). Parse the trailing digit run in JS to find the current max.
  const rows = await ticketPrisma.$queryRaw<{ ticketNumber: string }[]>`
    SELECT "ticketNumber" FROM "Tickets" WHERE left("ticketNumber", ${base.length}) = ${base}`;

  let max = 0;
  for (const r of rows) {
    const m = /(\d+)\s*$/.exec(r.ticketNumber);
    if (m) { const n = parseInt(m[1]!, 10); if (Number.isFinite(n) && n > max) max = n; }
  }
  const next = max + 1;
  return `${base}${String(next).padStart(fmt.padWidth, '0')}`;
}
