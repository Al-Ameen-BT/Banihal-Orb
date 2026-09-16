import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

const urls = {
  main: process.env.DATABASE_URL!,
  ticket: process.env.TICKET_DATABASE_URL!,
  admin: process.env.ADMIN_TICKETING_DATABASE_URL!,
};

function swapDb(url: string, db: string): string {
  return url.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
}

async function createDb(client: pg.Client, name: string): Promise<void> {
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]).then((r) => r.rowCount! > 0);
  if (!exists) {
    await client.query(`CREATE DATABASE "${name}"`);
    console.log(`created ${name}`);
  } else {
    console.log(`${name} exists`);
  }
}

async function main() {
  const admin = new Client({ connectionString: swapDb(urls.main, 'postgres'), connectionTimeoutMillis: 5000 });
  await admin.connect();
  await createDb(admin, 'b2b_test');
  await createDb(admin, 'b2b_ticket_test');
  await createDb(admin, 'b2b_ticketing_admin_test');
  await admin.end();

  const apply = async (url: string, file: string) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    const sql = require('fs').readFileSync(file, 'utf8');
    await c.query(sql);
    await c.end();
    console.log(`applied ${file}`);
  };

  await apply(swapDb(urls.main, 'b2b_test'), 'db/b2b.sql');
  await apply(swapDb(urls.main, 'b2b_test'), 'db/2026-09-16-external-api.sql');
  await apply(swapDb(urls.main, 'b2b_test'), 'db/2026-09-16-approval-channel.sql');
  await apply(swapDb(urls.ticket, 'b2b_ticket_test'), 'db/b2b_ticket.sql');
  await apply(swapDb(urls.ticket, 'b2b_ticket_test'), 'db/2026-09-09-tickets-resolved-at.sql');
  await apply(swapDb(urls.ticket, 'b2b_ticket_test'), 'db/2026-09-10-projects-deleted-at.sql');
  await apply(swapDb(urls.admin, 'b2b_ticketing_admin_test'), 'db/b2b_ticket.sql');
  await apply(swapDb(urls.admin, 'b2b_ticketing_admin_test'), 'db/2026-09-09-tickets-resolved-at.sql');
  await apply(swapDb(urls.admin, 'b2b_ticketing_admin_test'), 'db/2026-09-10-projects-deleted-at.sql');
  console.log('PROVISION TEST DBS OK');
}

main().catch((e) => { console.error('PROVISION FAIL:', e instanceof Error ? e.message : e); process.exit(1); });