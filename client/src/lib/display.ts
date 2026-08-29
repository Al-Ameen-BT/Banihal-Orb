// Presentation helpers shared across the console. These were copy-pasted into
// nine page files; the copies had already drifted (three different "expiring"
// labels, two different relative-time ladders), which is the usual cost of
// duplicating something this small.

// ─── Dates ───────────────────────────────────────────────────────────────────

/** Whole days from now until `iso`. Negative once the date has passed. */
export function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Intl handles the pluralisation, unit names and locale that four hand-rolled
// `if (diff < 3600)` ladders were approximating for English only.
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
];

/**
 * "just now" / "5s ago" / "3h ago" / "12d ago", falling back to an absolute date
 * past a month — at that distance "47d ago" stops being the useful answer.
 */
export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';

  let value = ms / 1000;
  for (const [unit, step] of UNITS) {
    if (value < step) return rtf.format(-Math.round(value), unit);
    value /= step;
  }
  return formatDate(iso);
}

// ─── Badges ──────────────────────────────────────────────────────────────────
// Uppercase vocabulary = the platform's ServiceRequest / OrganizationService
// enums. The ticketing tool's own lowercase priorities live in
// app/ticketing/shared.tsx and are deliberately NOT merged here — different
// domain, different scale (it has `urgent`, this has `CRITICAL`).

export interface Badge { cls: string; dot: string; label: string }

export const priorityConfig: Record<string, Badge> = {
  CRITICAL: { cls: 'text-red-700 bg-red-50',      dot: 'bg-red-500',    label: 'Critical' },
  HIGH:     { cls: 'text-amber-700 bg-amber-50',  dot: 'bg-amber-500',  label: 'High' },
  MEDIUM:   { cls: 'text-cyan-700 bg-cyan-50',    dot: 'bg-cyan-500',   label: 'Medium' },
  LOW:      { cls: 'text-slate-600 bg-slate-100', dot: 'bg-slate-400',  label: 'Low' },
};

export const serviceStatusConfig: Record<string, Badge> = {
  ACTIVE:    { cls: 'text-emerald-700 bg-emerald-50', dot: 'bg-emerald-500', label: 'Active' },
  EXPIRING:  { cls: 'text-amber-700 bg-amber-50',     dot: 'bg-amber-500',   label: 'Expiring' },
  EXPIRED:   { cls: 'text-red-700 bg-red-50',         dot: 'bg-red-500',     label: 'Expired' },
  SUSPENDED: { cls: 'text-slate-600 bg-slate-100',    dot: 'bg-slate-400',   label: 'Suspended' },
};
