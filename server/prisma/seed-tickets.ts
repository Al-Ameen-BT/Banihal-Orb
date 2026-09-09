/**
 * Ticket-store seed — realistic data for the ops dashboard (/dashboard/ops).
 *
 * Seeds BOTH ticket stores with the same generator, because the dashboard is one
 * layout with two audiences: ORG_ADMIN reads b2b_ticket, ADMINISTRATOR reads
 * b2b_ticketing_admin, and a panel that only has data in one store is a panel
 * nobody can test.
 *
 * Deterministic: a fixed PRNG seed means re-running produces the same estate, so
 * "the donut changed" is a code change, never a dice roll. Destructive by design —
 * it wipes the ticket tables first. Guarded against non-local databases below.
 *
 *   npm run db:seed:tickets
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/ticket-client';
import bcrypt from 'bcryptjs';

// ─── Deterministic PRNG ──────────────────────────────────────────────────────
// mulberry32: 4 lines, uniform enough for fixture data. Math.random() would make
// every run a different dashboard.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** Pick from `[value, weight]` pairs — the shape of every distribution below. */
function weighted<T>(r: () => number, pairs: ReadonlyArray<readonly [T, number]>): T {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of pairs) if ((x -= w) <= 0) return v;
  return pairs[pairs.length - 1]![0];
}

// ─── Fixture vocabulary ──────────────────────────────────────────────────────
// Titles repeat on purpose: the issue donut groups by normalised title, so a
// long tail of unique strings would leave every slice at 1 and "Other" at 99%.
const ISSUES = [
  ['Printer Issue', 140],
  ['password reset', 78],
  ['Vulnerability detected in 10.50.53.10 : CVE-2020-1112 affects Windows Server 2019', 63],
  ['site whitelist', 46],
  ['System Slow Issue', 35],
  ['Site Whitelisting', 32],
  ['Passbook printer issue', 31],
  ['Email not syncing on Outlook', 24],
  ['VPN connection dropping', 22],
  ['User Creation in AD', 20],
  ['Shared drive access request', 18],
  ['Antivirus agent not reporting', 15],
  ['Scanner not detected', 14],
  ['RESTART SMS SERVER', 12],
  ['Cannon printer sharing issue', 11],
  ['Trust relationship issue', 10],
  ['DBA vpn support', 9],
  ['Backup job failed', 8],
  ['Disk space alert on file server', 7],
  ['Core banking application timeout', 6],
] as const;

// A real service desk's titles are mostly one-offs — the named issues above are the
// recurring 28%, and these compose into hundreds of distinct low-count titles so the
// donut's "Other" bucket stays realistically large instead of the top 7 covering
// everything.
const TAIL_ACTION = ['Unable to access', 'Slow response from', 'Error on', 'Configuration change for',
  'Access request for', 'Restart required for', 'Licence renewal for', 'Not responding —'] as const;
const TAIL_SYSTEM = ['ATM switch', 'cheque scanner', 'loan module', 'HRMS portal', 'SWIFT terminal',
  'branch WiFi', 'CCTV recorder', 'token server', 'payroll share', 'teller workstation',
  'core banking client', 'mail archive', 'UPS monitor', 'biometric reader'] as const;
const TAIL_QUALIFIER = ['counter 2', 'night shift', 'after patching', 'since migration', 'for new joiner',
  'on backup link', 'reported by branch', 'post upgrade', 'intermittent', 'urgent follow-up'] as const;

const BRANCHES = [
  [null, 660],            // unset — the dashboard buckets these as "Unknown"
  ['HO', 137],
  ['Head office', 87],
  ['Ladies', 39],
  ['Town branch', 24],
  ['IT', 18],
  ['Airport Road', 14],
  ['Civil Lines', 11],
] as const;

const STAFF = [
  { first: 'Admin', last: 'User', role: 'admin' },
  { first: 'Jishnu', last: 'Govind', role: 'developer' },
  { first: 'Keerthi', last: 'Krishna', role: 'developer' },
  { first: 'Al Ameen', last: 'N R', role: 'manager' },
  { first: 'Muhammed', last: 'Abdul Basith', role: 'developer' },
  { first: 'Ligin', last: 'Hussankutty', role: 'developer' },
  { first: 'Akash', last: 'K', role: 'tester' },
  { first: 'Subind', last: 'Kottakkatte', role: 'developer' },
  { first: 'Khadeeja', last: 'Nilooshna', role: 'tester' },
] as const;

const REPORTERS = [
  { first: 'Fathima', last: 'Rasheed' },
  { first: 'Arjun', last: 'Menon' },
  { first: 'Sneha', last: 'Pillai' },
  { first: 'Rahul', last: 'Varma' },
  { first: 'Meera', last: 'Nair' },
] as const;

const CUSTOMERS = ['Banihal Bank', 'Meridian Textiles', 'Coastal Logistics'] as const;

const DAYS = 330;          // ~11 months of history, so the volume chart has shape
const TICKETS = 1_514;     // matches the estate size the dashboard was designed against
const PEAK_DAY_AGO = 307;  // one deliberate spike, so "peak day" is never a tie
const PEAK_SIZE = 83;      // tickets on that spike day
const OPEN_WINDOW_DAYS = 6; // beyond this a ticket is almost certainly closed

/**
 * Build the whole estate in memory. Pure apart from `randomUUID`, so `--dry-run`
 * can check the numbers the dashboard will show without touching a database.
 */
function buildEstate(password: string, now = Date.now()) {
  const r = rng(20260827);

  // ── Users ────────────────────────────────────────────────────────────────
  const staff = STAFF.map((s) => ({
    id: randomUUID(),
    firstName: s.first,
    lastName: s.last,
    email: `${s.first}.${s.last}`.toLowerCase().replace(/\s+/g, '') + '@banihaltechnologies.com',
    password,
    role: s.role as 'admin' | 'manager' | 'developer' | 'tester',
  }));
  const reporters = REPORTERS.map((s) => ({
    id: randomUUID(),
    firstName: s.first,
    lastName: s.last,
    email: `${s.first}.${s.last}`.toLowerCase() + '@client.example.com',
    password,
    role: 'developer' as const,
  }));

  // ── Customers, SLAs, projects ────────────────────────────────────────────
  const customers = CUSTOMERS.map((name, i) => ({
    id: randomUUID(),
    name,
    contactPerson: REPORTERS[i]!.first + ' ' + REPORTERS[i]!.last,
    email: `support@${name.toLowerCase().replace(/\s+/g, '')}.example.com`,
  }));

  // Resolution budgets are what the dashboard's breach maths runs on; the spread
  // is wide enough that urgent tickets breach long before low-priority ones.
  const slas = (
    [
      ['Urgent — 1 day resolution', 'urgent', 1, 24],
      ['High — 2 day resolution', 'high', 2, 48],
      ['Standard — 5 day resolution', 'medium', 4, 120],
      ['Low — 10 day resolution', 'low', 8, 240],
    ] as const
  ).map(([name, priority, responseTime, resolutionTime]) => ({
    id: randomUUID(), name, priority, responseTime, resolutionTime, timeUnit: 'hours' as const,
  }));
  const slaByPriority = new Map(slas.map((s) => [s.priority as string, s.id]));

  const projects = (
    [
      ['IT Service Desk', 'active', 'Support', 'other'],
      ['Infrastructure Hardening', 'active', 'Security', 'other'],
      ['Core Banking Rollout', 'completed', 'Delivery', 'software'],
    ] as const
  ).map(([name, status, category, type], i) => ({
    id: randomUUID(),
    name,
    status,
    category,
    type,
    priority: (i === 1 ? 'high' : 'medium') as 'low' | 'medium' | 'high',
    leadId: staff[i % staff.length]!.id,
    // A past end date on a still-active project is what the dashboard scores as
    // "at risk", so one project is deliberately overdue.
    endDate: new Date(now + (i === 1 ? -12 : 60) * 86_400_000),
  }));

  // ── Tickets ──────────────────────────────────────────────────────────────
  // Assignee mix drives the scorecard panel: `null` becomes the "Unassigned"
  // column, and the weights give each person a visibly different queue.
  const assigneePool: ReadonlyArray<readonly [string | null, number]> = [
    [null, 934],
    [staff[0]!.id, 68],   // Admin User — everything open, 0% closure
    [staff[1]!.id, 63],
    [staff[2]!.id, 215],
    [staff[3]!.id, 3],
    [staff[4]!.id, 168],
    [staff[5]!.id, 1],
    [staff[6]!.id, 62],
  ];

  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < TICKETS; i++) {
    // The first PEAK_SIZE tickets all land on one day, so "peak day" is an
    // unambiguous spike rather than whichever day won a coin toss. The rest ramp
    // towards the present (the desk got busier), which is what puts enough tickets
    // inside the open window to make the KPI panel non-trivial.
    const daysAgo = i < PEAK_SIZE
      ? PEAK_DAY_AGO
      : Math.floor(Math.pow(r(), 1.7) * DAYS);
    // Anchor to that day's midnight and walk FORWARD into it — subtracting a random
    // offset instead would push part of each day's batch across midnight, which
    // smeared the peak across two dates and flattened the spike.
    // UTC, not local: the dashboard aggregator buckets the volume chart by UTC date, so a
    // local-midnight anchor would split each day's batch across two of its buckets.
    const midnight = new Date(now - daysAgo * 86_400_000).setUTCHours(0, 0, 0, 0);
    const createdAt = new Date(Math.min(now, midnight + Math.floor(r() * 86_400_000)));

    // Old tickets are nearly always closed; only the recent tail stays open. The
    // small constant on `todo` is the handful of genuinely forgotten tickets that
    // give the assignee scorecard its "stuck" counts.
    const staleness = Math.min(1, daysAgo / OPEN_WINDOW_DAYS);
    const status = weighted(r, [
      ['completed', 12 + 88 * staleness],
      ['todo', 52 * (1 - staleness) + 0.45],
      ['in_progress', 17 * (1 - staleness) + 0.1],
      ['client_pending', 9 * (1 - staleness) + 0.05],
    ] as const);

    const priority = weighted(r, [['low', 18], ['medium', 58], ['high', 18], ['urgent', 6]] as const);
    const assigneeId = status === 'completed'
      ? weighted(r, assigneePool.filter(([id]) => id !== staff[0]!.id))
      : weighted(r, assigneePool);

    // Closed tickets moved recently; open ones may have gone quiet — the gap is
    // exactly what the "stuck" count on the assignee scorecard measures.
    const updatedAt = new Date(Math.min(
      now,
      createdAt.getTime() + Math.floor(r() * (status === 'completed' ? 5 : 9)) * 86_400_000,
    ));

    rows.push({
      id: randomUUID(),
      ticketNumber: `TKT-${String(i + 1).padStart(5, '0')}`,
      title: r() < 0.30
        ? weighted(r, ISSUES)
        : `${pick(r, TAIL_ACTION)} ${pick(r, TAIL_SYSTEM)} ${pick(r, TAIL_QUALIFIER)}`,
      description: 'Reported via the service desk. Seeded fixture data for dashboard testing.',
      status,
      priority,
      type: weighted(r, [['task', 55], ['bug', 30], ['story', 8], ['feature', 7]] as const),
      projectId: weighted(r, [[projects[0]!.id, 70], [projects[1]!.id, 22], [projects[2]!.id, 8]] as const),
      reporterId: weighted(r, reporters.map((u) => [u.id, 1] as const)),
      createdBy: reporters[0]!.id,
      assigneeId,
      customerId: weighted(r, [[customers[0]!.id, 60], [customers[1]!.id, 25], [customers[2]!.id, 15]] as const),
      branch: weighted(r, BRANCHES),
      SLAId: slaByPriority.get(priority) ?? null,
      onSiteSupportRequired: r() < 0.12,
      createdAt,
      updatedAt,
      resolvedAt: status === 'completed' ? updatedAt : null,
    });
  }
  return { staff, reporters, customers, slas, projects, tickets: rows };
}

type Estate = ReturnType<typeof buildEstate>;

async function seedStore(prisma: PrismaClient, label: string, estate: Estate) {
  // Wipe in FK order — children before parents, or the deletes are rejected.
  await prisma.activities.deleteMany();
  await prisma.commentAttachments.deleteMany();
  await prisma.comments.deleteMany();
  await prisma.ticketAttachments.deleteMany();
  await prisma.ticketWatchers.deleteMany();
  await prisma.tickets.deleteMany();
  await prisma.projectMembers.deleteMany();
  await prisma.projects.deleteMany();
  await prisma.sLAs.deleteMany();
  await prisma.customers.deleteMany();
  await prisma.users.deleteMany();

  await prisma.users.createMany({ data: [...estate.staff, ...estate.reporters] });
  await prisma.customers.createMany({ data: estate.customers });
  await prisma.sLAs.createMany({ data: estate.slas });
  await prisma.projects.createMany({ data: estate.projects });
  await prisma.tickets.createMany({ data: estate.tickets as never });

  const open = estate.tickets.filter((t) => t.status !== 'completed').length;
  console.log(
    `✅ ${label}: ${estate.tickets.length} tickets (${open} open), ` +
    `${estate.staff.length + estate.reporters.length} users, ${estate.projects.length} projects, ` +
    `${estate.slas.length} SLAs, ${estate.customers.length} customers`,
  );
}

// Refuse to wipe anything that isn't obviously a local test database — this
// script's first act is a bulk delete, and a mistyped URL is unrecoverable.
function assertLocal(url: string | undefined, name: string): string {
  if (!url) throw new Error(`${name} is not set`);
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && !process.env['SEED_ALLOW_REMOTE']) {
    throw new Error(`${name} points at ${host}, not localhost. Set SEED_ALLOW_REMOTE=1 to seed it anyway.`);
  }
  return url;
}

/**
 * `--dry-run`: build the estate and assert the numbers the dashboard will show are
 * plausible. This is the check on the distribution weights above — get `staleness`
 * or the SLA budgets wrong and the estate silently becomes 100%-breached or
 * 100%-open, which looks like a dashboard bug rather than a fixture bug.
 */
function dryRun() {
  const e = buildEstate('dry-run-not-a-hash');
  const now = Date.now();
  const OPEN = ['todo', 'in_progress', 'client_pending'];
  const budget = new Map<string, number>(e.slas.map((s) => [s.id as string, s.resolutionTime * 3600_000]));

  const total = e.tickets.length;
  const open = e.tickets.filter((t) => OPEN.includes(t.status as string));
  const completionRate = Math.round(((total - open.length) / total) * 100);
  const breached = open.filter((t) => {
    const b = budget.get(t.SLAId as string);
    return b !== undefined && now - (t.createdAt as Date).getTime() > b;
  }).length;
  const breachPct = (breached / open.length) * 100;

  const byTitle = new Map<string, number>();
  for (const t of e.tickets) byTitle.set(t.title as string, (byTitle.get(t.title as string) ?? 0) + 1);
  const top = [...byTitle.values()].sort((a, b) => b - a);
  const top3Pct = ((top[0]! + top[1]! + top[2]!) / total) * 100;

  const byDay = new Map<string, number>();
  for (const t of e.tickets) {
    const d = (t.createdAt as Date).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  const peak = Math.max(...byDay.values());

  console.log(`tickets=${total} open=${open.length} completion=${completionRate}% ` +
    `breach=${breachPct.toFixed(1)}% top3=${top3Pct.toFixed(1)}% ` +
    `days=${byDay.size} peak=${peak} assignees=${new Set(e.tickets.map((t) => t.assigneeId)).size}`);

  // Every ticket must be insertable: the required FK columns are all non-null.
  for (const t of e.tickets) {
    if (!t.projectId || !t.reporterId || !t.createdBy || !t.ticketNumber) {
      throw new Error(`ticket ${t.ticketNumber} is missing a required column`);
    }
  }
  console.assert(total === TICKETS, `expected ${TICKETS} tickets, got ${total}`);
  console.assert(new Set(e.tickets.map((t) => t.ticketNumber)).size === total, 'ticketNumber must be unique');
  console.assert(completionRate >= 80 && completionRate <= 97, `completion rate ${completionRate}% is implausible`);
  console.assert(breachPct > 0 && breachPct < 35, `SLA breach ${breachPct.toFixed(1)}% is implausible`);
  console.assert(top3Pct > 10 && top3Pct < 40, `top-3 issue share ${top3Pct.toFixed(1)}% is implausible`);
  console.assert(byDay.size > DAYS * 0.8, `only ${byDay.size} distinct days — the volume chart would be sparse`);
  console.assert(peak >= 40, `peak day is only ${peak} tickets — no visible spike`);
  console.assert(e.tickets.some((t) => t.assigneeId === null), 'no unassigned tickets — the Unassigned column would vanish');
  console.assert(e.tickets.some((t) => t.branch === null), 'no null branches — the Unknown bucket would vanish');
  console.log('✅ dry run passed');
}

async function main() {
  if (process.argv.includes('--dry-run')) return dryRun();

  const stores: Array<[string, string]> = [
    ['b2b_ticket (ORG_ADMIN store)', assertLocal(process.env['TICKET_DATABASE_URL'], 'TICKET_DATABASE_URL')],
    ['b2b_ticketing_admin (ADMINISTRATOR store)', assertLocal(process.env['ADMIN_TICKETING_DATABASE_URL'], 'ADMIN_TICKETING_DATABASE_URL')],
  ];
  const estate = buildEstate(await bcrypt.hash('Passw0rd!Seed2026', 12));
  for (const [label, url] of stores) {
    const prisma = new PrismaClient({ datasourceUrl: url });
    try {
      await seedStore(prisma, label, estate);
    } finally {
      await prisma.$disconnect();
    }
  }
}

main().catch((err) => {
  console.error('❌ Ticket seed failed:', err);
  process.exit(1);
});
