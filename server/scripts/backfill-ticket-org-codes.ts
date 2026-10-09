/**
 * backfill:ticket-org-codes — give every legacy ticket a per-org number.
 *
 * When per-org ticket numbering shipped, the migrated stores still carried the
 * old GLOBAL sequence: 1514 tickets numbered TKT-00001…TKT-00566 with no org
 * segment, so no ticket in the app showed the org code it was created for. New
 * tickets are already coded (TKT-DB-001); this script renumbers the legacy rows
 * to match, per organization, in creation order.
 *
 *   npm run backfill:tickets -- --dry-run      # what WOULD change
 *   npm run backfill:tickets -- --apply --yes  # write + update main-DB refs
 *
 * Scope (deliberate): the SHARED store only — b2b_ticket. The admin store is out
 * of scope by decision. Audit logs and chat history keep their historical
 * numbers on purpose.
 *
 * Idempotent: rows whose number is already coded (`TKT-<CODE>-NNN`) or any
 * non `PREFIX-<digits>` form are left untouched, so re-running is a no-op.
 */
import 'dotenv/config';
import { prisma } from '../src/config/database';
import { ticketPrisma } from '../src/config/ticketDatabase';
import { env } from '../src/config/env';

const APPLY = process.argv.includes('--apply');
const YES = process.argv.includes('--yes');

const dbName = (url?: string): string => url?.split('/').pop()?.split('?')[0] ?? '(unset)';
const isPlainNumber = (n: string): boolean => /^[A-Z0-9]+-\d+$/.test(n.trim());
const CodedPattern = /^TKT-([A-Z0-9]+)-(\d+)$/;
const strip = (s?: string | null): string => (s ?? '').trim().toLowerCase();

async function main(): Promise<void> {
  console.log(`ticket:org-code backfill  target=${dbName(env.TICKET_DATABASE_URL)}  mode=${APPLY ? 'APPLY' : 'dry-run'}`);
  if (!env.TICKET_DATABASE_URL) throw new Error('TICKET_DATABASE_URL is unset — refusing to guess the store.');
  if (APPLY && !YES) throw new Error('About to REWRITE ticket numbers in the shared store. Add --yes to confirm you mean it.');

  // ── 1. Directory of organizations (main DB) ────────────────────────────────
  const customers = await prisma.customer.findMany({ select: { id: true, name: true, mailId: true, orgCode: true } });
  const customersWithCode = customers.filter((c) => c.orgCode);
  console.log(`  orgs in directory: ${customers.length} (${customersWithCode.length} with orgCode)`);

  // ── 2. Tickets + their org's code ─────────────────────────────────────────
  // The shared store holds a Customers row per organization created on demand;
  // match it by name/email, then fall back to the reporter's directory org.
  const tickets = await ticketPrisma.tickets.findMany({
    select: {
      id: true,
      ticketNumber: true,
      createdAt: true,
      customerId: true,
      reporterId: true,
      Customers: { select: { name: true, email: true } },
      Users_Tickets_reporterIdToUsers: { select: { email: true } },
    },
  });
  console.log(`  store tickets: ${tickets.length}`);

  const reporterEmails = [...new Set(tickets.map((t) => t.Users_Tickets_reporterIdToUsers?.email).filter(Boolean))];
  const b2bUsers = await prisma.user.findMany({
    where: { email: { in: reporterEmails as string[] } },
    select: { email: true, customerId: true },
  });
  const customerIdOfEmail = new Map(b2bUsers.map((u) => [u.email.toLowerCase(), u.customerId]));
  const orgCodeOfCustomer = new Map(customersWithCode.map((c) => [c.id, c.orgCode as string]));

  const orgCodeOf = (t: (typeof tickets)[number]): string | null => {
    const cust = t.Customers;
    if (cust) {
      const hit = customersWithCode.find(
        (c) => strip(c.name) === strip(cust.name) || (cust.email !== null && strip(c.mailId) === strip(cust.email)),
      );
      if (hit) return hit.orgCode as string;
    }
    const email = t.Users_Tickets_reporterIdToUsers?.email;
    const cid = email ? customerIdOfEmail.get(email.toLowerCase()) : undefined;
    return cid ? (orgCodeOfCustomer.get(cid) ?? null) : null;
  };

  const toRenumber = tickets
    .map((t) => ({ t, code: orgCodeOf(t) }))
    .filter((x): x is { t: (typeof tickets)[number]; code: string } => Boolean(x.code) && isPlainNumber(x.t.ticketNumber));
  console.log(`  legacy rows to renumber: ${toRenumber.length}`);
  const skipped = tickets.length - toRenumber.length;
  if (skipped) console.log(`  left untouched (already coded / no org resolved): ${skipped}`);

  // ── 3. Sequence allocation per org, independent of the global counter ──────
  // A coded number's trailing digits per org are its own sequence, so already
  // coded rows lock the digits they occupy. Seeded rows keep creation order so
  // the renumbered tickets read in the order they arrived.
  const usedByOrg = new Map<string, Set<number>>();
  for (const t of tickets) {
    const m = CodedPattern.exec(t.ticketNumber.trim());
    if (!m) continue;
    const s = usedByOrg.get(m[1]!) ?? new Set<number>();
    s.add(parseInt(m[2]!, 10));
    usedByOrg.set(m[1]!, s);
  }
  const plans: Array<{ id: string; old: string; code: string; next: string }> = [];
  const ordered = [...toRenumber].sort((a, b) =>
    a.t.createdAt.getTime() - b.t.createdAt.getTime() || (a.t.id < b.t.id ? -1 : 1));
  for (const { t, code } of ordered) {
    const used = usedByOrg.get(code) ?? new Set<number>();
    let seq = 1;
    while (used.has(seq)) seq++;
    used.add(seq);
    usedByOrg.set(code, used);
    plans.push({ id: t.id, old: t.ticketNumber.trim(), code, next: `TKT-${code}-${String(seq).padStart(3, '0')}` });
  }

  const byOrg = new Map<string, number>();
  for (const p of plans) byOrg.set(p.code, (byOrg.get(p.code) ?? 0) + 1);
  console.log('  per-org counts:');
  for (const [code, n] of [...byOrg.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${code}: ${n}`);
  console.log('  sample (first 10):');
  for (const p of plans.slice(0, 10)) console.log(`    ${p.old} → ${p.next}`);

  if (!APPLY) {
    console.log('\n  dry-run complete — re-run with --apply --yes to write.');
    return;
  }

  // ── 4. Write the store renumber ─────────────────────────────────────────
  const oldToNew = new Map(plans.map((p) => [p.old, p.next]));
  let written = 0;
  for (let i = 0; i < plans.length; i += 100) {
    const chunk = plans.slice(i, i + 100);
    await Promise.all(chunk.map((p) => ticketPrisma.tickets.update({ where: { id: p.id }, data: { ticketNumber: p.next } })));
    written += chunk.length;
    console.log(`    wrote ${written}/${plans.length}`);
  }

  // ── 5. Main-DB references keep pointing at the same ticket ─────────────
  for (const old of oldToNew.keys()) {
    const next = oldToNew.get(old)!;
    const sub = await prisma.botTicketSubmission.updateMany({ where: { ticketNumber: old }, data: { ticketNumber: next } });
    const del = await prisma.adCredentialDelivery.updateMany({ where: { ticketNumber: old }, data: { ticketNumber: next } });
    if (sub.count + del.count) console.log(`    refs ${old} → ${next} (${sub.count + del.count})`);
  }
  console.log('  main-DB references updated.');
  console.log(`\n  done — ${written} tickets renumbered.`);
}

main().catch((err) => { console.error(err); process.exit(1); });