// Ops dashboard aggregation.
//
// One pass over the flat ticket estate (ticketing.client.ts `dashboardFeed`) feeds
// every panel — stat grid, issue donut, daily volume, branch split, assignee
// scorecards, client ranking, per-user load — because they all slice the same set;
// five bespoke group-by queries would mean five scans of the same rows.
//
// Pure on purpose: no Prisma, no clock of its own. The caller supplies `now`, so the
// whole thing is testable without a database (see tests/dashboard-aggregate.test.ts).

import type { FeedTicket, FeedProject } from '../ticketing.client';

export interface Feed { tickets: FeedTicket[]; projects: FeedProject[] }

// ── Response shape (mirrored by DashOverview in client/src/lib/schemas.ts) ───

export interface IssueSlice { label: string; count: number; pct: number }

export interface AssigneeScore {
  id: string;
  name: string;
  closed: number;
  open: number;
  closureRate: number;
  /** Open tickets untouched for over STUCK_AFTER_HOURS — the queue that went quiet. */
  stuck: number;
  slowestTitle: string | null;
  slowestHours: number;
}

export interface UserLoad {
  id: string;
  name: string;
  email: string | null;
  open: number;
  total: number;
  completed: number;
  highPriority: number;
  /** Mean age of this user's still-open tickets, in hours. */
  avgOpenAgeHours: number;
  lastActivityAt: string | null;
}

export interface DashboardOverview {
  generatedAt: string;
  analyzed: number;
  ticketStats: {
    total: number; completed: number; inProgress: number; todo: number;
    clientPending: number; highPriority: number; today: number; open: number;
    completionRate: number;
  };
  projectStats: { total: number; completed: number; active: number; atRisk: number; onTrack: number };
  issueDistribution: {
    top: IssueSlice[];
    other: IssueSlice;
    total: number;
    /** Share of ALL tickets covered by the three largest issues. */
    top3Pct: number;
    /** Week-over-week change in ticket creation, as a percentage. */
    weekDeltaPct: number;
  };
  kpi: {
    ticketsToday: number;
    openTickets: number;
    slaBreachPct: number;
    createdSpark: number[];
    openSpark: number[];
    breachSpark: number[];
    alert: string | null;
  };
  recent: Array<{
    id: string; ticketNumber: string; title: string;
    status: string; priority: string; createdAt: string;
  }>;
  daily: {
    points: Array<{ date: string; created: number; topIssue: string | null }>;
    peakDate: string | null;
    peakCreated: number;
    average: number;
  };
  branches: {
    rows: Array<{ branch: string; count: number; pct: number }>;
    /** Mean tickets per branch — the baseline the top branch is compared against. */
    average: number;
    /** How many times above `average` the busiest branch sits; null with nothing to compare. */
    topVsAverage: number | null;
  };
  assignees: AssigneeScore[];
  clients: Array<{ id: string; name: string; open: number; total: number; demand: 'high' | 'medium' | 'low' }>;
  users: UserLoad[];
}

// ── Domain constants (mirror the ticketing service) ─────────────────────────

const COMPLETED = 'completed';
const PAUSED = 'client_pending';
const OPEN_STATUSES = ['todo', 'in_progress', PAUSED];
/** An open ticket with no update for this long counts as "stuck".
 *  ponytail: fixed threshold, not per-SLA. Make it SLA-relative if teams with very
 *  different response budgets start sharing one dashboard. */
const STUCK_AFTER_HOURS = 72;
const TOP_ISSUES = 7;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const isOpen = (status: string): boolean => OPEN_STATUSES.includes(status);
const isHot = (t: FeedTicket): boolean => t.priority === 'high' || t.priority === 'urgent';

const round1 = (v: number): number => Math.round(v * 10) / 10;

function pct(part: number, whole: number): number {
  if (whole === 0) return 0;
  return round1((part / whole) * 100);
}

const ms = (iso: string): number => new Date(iso).getTime();

/** Wall-clock age minus all paused time — the same clock slaService runs, so a
 *  ticket never looks breached here and healthy there. */
function effectiveElapsedSeconds(t: FeedTicket, now: number): number {
  const wall = (now - ms(t.createdAt)) / 1000;
  let paused = t.totalPausedTime;
  if (t.status === PAUSED && t.pausedTime) paused += (now - ms(t.pausedTime)) / 1000;
  return Math.max(wall - paused, 0);
}

/** True when an open ticket has burned through its resolution budget. Tickets with
 *  no SLA policy attached can never breach. */
function isBreached(t: FeedTicket, now: number): boolean {
  if (!isOpen(t.status)) return false;
  if (t.slaResolutionSeconds === null) return false;
  return effectiveElapsedSeconds(t, now) > t.slaResolutionSeconds;
}

/** Group key for the issue donut. Ticket titles are free text typed by humans, so
 *  "Printer Issue" and "printer issue " are the same problem — fold case and collapse
 *  whitespace before counting, or the top-7 fragments into near-dupes. */
const issueKey = (title: string): string =>
  title.split(/\s+/).filter(Boolean).join(' ').toLowerCase();

/** UTC calendar day as YYYY-MM-DD — the bucket key for sparklines and daily volume. */
const day = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Count each title once, keeping the first-seen original casing as the display
 *  label; the normalised key is only for grouping. */
function tallyIssues(tickets: FeedTicket[]): Map<string, { label: string; count: number }> {
  const by = new Map<string, { label: string; count: number }>();
  for (const t of tickets) {
    const k = issueKey(t.title);
    const e = by.get(k);
    if (e) e.count += 1;
    else by.set(k, { label: t.title.trim(), count: 1 });
  }
  return by;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = out.get(k);
    if (list) list.push(it); else out.set(k, [it]);
  }
  return out;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export function aggregate(feed: Feed, nowDate: Date, withUsers: boolean): DashboardOverview {
  const tickets = feed.tickets;
  const total = tickets.length;
  const now = nowDate.getTime();

  // ── Stat grid ─────────────────────────────────────────────────────────
  // UTC start-of-day, matching the UTC `day()` buckets the sparklines use — a local
  // midnight here would disagree with the daily panel by up to a whole bucket.
  const startOfDay = Date.parse(`${day(now)}T00:00:00Z`);

  const countStatus = (s: string): number => tickets.filter((t) => t.status === s).length;
  const completed = countStatus(COMPLETED);
  const open = tickets.filter((t) => isOpen(t.status)).length;
  const today = tickets.filter((t) => ms(t.createdAt) >= startOfDay).length;
  const ticketStats = {
    total,
    completed,
    inProgress: countStatus('in_progress'),
    todo: countStatus('todo'),
    clientPending: countStatus(PAUSED),
    // High priority only counts while it can still be acted on — a resolved urgent
    // ticket is not a thing anyone needs to see on a dashboard.
    highPriority: tickets.filter((t) => isHot(t) && t.status !== COMPLETED).length,
    today,
    open,
    completionRate: Math.round(pct(completed, total)),
  };

  // ── Project health ────────────────────────────────────────────────────
  // A project is at risk when it is still running past its end date, or when it is
  // carrying open high-priority work.
  const hotProjects = new Set(
    tickets.filter((t) => isOpen(t.status) && isHot(t)).map((t) => t.projectId),
  );
  const pCompleted = feed.projects.filter((p) => p.status === 'completed' || p.status === 'done').length;
  const active = feed.projects.filter(
    (p) => p.status !== 'completed' && p.status !== 'done' && p.status !== 'archived',
  );
  const atRisk = active.filter(
    (p) => (p.endDate !== null && ms(p.endDate) < now) || hotProjects.has(p.id),
  ).length;
  const projectStats = {
    total: feed.projects.length,
    completed: pCompleted,
    active: active.length,
    atRisk,
    onTrack: Math.max(active.length - atRisk, 0),
  };

  // ── Issue distribution (donut) ────────────────────────────────────────
  // Ties broken by label so the donut ordering is stable between refreshes instead
  // of shuffling with Map iteration order.
  const ranked = [...tallyIssues(tickets).values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const top: IssueSlice[] = ranked.slice(0, TOP_ISSUES)
    .map(({ label, count }) => ({ label, count, pct: pct(count, total) }));
  const otherCount = ranked.slice(TOP_ISSUES).reduce((s, r) => s + r.count, 0);
  const top3 = ranked.slice(0, 3).reduce((s, r) => s + r.count, 0);

  const weekAgo = now - 7 * DAY_MS;
  const prevWeek = now - 14 * DAY_MS;
  const thisWeek = tickets.filter((t) => ms(t.createdAt) >= weekAgo).length;
  const lastWeek = tickets.filter((t) => {
    const c = ms(t.createdAt);
    return c >= prevWeek && c < weekAgo;
  }).length;
  const issueDistribution = {
    top,
    other: { label: 'Other', count: otherCount, pct: pct(otherCount, total) },
    total,
    top3Pct: pct(top3, total),
    weekDeltaPct: lastWeek === 0 ? 0 : round1(((thisWeek - lastWeek) / lastWeek) * 100),
  };

  // ── KPI + live panel ──────────────────────────────────────────────────
  // 7-point sparklines, oldest → newest, bucketed by the day a ticket was CREATED.
  // `open`/`breach` therefore read as "of the tickets raised that day, how many are
  // still open / already past SLA" — a per-cohort trend, not a historical snapshot
  // (the schema keeps no status history to rebuild one from).
  const breachedNow = tickets.filter((t) => isBreached(t, now)).length;
  const createdSpark: number[] = [];
  const openSpark: number[] = [];
  const breachSpark: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = day(now - i * DAY_MS);
    const cohort = tickets.filter((t) => day(ms(t.createdAt)) === d);
    createdSpark.push(cohort.length);
    openSpark.push(cohort.filter((t) => isOpen(t.status)).length);
    breachSpark.push(cohort.filter((t) => isBreached(t, now)).length);
  }

  const twoH = now - 2 * HOUR_MS;
  const fourH = now - 4 * HOUR_MS;
  const recentBreaches = tickets.filter((t) => ms(t.createdAt) >= twoH && isBreached(t, now)).length;
  const priorBreaches = tickets.filter((t) => {
    const c = ms(t.createdAt);
    return c >= fourH && c < twoH && isBreached(t, now);
  }).length;
  const kpi = {
    ticketsToday: today,
    openTickets: open,
    slaBreachPct: pct(breachedNow, open),
    createdSpark,
    openSpark,
    breachSpark,
    // Set when SLA breaches among tickets raised in the last 2 hours are outpacing
    // the prior 2 hours.
    alert: recentBreaches > priorBreaches ? 'SLA breaches increasing in the last 2 hours' : null,
  };

  // ── Live feed (upstream is already ordered newest-first) ──────────────
  const recent = tickets.slice(0, 8).map((t) => ({
    id: t.id,
    ticketNumber: t.ticketNumber,
    title: t.title,
    status: t.status,
    priority: t.priority,
    createdAt: t.createdAt,
  }));

  // ── Daily volume ──────────────────────────────────────────────────────
  // Buckets span every day from the oldest ticket to today, INCLUDING empty ones —
  // skipping quiet days would compress the x-axis and make a spike look like a plateau.
  const perDay = groupBy(tickets, (t) => day(ms(t.createdAt)));
  const todayD = day(now);
  const firstD = tickets.length === 0
    ? todayD
    : [...perDay.keys()].reduce((a, b) => (a < b ? a : b));

  const points: DashboardOverview['daily']['points'] = [];
  for (let cursor = Date.parse(`${firstD}T00:00:00Z`); day(cursor) <= todayD; cursor += DAY_MS) {
    const bucket = perDay.get(day(cursor));
    // Highest count wins; ties go to the alphabetically first label.
    const topIssue = bucket
      ? [...tallyIssues(bucket).values()]
        .reduce((best, e) => (e.count > best.count || (e.count === best.count && e.label < best.label) ? e : best))
        .label
      : null;
    points.push({ date: day(cursor), created: bucket?.length ?? 0, topIssue });
  }
  // On tied counts the LATEST day wins, so a flat estate reports a recent peak
  // rather than the oldest bucket.
  const peak = points.reduce<typeof points[number] | null>(
    (best, p) => (best === null || p.created >= best.created ? p : best), null,
  );
  const daily = {
    points,
    peakDate: peak?.date ?? null,
    peakCreated: peak?.created ?? 0,
    average: points.length === 0 ? 0 : round1(total / points.length),
  };

  // ── Branch distribution ───────────────────────────────────────────────
  const byBranch = groupBy(tickets, (t) => t.branch?.trim() || 'Unknown');
  const branchRows = [...byBranch.entries()]
    .map(([branch, list]) => ({ branch, count: list.length, pct: pct(list.length, total) }))
    .sort((a, b) => b.count - a.count || a.branch.localeCompare(b.branch));
  const branchAvg = branchRows.length === 0 ? 0 : total / branchRows.length;
  const branches = {
    rows: branchRows,
    average: round1(branchAvg),
    topVsAverage: branchRows.length > 0 && branchAvg > 0 ? round1(branchRows[0]!.count / branchAvg) : null,
  };

  // ── Assignee performance ──────────────────────────────────────────────
  const stuckCutoff = now - STUCK_AFTER_HOURS * HOUR_MS;
  const assignees = [...groupBy(tickets, (t) => t.assigneeId ?? '__unassigned__').entries()]
    .map(([id, list]) => {
      const closed = list.filter((t) => t.status === COMPLETED).length;
      // Resolution time is inferred from updatedAt: the schema has no resolvedAt
      // column, and the last write to a completed ticket IS the resolution. Later
      // edits would inflate it, which is why this reads as "slowest", not as a
      // billing figure.
      const slowest = list.filter((t) => t.status === COMPLETED)
        .reduce<FeedTicket | null>(
          (best, t) => (best === null || ms(t.updatedAt) - ms(t.createdAt) >= ms(best.updatedAt) - ms(best.createdAt) ? t : best),
          null,
        );
      return {
        id,
        name: list.find((t) => t.assigneeName !== null)?.assigneeName ?? 'Unassigned',
        closed,
        open: list.filter((t) => isOpen(t.status)).length,
        closureRate: pct(closed, list.length),
        stuck: list.filter((t) => isOpen(t.status) && ms(t.updatedAt) < stuckCutoff).length,
        slowestTitle: slowest?.title ?? null,
        slowestHours: slowest ? round1((ms(slowest.updatedAt) - ms(slowest.createdAt)) / HOUR_MS) : 0,
      };
    })
    // Busiest queues first — an idle assignee is never the thing you scroll for.
    .sort((a, b) => b.open - a.open || b.closed - a.closed || a.name.localeCompare(b.name));

  // ── Top requested clients ─────────────────────────────────────────────
  const clients = [...groupBy(tickets, (t) => t.customerId ?? '__unknown__').entries()]
    .map(([id, list]) => {
      const openN = list.filter((t) => isOpen(t.status)).length;
      // Banded against the whole open queue, so "high" means this client is a real
      // share of current load rather than just a big number.
      const share = pct(openN, Math.max(open, 1));
      return {
        id,
        name: list.find((t) => t.customerName !== null)?.customerName ?? 'Unknown Client',
        open: openN,
        total: list.length,
        demand: (share >= 25 ? 'high' : share >= 10 ? 'medium' : 'low') as 'high' | 'medium' | 'low',
      };
    })
    .sort((a, b) => b.open - a.open || b.total - a.total)
    .slice(0, 10);

  // ── Per-user load (the ORG_ADMIN grid) ────────────────────────────────
  // Keyed on the REPORTER: an org admin is looking at their own people and who is
  // raising — and sitting on — the most work, not at the support staff the assignee
  // panel already covers. Building it is a second pass over every ticket, so a
  // platform admin does not pay for a panel they never see.
  const users = !withUsers ? [] : [...groupBy(
    tickets.filter((t) => t.reporterId !== null), (t) => t.reporterId!,
  ).entries()]
    .map(([id, list]) => {
      const openList = list.filter((t) => isOpen(t.status));
      return {
        id,
        name: list.find((t) => t.reporterName !== null)?.reporterName ?? 'Unknown user',
        email: list.find((t) => t.reporterEmail !== null)?.reporterEmail ?? null,
        open: openList.length,
        total: list.length,
        completed: list.filter((t) => t.status === COMPLETED).length,
        highPriority: openList.filter(isHot).length,
        avgOpenAgeHours: openList.length === 0 ? 0
          : round1(openList.reduce((s, t) => s + (now - ms(t.createdAt)) / HOUR_MS, 0) / openList.length),
        lastActivityAt: list.reduce<string | null>(
          (max, t) => (max === null || ms(t.updatedAt) > ms(max) ? t.updatedAt : max), null,
        ),
      };
    })
    .sort((a, b) => b.open - a.open || b.total - a.total || a.name.localeCompare(b.name));

  return {
    generatedAt: nowDate.toISOString(),
    analyzed: total,
    ticketStats,
    projectStats,
    issueDistribution,
    kpi,
    recent,
    daily,
    branches,
    assignees,
    clients,
    users,
  };
}
