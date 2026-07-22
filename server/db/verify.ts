import 'dotenv/config';
import { Pool } from 'pg';

// Fail-fast preflight: confirms every REQUIRED database is reachable and carries
// its schema. Used by deploy.sh before it touches systemd, and runnable on its
// own via `npm run db:verify`. Uses the app's own `pg` dependency (no psql
// client needed). The Administrators' isolated store (ADMIN_TICKETING_DATABASE_URL
// → b2b_ticketing_admin, schema from the `ticketingDB` dump) IS checked — it is a
// required store with no fallback, so a broken admin DB must fail the deploy.

interface Target {
  name: string;
  url: string | undefined;
  table: string; // a signature table that must exist in a provisioned DB
}

const targets: Target[] = [
  { name: 'b2b (main)',    url: process.env['DATABASE_URL'],           table: 'customers' },
  { name: 'b2b_chat',      url: process.env['CHAT_DATABASE_URL'],      table: 'ChatSession' },
  { name: 'b2b_ticketing', url: process.env['TICKETING_DATABASE_URL'], table: 'Ticket' },
  { name: 'b2b_ticket',    url: process.env['TICKET_DATABASE_URL'],    table: 'Tickets' },
  { name: 'b2b_ticketing_admin', url: process.env['ADMIN_TICKETING_DATABASE_URL'], table: 'Tickets' },
];

async function checkOne(t: Target): Promise<string> {
  if (!t.url) return `❌ ${t.name}: URL not set in environment`;
  const pool = new Pool({ connectionString: t.url, connectionTimeoutMillis: 5000, max: 1 });
  try {
    const res = await pool.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`public."${t.table}"`]);
    return res.rows[0]?.ok
      ? `✅ ${t.name}: reachable, schema present`
      : `❌ ${t.name}: reachable but schema missing (table "${t.table}" absent — run: npm run db:provision)`;
  } catch (err) {
    return `❌ ${t.name}: NOT reachable (${(err as Error).message})`;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main(): Promise<void> {
  console.log('🔎 Verifying required databases (incl. admin ticket store)…');
  const results = await Promise.all(targets.map(checkOne));
  for (const r of results) console.log('  ' + r);

  const failures = results.filter((r) => r.startsWith('❌'));
  if (failures.length > 0) {
    console.error(`\n❌ Database verification failed: ${failures.length} of ${targets.length} not OK. Aborting.`);
    process.exit(1);
  }
  console.log('✅ All required databases verified.');
}

main().catch((err) => {
  console.error('❌ Database verification crashed:', err);
  process.exit(1);
});
