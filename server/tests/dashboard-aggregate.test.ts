import { describe, it, expect } from 'vitest';
import { aggregate, type Feed } from '../src/modules/ticketing/services/dashboardAggregate';
import type { FeedTicket } from '../src/modules/ticketing/ticketing.client';

// Pure aggregation — no database, no HTTP. These cases guard the arithmetic and the
// tie-breaks, which are what a refactor silently gets wrong (a broken sort reorders
// rows rather than throwing).

const HOUR = 3_600_000;
const now = new Date();

function t(id: string, title: string, status: string, priority: string, ageH: number): FeedTicket {
  const created = new Date(now.getTime() - ageH * HOUR);
  return {
    id,
    ticketNumber: `TKT-${id}`,
    title,
    status,
    priority,
    branch: 'HO',
    projectId: 'p1',
    assigneeId: 'a1', assigneeName: 'Ada',
    reporterId: 'u1', reporterName: 'Rita', reporterEmail: 'rita@example.com',
    customerId: 'c1', customerName: 'Acme',
    createdAt: created.toISOString(),
    updatedAt: new Date(now.getTime() - (ageH / 2) * HOUR).toISOString(),
    pausedTime: null,
    totalPausedTime: 0,
    slaResolutionSeconds: 3600,
  };
}

describe('ops dashboard aggregation', () => {
  it('aggregates every panel from one pass over the estate', () => {
    const feed: Feed = {
      tickets: [
        t('1', 'Printer Issue', 'todo', 'high', 5),
        t('2', 'printer issue ', 'completed', 'low', 100),
        t('3', 'password reset', 'in_progress', 'urgent', 200),
        t('4', 'VPN down', 'completed', 'medium', 300),
      ],
      projects: [{ id: 'p1', status: 'active', endDate: null }],
    };
    const d = aggregate(feed, now, true);

    expect(d.ticketStats.total).toBe(4);
    expect(d.ticketStats.completed).toBe(2);
    expect(d.ticketStats.open).toBe(2);
    expect(d.ticketStats.completionRate).toBe(50);
    // Only the two open tickets are high/urgent-and-actionable.
    expect(d.ticketStats.highPriority).toBe(2);

    // Case + trailing whitespace fold into one donut slice, keeping first-seen casing.
    expect(d.issueDistribution.top[0]!.label).toBe('Printer Issue');
    expect(d.issueDistribution.top[0]!.count).toBe(2);

    // Both open tickets are older than their 1h SLA budget.
    expect(d.kpi.openTickets).toBe(2);
    expect(d.kpi.slaBreachPct).toBe(100);

    // Open high-priority work marks the only project at risk.
    expect(d.projectStats.atRisk).toBe(1);
    expect(d.projectStats.onTrack).toBe(0);

    // Both panels roll up to the one assignee / one reporter.
    expect(d.assignees).toHaveLength(1);
    expect(d.assignees[0]!.closed).toBe(2);
    expect(d.users).toHaveLength(1);
    expect(d.users[0]!.open).toBe(2);
    expect(d.users[0]!.highPriority).toBe(2);

    expect(d.clients[0]!.name).toBe('Acme');
    expect(d.branches.rows[0]!.branch).toBe('HO');
    // Daily buckets are gap-filled back to the oldest ticket (~13 days).
    expect(d.daily.points.length).toBeGreaterThan(12);
  });

  it('skips the per-user grid unless it is asked for', () => {
    const feed: Feed = { tickets: [t('1', 'Printer Issue', 'todo', 'high', 5)], projects: [] };
    expect(aggregate(feed, now, false).users).toEqual([]);
  });

  it('does not divide by zero on an empty feed', () => {
    const d = aggregate({ tickets: [], projects: [] }, now, true);
    expect(d.ticketStats.completionRate).toBe(0);
    expect(d.kpi.slaBreachPct).toBe(0);
    expect(d.branches.average).toBe(0);
    expect(d.branches.topVsAverage).toBeNull();
    expect(d.daily.points).toHaveLength(1); // today only
  });

  it('excludes paused time from the SLA clock', () => {
    // 3h old, 2.5h of it paused → 0.5h effective, inside a 1h budget.
    const paused = { ...t('5', 'Waiting on client', 'client_pending', 'medium', 3), totalPausedTime: 9000 };
    const feed = (ticket: FeedTicket): Feed => ({ tickets: [ticket], projects: [] });
    expect(aggregate(feed(paused), now, false).kpi.slaBreachPct).toBe(0);
    expect(aggregate(feed({ ...paused, totalPausedTime: 0 }), now, false).kpi.slaBreachPct).toBe(100);
  });

  it('breaks ties deterministically so panels do not reshuffle between refreshes', () => {
    // Equal counts: donut orders by label ascending; the daily topIssue picks the
    // alphabetically first label rather than whichever hashed first.
    const d = aggregate({
      tickets: [t('1', 'Zebra fault', 'todo', 'low', 1), t('2', 'Alpha fault', 'todo', 'low', 1)],
      projects: [],
    }, now, false);
    expect(d.issueDistribution.top.map((s) => s.label)).toEqual(['Alpha fault', 'Zebra fault']);
    expect(d.daily.points.at(-1)!.topIssue).toBe('Alpha fault');
  });
});
