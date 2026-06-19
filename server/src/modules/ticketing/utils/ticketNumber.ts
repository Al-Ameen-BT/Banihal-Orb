import { ticketPrisma } from '../../../config/ticketDatabase';

// Ticket number generation (report §7.1): TKT-NNN, zero-padded to 3, derived from
// the highest existing numeric suffix. Robust past 999 (parses the digits, not a
// lexical sort). Pair with a unique-violation retry loop in the create path.
export async function nextTicketNumber(): Promise<string> {
  const rows = await ticketPrisma.$queryRawUnsafe<{ max: number | null }[]>(
    `SELECT MAX(NULLIF(regexp_replace("ticketNumber", '\\D', '', 'g'), '')::int) AS max FROM "Tickets"`,
  );
  const next = (rows[0]?.max ?? 0) + 1;
  return `TKT-${String(next).padStart(3, '0')}`;
}
