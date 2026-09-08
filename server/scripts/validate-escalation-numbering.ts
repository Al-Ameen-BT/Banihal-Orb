/**
 * validate:escalations — integrity check for escalated-ticket numbering.
 *
 * Every escalated copy in the platform ADMIN store must keep its origin org's code
 * and CONTINUE that org's per-store sequence (TKT-<ORGCODE>-NNN). This scans the
 * admin store and reports:
 *   - escalated copies with NO org segment (numbering leak into the global TKT-NNN
 *     counter — what happens when an org has no stored orgCode row),
 *   - per-org sequence gaps and duplicated numbers,
 * and exits nonzero when anything is violated.
 *
 *   npm run validate:escalations
 */
import 'dotenv/config';
import { runWithTicketDb } from '../src/config/ticketDatabase';
import { validateEscalationNumbering } from '../src/modules/ticketing/services/escalationNumbering';
import { getTicketNumberFormat } from '../src/modules/ticketing/services/numberFormat';

async function main(): Promise<void> {
  const fmt = await getTicketNumberFormat();
  const report = await runWithTicketDb('admin', () => validateEscalationNumbering());

  const width = Math.max(5, ...report.groups.map((g) => g.orgCode.length), 'org-code'.length);
  const sep = '─'.repeat(width + 4 + 'seq range'.length);

  console.log(`escalation-numbering validation  target=admin store  format=${fmt.prefix}-<ORG>-<NNN>`);
  console.log(`  escalated copies examined: ${report.copiesExamined}`);
  console.log(`  org-coded groups:          ${report.groups.length}`);
  console.log(sep);
  console.log(`  ${'org-code'.padEnd(width)}  seq range`);
  if (report.groups.length === 0) console.log('  (none)');
  for (const g of report.groups) {
    const range = `1..${g.maxSeq}` + (g.gaps.length ? `  GAPS: ${g.gaps.join(',')}` : '') + (g.duplicatedSeqs.length ? `  DUPS: ${g.duplicatedSeqs.join(',')}` : '');
    console.log(`  ${g.orgCode.padEnd(width)}  ${range}`);
  }
  console.log(sep);

  if (report.uncodedCopies.length) {
    console.error(`FAIL: ${report.uncodedCopies.length} escalated copy/copies lost the org segment:`);
    for (const c of report.uncodedCopies) console.error(`  - ${c.ticketNumber}`);
  }
  const broken = report.groups.filter((g) => g.gaps.length || g.duplicatedSeqs.length);
  if (broken.length) {
    console.error(`FAIL: ${broken.length} org sequence(s) are not contiguous 1..N:`);
    for (const g of broken) {
      console.error(`  - ${g.orgCode}: gaps=[${g.gaps.join(',')}] dups=[${g.duplicatedSeqs.join(',')}]`);
    }
  }

  if (report.ok) {
    console.log('OK: every escalated copy is org-coded and every per-org sequence is contiguous.');
    return;
  }
  process.exitCode = 1;
  console.error(`Validation FAILED — renumber via the ticket:org-code backfill (--apply) after fixing orgCode rows, ` +
    `or delete the offending copy if it was created before the resolveOrgCode fallback shipped.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});