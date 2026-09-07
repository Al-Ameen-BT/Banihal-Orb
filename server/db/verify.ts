import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';

// Fail-fast preflight: confirms every REQUIRED database is reachable, carries its
// schema, and is still IN SYNC with the Prisma datamodel. Used by deploy.sh before
// it touches systemd, and runnable on its own via `npm run db:verify`. Uses the
// app's own `pg` dependency (no psql client needed).

interface Target {
  name: string;
  url: string | undefined;
  table: string; // a signature table that must exist in a provisioned DB
  schema?: string; // Prisma datamodel to diff the live DB against (omit → no datamodel)
  // Whether an unreachable database aborts the deploy. See the admin store below.
  required?: boolean;
}

const targets: Target[] = [
  { name: 'b2b (main)',    url: process.env['DATABASE_URL'],           table: 'customers',   schema: 'prisma/schema.prisma' },
  { name: 'b2b_chat',      url: process.env['CHAT_DATABASE_URL'],      table: 'ChatSession', schema: 'prisma/chat.prisma' },
  { name: 'b2b_ticketing', url: process.env['TICKETING_DATABASE_URL'], table: 'Ticket',      schema: 'prisma/ticketing.prisma' },
  { name: 'b2b_ticket',    url: process.env['TICKET_DATABASE_URL'],    table: 'Tickets',     schema: 'prisma/ticket.prisma' },
  // The Administrators' isolated store lives on a REMOTE host and its schema comes
  // from the `ticketingDB` pg dump, not from a .sql file here — hence no `schema`.
  //
  // It is deliberately NOT deploy-blocking. Its Prisma client connects lazily, so
  // an outage degrades exactly one feature (ADMINISTRATOR ticketing) and cannot
  // crash boot. Hard-failing here instead took the whole pipeline down whenever
  // that remote host was off: deploy.sh aborts before it builds or restarts, which
  // pushed deploys onto a manual `npm run build && systemctl restart` path that
  // skips provisioning entirely — the direct cause of the `customers.approved`
  // drift that 500'd every authenticated request. One optional remote store must
  // not be able to block shipping the platform.
  //
  // This does NOT re-open a silent fallback: the no-fallback guarantee is enforced
  // in config/ticketDatabase.ts (datasource override) and config/env.ts (the URL is
  // still required), not here. This flag only decides whether a deploy may proceed.
  { name: 'b2b_ticketing_admin', url: process.env['ADMIN_TICKETING_DATABASE_URL'], table: 'Tickets', required: false },
];

async function checkOne(t: Target): Promise<string> {
  const bad = t.required === false ? '⚠️ ' : '❌';
  if (!t.url) return `${bad} ${t.name}: URL not set in environment`;
  const pool = new Pool({ connectionString: t.url, connectionTimeoutMillis: 5000, max: 1 });
  try {
    const res = await pool.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`public."${t.table}"`]);
    return res.rows[0]?.ok
      ? `✅ ${t.name}: reachable, schema present`
      : `${bad} ${t.name}: reachable but schema missing (table "${t.table}" absent — run: npm run db:provision)`;
  } catch (err) {
    return `${bad} ${t.name}: NOT reachable (${(err as Error).message})`;
  } finally {
    await pool.end().catch(() => {});
  }
}

// Is the live database still in sync with the Prisma datamodel?
//
// checkOne only proves the signature TABLE exists — a table that is missing a
// COLUMN sails straight through it. That is exactly how `customers.approved`
// reached production and 500'd every authenticated request (auth.middleware.ts
// selects it on each one) until the DDL was applied by hand.
//
// We grep the diff script rather than using `--exit-code` because db/*.sql declares
// TIMESTAMPTZ while Prisma models the same columns as TIMESTAMP(3): every healthy
// database here reports that cosmetic type drift forever, so --exit-code would be
// red on a perfectly good install and get switched off within a week. ADD COLUMN /
// CREATE TABLE are emitted only when the DATABASE IS BEHIND the datamodel, which is
// the drift that actually breaks requests at runtime.
function checkDrift(t: Target): string {
  try {
    const script = execFileSync(
      'npx',
      ['prisma', 'migrate', 'diff', '--from-schema-datasource', t.schema!, '--to-schema-datamodel', t.schema!, '--script'],
      { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const behind = script.split('\n').map((l) => l.trim()).filter((l) => /ADD COLUMN|CREATE TABLE/.test(l));
    if (behind.length === 0) return `✅ ${t.name}: in sync with ${t.schema}`;
    return (
      `❌ ${t.name}: DATABASE IS BEHIND ${t.schema} — run: npm run db:provision\n` +
      behind.map((b) => `       ${b}`).join('\n')
    );
  } catch (err) {
    return `❌ ${t.name}: drift check failed (${(err as Error).message})`;
  }
}

async function main(): Promise<void> {
  console.log('🔎 Verifying required databases (incl. admin ticket store)…');
  const results = await Promise.all(targets.map(checkOne));
  for (const r of results) console.log('  ' + r);

  let failures = results.filter((r) => r.startsWith('❌'));

  // Drift only means something for a database we could actually reach, and an
  // unreachable required DB is already fatal — so only diff once the above is clean.
  if (failures.length === 0) {
    console.log('\n🔬 Checking schema drift (live database vs Prisma datamodel)…');
    const drift = targets.filter((t) => t.schema).map(checkDrift);
    for (const d of drift) console.log('  ' + d);
    failures = drift.filter((d) => d.startsWith('❌'));
  }

  if (failures.length > 0) {
    console.error(`\n❌ Database verification failed: ${failures.length} check(s) not OK. Aborting.`);
    process.exit(1);
  }
  console.log('\n✅ All required databases verified and in sync.');
}

main().catch((err) => {
  console.error('❌ Database verification crashed:', err);
  process.exit(1);
});
