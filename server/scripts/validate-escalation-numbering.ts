/**
 * validate:escalations — integrity check for escalated-ticket numbering.
 *
 * Every escalated copy in the platform ADMIN store must keep its origin org's code
 * and the digits continue the admin store's MASTER sequence (nextGlobalTicketNumber:
 * max digit of ANY admin ticket + 1), so platform-created tickets and org copies share
 * one clock. Per-org series are gone — per-org gaps in the admin store are BY DESIGN.
 * This scans the admin store and reports the one violation that still breaks the
 * scheme: escalated copies with NO org segment (the numbering leak into the plain
 * TKT-NNN counter — what happens when an org has no stored orgCode row).
 * Exits nonzero when anything is violated.
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

  console.log(`escalation-numbering validation  target=admin store  format=${fmt.prefix}-<ORG>-<global NNN>`);
  console.log(`  escalated copies examined: ${report.copiesExamined}`);
  console.log(`  org-coded groups:          ${report.groups.length}`);
  console.log(sep);
  console.log(`  ${'org-code'.padEnd(width)}  copies`);
  if (report.groups.length === 0) console.log('  (none)');
  for (const g of report.groups) {
    const range = `seq max ${g.maxSeq} (${g.count} number${g.count === 1 ? '' : 's'}, digits from the store-wide master clock)`;
    console.log(`  ${g.orgCode.padEnd(width)}  ${range}`);
  }
  console.log(sep);

  if (report.uncodedCopies.length) {
    console.error(`FAIL: ${report.uncodedCopies.length} escalated copy/copies lost the org segment:`);
    for (const c of report.uncodedCopies) console.error(`  - ${c.ticketNumber}`);
  }

  if (report.ok) {
    console.log('OK: every escalated copy kept its org code and shares the admin store master sequence.');
    return;
  }
  process.exitCode = 1;
  console.error(`Validation FAILED — fix the offending copies (they were created before the resolveOrgCode fallback shipped).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});