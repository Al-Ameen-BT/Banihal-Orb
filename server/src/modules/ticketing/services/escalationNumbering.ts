import type { NumberFormat } from './numberFormat';
import { getTicketNumberFormat } from './numberFormat';
import { getTicketDb } from '../../../config/ticketDatabase';

// Validation system for the escalated-copy numbering scheme.
//
// An escalated copy is written into the platform ADMIN store with its ORIGIN org's
// code and must CONTINUE that org's per-store sequence: TKT-<ORGCODE>-001, -002, …
// (nextTicketNumber extends the max of every `TKT-<ORGCODE>-` row in the store).
// This module scans a ticket store and reports anything that broke the scheme:
//   - copies with NO org segment — the historical bug where an org with no stored
//     orgCode row made the copy fall into the admin store's GLOBAL TKT-NNN counter;
//   - per-org sequence gaps or duplicated numbers.
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
  /** Sequence numbers missing between 1 and maxSeq (continuity broken). */
  gaps: number[];
  /** Sequence numbers that appear more than once. */
  duplicatedSeqs: number[];
}

export interface EscalationValidationReport {
  ok: boolean;
  /** All org-coded tickets in the store — the sequence nextTicketNumber extends. */
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
      ?? { orgCode: parsed.orgCode, numbers: [], seqs: [], maxSeq: 0, count: 0, gaps: [], duplicatedSeqs: [] };
    g.numbers.push(t.ticketNumber);
    g.seqs.push(parsed.seq);
    byOrg.set(parsed.orgCode, g);
  }

  const groups: OrgSequence[] = [];
  for (const g of byOrg.values()) {
    g.seqs.sort((a, b) => a - b);
    g.maxSeq = g.seqs[g.seqs.length - 1] ?? 0;
    g.count = g.seqs.length;
    const seen = new Map<number, number>();
    for (const s of g.seqs) seen.set(s, (seen.get(s) ?? 0) + 1);
    g.duplicatedSeqs = [...seen.entries()].filter(([, n]) => n > 1).map(([s]) => s);
    g.gaps = [];
    for (let seq = 1; seq <= g.maxSeq; seq++) if (!seen.has(seq)) g.gaps.push(seq);
    groups.push(g);
  }
  groups.sort((a, b) => a.orgCode.localeCompare(b.orgCode));

  const ok = uncodedCopies.length === 0 && groups.every((g) => g.gaps.length === 0 && g.duplicatedSeqs.length === 0);
  return { ok, groups, uncodedCopies, copiesExamined };
}