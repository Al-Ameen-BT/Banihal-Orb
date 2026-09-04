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

// ─── Platform staff roles ────────────────────────────────────────────────────
// The SECOND role axis. Every platform staff member is `ADMINISTRATOR` on the
// legacy User.role enum, so colouring by that enum painted Administration,
// HR Admin, Employee and Intern identically — which is why the sidebar showed
// the same "ADMINISTRATION" tag to everyone on every page.
//
// Keyed on platformRole.KEY, never the display name: names are editable through
// the roles API and custom roles can be created, so the name is not an identity.
export const platformRoleBadge: Record<string, Badge> = {
  administration: { cls: 'text-emerald-700 bg-emerald-50', dot: 'bg-emerald-500', label: 'Administration' },
  hr_admin:       { cls: 'text-amber-700 bg-amber-50',     dot: 'bg-amber-500',   label: 'HR Admin' },
  employee:       { cls: 'text-brand-700 bg-brand-50',     dot: 'bg-brand-500',   label: 'Employee' },
  intern:         { cls: 'text-slate-600 bg-slate-100',    dot: 'bg-slate-400',   label: 'Intern' },
};

/**
 * Resolve a platform role to its badge, falling back to neutral slate for roles
 * created at runtime — carrying the server's own name through, so a custom role
 * still reads correctly instead of rendering as "Staff" or unstyled.
 *
 * Tailwind has no safelist, so every class above is a full literal string; a
 * built-up `text-${hue}-700` would be purged and the badge would lose its colour.
 */
export function roleBadgeFor(role?: { key: string; name: string } | null): Badge {
  if (!role) return { cls: 'text-slate-600 bg-slate-100', dot: 'bg-slate-400', label: 'Staff' };
  return platformRoleBadge[role.key] ?? { cls: 'text-slate-600 bg-slate-100', dot: 'bg-slate-400', label: role.name };
}

/** Just the text colour, for headings that aren't pills (dashboard eyebrows). */
export const roleTextCls = (b: Badge): string => b.cls.split(' ')[0] ?? 'text-slate-600';
