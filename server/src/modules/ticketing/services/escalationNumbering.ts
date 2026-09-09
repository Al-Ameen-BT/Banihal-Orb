import type { NumberFormat } from './numberFormat';
import { getTicketNumberFormat } from './numberFormat';
import { getTicketDb } from '../../../config/ticketDatabase';

// Validation system for the escalated-copy numbering scheme.
//
// An escalated copy is written into the platform ADMIN store with its ORIGIN org's
// code (TKT-<ORGCODE>-NNN) and the DIGITS continue the STORE-WIDE master sequence
// (nextGlobalTicketNumber: max digit of ANY admin ticket + 1) — platform-created
// tickets (TKT-001, …) and escalated copies (TKT-DVB-002, …) share one clock. The
// org-coded per-org series that nextGlobalTicketNumber replaces is gone, so per-org
// gaps in the admin store are EXPECTED and NOT a violation.
// This module scans a ticket store and reports the one thing that still breaks the
// scheme: copies with NO org segment — the historical bug where an org with no stored
// orgCode row made the copy fall into the admin store's plain TKT-NNN counter.
// runWithTicketDb('admin', () => validateEscalationNumbering()) checks the platform
// store; the shared store can be checked the same way.

export interface ParsedTicketNumber {
  orgCode: string;
  seq: number;
}

// Parse "PREFIX sep ORGCODE sep <digits>" with the configured format (e.g. TKT-NFG-001).
// Returns null for plain global numbers (TKT-012) or anything unrelated.
export function parseEscalationNumber(num: string, fmt: NumberFormat): ParsedTicketNumber | null {
  if (!fmt.includeOrgCode || !num) return null;
  const esc = fmt.separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${fmt.prefix}${esc}([A-Z0-9]{1,6})${esc}(\\d+)$`);
  const m = re.exec(num.trim());
  if (!m) return null;
  const seq = parseInt(m[2]!, 10);
  if (!Number.isFinite(seq)) return null;
  return { orgCode: m[1]!, seq };
}

// Escalated copies carry a `src:<sourceNumber>` label (the source keeps only
// `escalated`), so a copy is unambiguously identifiable in either store.
export const isEscalationCopy = (labels: string[]): boolean => labels.some((l) => l.startsWith('src:'));

export interface OrgSequence {
  orgCode: string;
  numbers: string[];
  seqs: number[];
  maxSeq: number;
  count: number;
}

export interface EscalationValidationReport {
  ok: boolean;
  /** All org-coded tickets in the store, grouped per org (for reporting only — the
   *  digits are drawn from the global clock, so per-org gaps are by design). */
  groups: OrgSequence[];
  /** Escalated copies (have a src: label) whose number has NO org segment. */
  uncodedCopies: { ticketNumber: string }[];
  /** Count of escalated copies examined. */
  copiesExamined: number;
}

export async function validateEscalationNumbering(format?: NumberFormat): Promise<EscalationValidationReport> {
  const fmt = format ?? (await getTicketNumberFormat());
  const tickets = await getTicketDb().tickets.findMany({ select: { ticketNumber: true, labels: true } });

  const byOrg = new Map<string, OrgSequence>();
  const uncodedCopies: { ticketNumber: string }[] = [];
  let copiesExamined = 0;

  for (const t of tickets) {
    const isCopy = isEscalationCopy(t.labels);
    if (isCopy) copiesExamined++;
    const parsed = parseEscalationNumber(t.ticketNumber, fmt);
    if (!parsed) {
      // A copy with no parseable org segment is the numbering leak we guard against.
      if (isCopy) uncodedCopies.push({ ticketNumber: t.ticketNumber });
      continue;
    }
    const g = byOrg.get(parsed.orgCode)
      ?? { orgCode: parsed.orgCode, numbers: [], seqs: [], maxSeq: 0, count: 0 };
    g.numbers.push(t.ticketNumber);
    g.seqs.push(parsed.seq);
    byOrg.set(parsed.orgCode, g);
  }

  const groups: OrgSequence[] = [];
  for (const g of byOrg.values()) {
    g.seqs.sort((a, b) => a - b);
    g.maxSeq = g.seqs[g.seqs.length - 1] ?? 0;
    g.count = g.seqs.length;
    groups.push(g);
  }
  groups.sort((a, b) => a.orgCode.localeCompare(b.orgCode));

  const ok = uncodedCopies.length === 0;
  return { ok, groups, uncodedCopies, copiesExamined };
}