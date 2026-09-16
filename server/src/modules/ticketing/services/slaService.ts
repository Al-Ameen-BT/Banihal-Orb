// SLA engine (report §7.4). The resolution clock only runs while a ticket is
// actively worked: entering `client_pending` pauses it (stamps pausedTime); leaving
// it resumes (adds the elapsed pause to totalPausedTime). Effective elapsed time
// subtracts all paused time (historical + current) from wall-clock elapsed.

export const PAUSED_STATUS = 'client_pending';
// ponytail: keep a set in sync with a constant; when more terminal statuses arrive, upgrade to a Set.
const TERMINAL_STATUSES = ['completed', 'declined'] as readonly string[];
export const RESOLVED_STATUS = 'completed';

export type TimeUnit = 'minutes' | 'hours' | 'days';
export type SlaStatus = 'none' | 'paused' | 'breached' | 'critical' | 'warning' | 'normal';

export function convertToSeconds(value: number, unit: TimeUnit): number {
  switch (unit) {
    case 'minutes': return value * 60;
    case 'days':    return value * 86400;
    case 'hours':
    default:        return value * 3600;
  }
}

export interface TicketTimeFields {
  status: string;
  createdAt: Date;
  pausedTime: Date | null;
  totalPausedTime: number; // seconds
}

// Wall-clock elapsed minus all paused time (closed pauses + the currently open one).
export function effectiveElapsedSeconds(t: TicketTimeFields, now = new Date()): number {
  const wall = (now.getTime() - t.createdAt.getTime()) / 1000;
  let paused = t.totalPausedTime ?? 0;
  if (t.status === PAUSED_STATUS && t.pausedTime) {
    paused += (now.getTime() - t.pausedTime.getTime()) / 1000;
  }
  return Math.max(0, wall - paused);
}

export interface SlaLike { resolutionTime: number; timeUnit: TimeUnit }

export interface SlaEvaluation {
  status: SlaStatus;
  budgetSeconds: number | null;
  remainingSeconds: number | null;
  deadline: string | null; // ISO; createdAt + budget + paused, approximate live ETA
}

// Core clock evaluation against an arbitrary budget (seconds). Shared by both the
// resolution and response evaluators so their bar/pill behaviour stays identical.
function evaluateAgainstBudget(t: TicketTimeFields, budget: number | null, now: Date): SlaEvaluation {
  if (budget == null) return { status: 'none', budgetSeconds: null, remainingSeconds: null, deadline: null };
  if (TERMINAL_STATUSES.includes(t.status)) {
    // Completed / declined → the clock is stopped; expose the budget but no live remaining/deadline.
    return { status: 'normal', budgetSeconds: budget, remainingSeconds: null, deadline: null };
  }
  const elapsed = effectiveElapsedSeconds(t, now);
  const remaining = budget - elapsed;
  const deadline = new Date(now.getTime() + remaining * 1000).toISOString();
  if (t.status === PAUSED_STATUS) return { status: 'paused', budgetSeconds: budget, remainingSeconds: remaining, deadline };
  if (remaining <= 0) return { status: 'breached', budgetSeconds: budget, remainingSeconds: remaining, deadline };
  const ratio = remaining / budget;
  const status: SlaStatus = ratio <= 0.1 ? 'critical' : ratio <= 0.25 ? 'warning' : 'normal';
  return { status, budgetSeconds: budget, remainingSeconds: remaining, deadline };
}

// Drives the SLA timer UI: paused / breached / critical (≤10% left) / warning (≤25%) / normal.
export function evaluateSla(t: TicketTimeFields, sla: SlaLike | null, now = new Date()): SlaEvaluation {
  return evaluateAgainstBudget(t, sla ? convertToSeconds(sla.resolutionTime, sla.timeUnit) : null, now);
}

// Response SLA — APPROXIMATION: there is no true "first response" timestamp in the
// 14-table schema, so we run the same effective-elapsed clock against the response
// budget. `completed`/`client_pending` render as stopped, exactly like the resolution bar.
export function evaluateResponseSla(t: TicketTimeFields, sla: { responseTime: number; timeUnit: TimeUnit } | null, now = new Date()): SlaEvaluation {
  return evaluateAgainstBudget(t, sla ? convertToSeconds(sla.responseTime, sla.timeUnit) : null, now);
}

// Pause bookkeeping on a status transition. Returns the fields to persist (if any).
export function pausePatch(
  current: { status: string; pausedTime: Date | null; totalPausedTime: number },
  newStatus: string,
  now = new Date(),
): { pausedTime?: Date | null; totalPausedTime?: number } {
  const wasPaused = current.status === PAUSED_STATUS;
  const willPause = newStatus === PAUSED_STATUS;
  if (!wasPaused && willPause) {
    return { pausedTime: now };
  }
  if (wasPaused && !willPause) {
    const add = current.pausedTime ? Math.round((now.getTime() - current.pausedTime.getTime()) / 1000) : 0;
    return { pausedTime: null, totalPausedTime: (current.totalPausedTime ?? 0) + add };
  }
  return {};
}
