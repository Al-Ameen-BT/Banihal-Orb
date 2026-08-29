'use client';

// Presentation layer for the ops dashboard. Every panel is a pure function of the
// aggregate the server returns — no fetching, no derived business rules, so
// what the API says is what the screen says.

import { useMemo } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { DashOverview, DashAssignee, DashUser } from '@/lib/schemas';

// ─── Palette ─────────────────────────────────────────────────────────────────
// Scoped to this dashboard on purpose: the rest of the console still runs on
// emerald/amber/rose, and remapping those globally would mean a visual pass over
// 14 other pages. These are the design-spec tokens for the ops surface only.
//
// Two ramps, deliberately. The spec's hues are used AS SPECIFIED for graphical
// objects (chart fills, gauge rings, progress bars), where WCAG's threshold is
// 3:1 and all of them clear it. As small TEXT they do not: orange-600 lands at
// 3.56:1 on white and green-600 at 3.30:1, both under the 4.5:1 floor. So text
// takes the next step down the same hue — same colour language, legible label.
const T = {
  primary: '#2563EB',
  success: '#16A34A',
  warning: '#EA580C',
  danger:  '#DC2626',
  neutral: '#64748B',
  // Text-safe variants (>=4.5:1 on white, their own tints, and the page ground).
  successText: '#15803D',
  warningText: '#C2410C',
  dangerText:  '#DC2626', // 4.83:1 on white.
  // On the red-50 assignee-card tint #DC2626 drops to 4.41:1, so the stuck
  // count — the one danger string rendered on that tint — goes a step darker.
  dangerOnTint: '#B91C1C',
} as const;

// Sequential blue by RANK — slice 1 is always darkest, whatever issue happens to
// lead this week. A ramp encodes ordering, which is the actual message of a
// "top 7" list; it is only safe because the legend directly labels every slice
// with its name, count and share, so identity never rests on the hue alone.
export const ISSUE_HUES = ['#1E3A8A', '#1E40AF', '#1D4ED8', '#2563EB', '#3B82F6', '#60A5FA', '#93C5FD'];
const OTHER_HUE = '#94A3B8';
const BAR_HUE = T.primary;
const PEAK_HUE = T.danger;

// ─── Small shared pieces ─────────────────────────────────────────────────────

/// White card: the unit every panel is built from.
export function SectionCard({ title, subtitle, action, children, className = '' }: {
  title?: string; subtitle?: string; action?: React.ReactNode;
  children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-6 shadow-card ${className}`}>
      {(title || action) && (
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {title && <h3 className="text-[15px] font-semibold text-slate-900">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/// Tinted band grouping several cards under one heading — the next level up from
/// SectionCard, used where a section needs its own title and scope line.
export function SectionBand({ title, subtitle, action, children }: {
  title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white/60 p-6 lg:p-8">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

type Tone = 'brand' | 'success' | 'warning' | 'danger' | 'neutral';

const toneRing: Record<Tone, string> = {
  brand:   'bg-blue-50 text-blue-700',
  success: 'bg-green-50 text-green-700',
  warning: 'bg-orange-50 text-orange-700',
  danger:  'bg-red-50 text-red-700',
  neutral: 'bg-slate-100 text-slate-600',
};

const pillTone: Record<Tone, string> = {
  brand:   'bg-blue-600 text-white',
  success: 'bg-green-600 text-white',
  warning: 'bg-orange-600 text-white',
  danger:  'bg-red-600 text-white',
  neutral: 'bg-slate-200 text-slate-700',
};

/// Small badge. `outline` is the quiet action variant ("View All", counts);
/// `solid` carries a status colour (demand bands).
export function Pill({ children, variant = 'outline', tone = 'brand', href, className = '' }: {
  children: React.ReactNode; variant?: 'outline' | 'solid'; tone?: Tone;
  href?: string; className?: string;
}) {
  const cls = variant === 'solid'
    ? pillTone[tone]
    : 'border border-blue-200 text-blue-700 hover:bg-blue-50';
  const base = `inline-block shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${cls} ${className}`;

  if (href) {
    return (
      <a
        href={href}
        className={`${base} cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2`}
      >
        {children}
      </a>
    );
  }
  return <span className={base}>{children}</span>;
}

/// A hero number with its label — no plot, so no hover layer.
export function StatTile({ label, value, tone = 'brand', icon, suffix, footer }: {
  label: string; value: number | string; tone?: Tone;
  icon: string; suffix?: string; footer?: React.ReactNode;
}) {
  const shown = typeof value === 'number' ? value.toLocaleString() : value;
  return (
    // The whole tile carries one accessible name, so a screen reader announces
    // "1,514 Total Tickets" rather than an orphaned number next to a bare label.
    <div className="rounded-lg border border-slate-200 bg-white p-4" role="group" aria-label={`${shown}${suffix ?? ''} ${label}`}>
      <div className="flex items-center gap-3">
        <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${toneRing[tone]}`} aria-hidden="true">
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2}
               strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d={icon} />
          </svg>
        </span>
        <span className="font-mono text-[1.75rem] font-bold leading-none tracking-tight text-slate-900 tabular-nums">
          {shown}{suffix}
        </span>
      </div>
      <p className="mt-3 text-xs text-slate-500">{label}</p>
      {footer}
    </div>
  );
}

export const ICONS = {
  doc: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  check: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  trend: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6',
  alert: 'M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z',
  clock: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  users: 'M17 20h5v-2a3 3 0 00-5.36-1.86M17 20H7m10 0v-2c0-.66-.13-1.3-.36-1.86m0 0a5 5 0 00-9.28 0M7 20H2v-2a3 3 0 015.36-1.86M7 20v-2c0-.66.13-1.3.36-1.86m0 0a5 5 0 019.28 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
  building: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
};

/// Tiny magnitude trace. One series, one hue, no axes — it exists to show shape,
/// so exact values stay in the hero number beside it.
export function Sparkline({ values, hue }: { values: number[]; hue: string }) {
  const max = Math.max(1, ...values);
  return (
    <div className="mt-2 flex h-6 items-end gap-[3px]" aria-hidden="true">
      {values.map((v, i) => (
        <span
          key={i}
          className="w-2 rounded-sm"
          style={{ height: `${Math.max(8, (v / max) * 100)}%`, backgroundColor: hue, opacity: 0.35 + 0.65 * (v / max) }}
        />
      ))}
    </div>
  );
}

/// Labelled horizontal magnitude bar. `count · pct` sits beside the label so the
/// bar length is reinforcement rather than the only reading of the value.
export function HBar({ label, count, pct, fillPct, hue = BAR_HUE }: {
  label: string; count: number; pct: number; fillPct: number; hue?: string;
}) {
  return (
    <li className="rounded-lg border border-slate-200 px-3.5 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs font-semibold text-slate-800" title={label}>{label}</span>
        <span className="shrink-0 font-mono text-[11px] text-slate-500 tabular-nums">
          {count.toLocaleString()} · {pct}%
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full" style={{ width: `${fillPct}%`, backgroundColor: hue }} />
      </div>
    </li>
  );
}

// ─── Stat grids ──────────────────────────────────────────────────────────────

export function TicketStatsPanel({ d, href }: { d: DashOverview; href?: string }) {
  const s = d.ticketStats;
  return (
    <SectionCard title="Ticket Statistics" action={href ? <Pill href={href}>View All</Pill> : undefined}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Total Tickets" value={s.total} icon={ICONS.doc} tone="brand" />
        <StatTile label="Completed" value={s.completed} icon={ICONS.check} tone="success" />
        <StatTile label="In Progress" value={s.inProgress} icon={ICONS.trend} tone="warning" />
        <StatTile label="High Priority" value={s.highPriority} icon={ICONS.alert} tone="danger" />
        <StatTile label="To Do" value={s.todo} icon={ICONS.clock} tone="brand" />
        <StatTile
          label="Completion Rate"
          value={s.completionRate}
          suffix="%"
          icon={ICONS.trend}
          tone="brand"
          footer={
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full" style={{ width: `${s.completionRate}%`, backgroundColor: T.primary }} />
            </div>
          }
        />
      </div>
    </SectionCard>
  );
}

export function ProjectStatsPanel({ d, href }: { d: DashOverview; href?: string }) {
  const p = d.projectStats;
  return (
    <SectionCard title="Project Statistics" action={href ? <Pill href={href}>View All</Pill> : undefined}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Total Projects" value={p.total} icon={ICONS.doc} tone="brand" />
        <StatTile label="Completed" value={p.completed} icon={ICONS.check} tone="success" />
        <StatTile label="Active" value={p.active} icon={ICONS.trend} tone="warning" />
        <StatTile label="At Risk" value={p.atRisk} icon={ICONS.alert} tone="danger" />
        <StatTile label="On Track" value={p.onTrack} icon={ICONS.check} tone="success" />
      </div>
    </SectionCard>
  );
}

// ─── Issue distribution ──────────────────────────────────────────────────────

export function IssueDonut({ d }: { d: DashOverview }) {
  const { top, other, total, top3Pct, weekDeltaPct } = d.issueDistribution;
  const slices = useMemo(
    () => [...top, ...(other.count > 0 ? [other] : [])],
    [top, other],
  );
  const hueFor = (i: number) => (i < top.length ? ISSUE_HUES[i]! : OTHER_HUE);

  return (
    <SectionCard title="Issue Distribution (Donut)">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* 2px gaps between slices keep adjacent steps of the blue ramp readable
            where their lightness difference is smallest. */}
        <div className="relative h-64">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices} dataKey="count" nameKey="label"
                innerRadius="62%" outerRadius="92%" paddingAngle={2} stroke="#64748B" strokeWidth={1}
                startAngle={90} endAngle={-270} isAnimationActive={false}
              >
                {slices.map((s, i) => <Cell key={s.label} fill={hueFor(i)} />)}
              </Pie>
              <Tooltip content={<DonutTip />} />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-3xl font-bold tracking-tight text-slate-900 tabular-nums">
              {total.toLocaleString()}
            </span>
            <span className="text-[11px] text-slate-500">Total Tickets</span>
            {weekDeltaPct !== 0 && (
              <span
                className="mt-0.5 text-[11px] font-semibold tabular-nums"
                style={{ color: weekDeltaPct > 0 ? T.dangerText : T.successText }}
              >
                {weekDeltaPct > 0 ? '↑' : '↓'} {weekDeltaPct > 0 ? '+' : ''}{weekDeltaPct}% this week
              </span>
            )}
          </div>
        </div>

        {/* Legend doubles as the direct-label layer: every slice carries its name,
            count and share, so identity never rests on colour alone. */}
        <div>
          <p className="mb-2 text-xs font-semibold text-slate-700">Top {top.length} Issue Legend</p>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {slices.map((s, i) => (
              <li key={s.label} className="flex items-center gap-3 px-3.5 py-2.5">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: hueFor(i) }} aria-hidden="true" />
                <span className="min-w-0 flex-1 text-xs font-medium text-slate-700" title={s.label}>{s.label}</span>
                <span className="shrink-0 font-mono text-xs font-semibold text-slate-600 tabular-nums">
                  {s.count.toLocaleString()} ({s.pct}%)
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-4 rounded-lg bg-blue-50 p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-blue-700">Insight</p>
            <p className="mt-1.5 text-xs text-slate-700">
              Top 3 issues contribute <strong className="tabular-nums">{top3Pct}%</strong> of all tickets
            </p>
            {other.pct >= 40 && (
              <p className="mt-1 text-xs font-medium" style={{ color: T.warningText }}>
                {other.pct}% of tickets fall under Other → improve categorization
              </p>
            )}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

function DonutTip({ active, payload }: { active?: boolean; payload?: Array<{ name?: string; value?: number; payload?: { pct: number } }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-pop">
      <p className="max-w-[16rem] text-xs font-semibold text-slate-900">{p.name}</p>
      <p className="mt-0.5 font-mono text-xs text-slate-500 tabular-nums">
        {(p.value ?? 0).toLocaleString()} tickets · {p.payload?.pct ?? 0}%
      </p>
    </div>
  );
}

// ─── KPI + live feed ─────────────────────────────────────────────────────────

export function KpiLivePanel({ d }: { d: DashOverview }) {
  const k = d.kpi;
  return (
    <SectionCard title="KPI + Live Panel">
      <div className="space-y-3">
        {/* Tints are FIXED per metric, not derived from the value: a tile that
            changes colour as the number moves makes the panel flicker between
            refreshes. Only the SLA figure carries a severity colour, on its value. */}
        <KpiTile label="Tickets Today" value={k.ticketsToday} spark={k.createdSpark} box="bg-green-50" hue={T.success} />
        <KpiTile label="Open Tickets" value={k.openTickets} spark={k.openSpark} box="bg-green-50" hue={T.success} />
        <KpiTile
          label="SLA Breach %"
          value={`${k.slaBreachPct}%`}
          spark={k.breachSpark}
          box="bg-orange-50"
          hue={T.warning}
          valueStyle={{ color: T.warningText }}
        />
      </div>

      {k.alert && (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-orange-50 p-3">
          <svg className="mt-0.5 h-4 w-4 shrink-0" style={{ color: T.warning }} width="16" height="16" fill="none"
               stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
            <path d={ICONS.alert} />
          </svg>
          {/* orange-800 on orange-50, not orange-600: the spec's accent hue clears
              4.5:1 as a chart fill but not as small body text on its own tint. */}
          <p className="text-xs font-medium text-orange-800">{k.alert}</p>
        </div>
      )}

      <p className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400">Latest Activity</p>
      <ul className="space-y-2">
        {d.recent.length === 0 && <li className="py-3 text-xs text-slate-400">No tickets yet.</li>}
        {d.recent.map((t) => (
          <li key={t.id} className="text-xs leading-snug">
            <span className="font-semibold text-slate-800">{t.title}</span>
            <time className="ml-1.5 font-mono text-[11px] text-slate-400 tabular-nums" dateTime={t.createdAt}>
              {new Date(t.createdAt).toLocaleString()}
            </time>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function KpiTile({ label, value, spark, box, hue, valueStyle }: {
  label: string; value: number | string; spark: number[];
  box: string; hue: string; valueStyle?: React.CSSProperties;
}) {
  return (
    <div className={`rounded-xl p-3.5 ${box}`}>
      <p className="text-[11px] font-medium text-slate-600">{label}</p>
      <p className="mt-0.5 font-mono text-xl font-bold text-slate-900 tabular-nums" style={valueStyle}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      <Sparkline values={spark} hue={hue} />
    </div>
  );
}

// ─── Daily volume ────────────────────────────────────────────────────────────

export function DailyVolumePanel({ d }: { d: DashOverview }) {
  const { points, peakDate, peakCreated, average } = d.daily;
  return (
    <SectionCard
      title="Daily Ticket Volume"
      subtitle="Rectangular bars with peak highlight and daily top issue in tooltip."
    >
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 8, right: 8, bottom: 4, left: -16 }} barCategoryGap={1}>
            {/* Horizontal rules only — vertical ones at this bar density read as
                more bars. */}
            <CartesianGrid vertical={false} stroke="#E2E8F0" strokeDasharray="3 3" />
            <XAxis
              dataKey="date" tickLine={false} axisLine={{ stroke: '#E2E8F0' }}
              tick={{ fill: '#94A3B8', fontSize: 11 }} minTickGap={48}
              tickFormatter={(v: string) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            />
            <YAxis tickLine={false} axisLine={false} tick={{ fill: '#94A3B8', fontSize: 11 }} width={40} allowDecimals={false} />
            <Tooltip cursor={{ fill: '#F1F5F9' }} content={<VolumeTip />} />
            {/* One series, so no legend — the panel title names it. The peak is
                re-coloured and called out below rather than labelled in place,
                which would collide at this bar density. */}
            <Bar dataKey="created" radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {points.map((p) => (
                <Cell key={p.date} fill={p.date === peakDate ? PEAK_HUE : BAR_HUE} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
        {peakDate && (
          <p className="text-xs font-semibold" style={{ color: T.dangerText }}>
            Peak day: {peakDate} — {peakCreated} tickets
          </p>
        )}
        <p className="text-xs text-slate-500">Average: {average} tickets/day</p>
      </div>
    </SectionCard>
  );
}

function VolumeTip({ active, payload, label }: {
  active?: boolean; label?: string;
  payload?: Array<{ value?: number; payload?: { topIssue: string | null } }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!;
  return (
    <div className="max-w-[18rem] rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-pop">
      <p className="text-xs font-semibold text-slate-900">
        {label ? new Date(label).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''}
      </p>
      <p className="mt-0.5 font-mono text-xs text-slate-500 tabular-nums">{p.value ?? 0} tickets</p>
      {p.payload?.topIssue && <p className="mt-1 truncate text-[11px] text-slate-500">Top issue: {p.payload.topIssue}</p>}
    </div>
  );
}

// ─── Branch distribution ─────────────────────────────────────────────────────

export function BranchPanel({ d }: { d: DashOverview }) {
  const { rows, average, topVsAverage } = d.branches;
  const max = Math.max(1, ...rows.map((r) => r.count));
  const top = rows[0];
  return (
    <SectionCard title="Branch Distribution">
      <ul className="space-y-2.5">
        {rows.length === 0 && <li className="text-xs text-slate-400">No branch data.</li>}
        {rows.slice(0, 8).map((r) => (
          <HBar key={r.branch} label={r.branch} count={r.count} pct={r.pct} fillPct={(r.count / max) * 100} />
        ))}
      </ul>
      <p className="mt-4 text-xs text-slate-500">Average: {average} tickets</p>
      {top && topVsAverage && topVsAverage > 1.5 && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium" style={{ color: T.warningText }}>
          <svg className="mt-0.5 h-3.5 w-3.5 shrink-0" width="14" height="14" fill="none" stroke="currentColor"
               strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
            <path d={ICONS.building} />
          </svg>
          <span>Branch {top.branch} contributes {top.pct}% → {topVsAverage}× above average</span>
        </p>
      )}
    </SectionCard>
  );
}

// ─── Assignee performance ────────────────────────────────────────────────────

/// Matches the grouping key in the server's dashboardAggregate — tickets with
/// no assignee are rolled into one synthetic card rather than dropped.
const UNASSIGNED_ID = '__unassigned__';

/// Closure-rate gauge. The ring colour is a STATUS band, and it always ships with
/// the numeric rate inside it — the colour is reinforcement, never the only signal.
///
/// Order matters: a 0% assignee reads grey even when they are sitting on stuck
/// work (their queue has simply never moved), and a rounded 100% stays green even
/// with one straggler. Everything between those is amber unless work has actually
/// gone quiet, which is the case worth colouring red.
function RingGauge({ pct, stuck }: { pct: number; stuck: number }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const shown = Math.round(pct);
  const band = shown <= 0 ? T.neutral
    : shown >= 100 ? T.success
      : stuck > 0 ? T.danger
        : T.warning;
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" className="shrink-0" role="img"
         aria-label={`${shown}% closure rate, ${stuck} stuck ${stuck === 1 ? 'ticket' : 'tickets'}`}>
      <circle cx="28" cy="28" r={r} fill="none" stroke="#E2E8F0" strokeWidth="5" />
      <circle
        cx="28" cy="28" r={r} fill="none" stroke={band} strokeWidth="5" strokeLinecap="round"
        strokeDasharray={`${(shown / 100) * c} ${c}`} transform="rotate(-90 28 28)"
      />
      <text x="28" y="32" textAnchor="middle" className="fill-slate-900 font-mono text-[11px] font-bold">{shown}%</text>
    </svg>
  );
}

export function AssigneePanel({ rows }: { rows: DashAssignee[] }) {
  return (
    <SectionCard
      title="Assignee Performance"
      action={<span className="text-slate-400" aria-hidden="true">
        <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2}
             strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d={ICONS.users} /></svg>
      </span>}
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.length === 0 && <p className="text-xs text-slate-400">No assignees yet.</p>}
        {rows.map((a) => {
          const flagged = a.stuck > 0 || a.closureRate === 0;
          return (
            <article key={a.id} className={`rounded-xl border p-4 ${flagged ? 'border-red-200 bg-red-50/40' : 'border-green-200 bg-green-50/30'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="truncate text-sm font-semibold text-slate-900" title={a.name}>{a.name}</h4>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-500 tabular-nums">
                    Closed: {a.closed} | Open: {a.open}
                  </p>
                </div>
                <RingGauge pct={a.closureRate} stuck={a.stuck} />
              </div>

              <dl className="mt-3 space-y-1 border-t border-slate-200/70 pt-3 text-[11px]">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Closure Rate:</dt>
                  <dd className="font-mono font-semibold text-slate-800 tabular-nums">{a.closureRate}%</dd>
                </div>
                <div>
                  <span className="font-medium tabular-nums" style={{ color: a.stuck > 0 ? T.dangerOnTint : T.successText }}>
                    {a.stuck} stuck {a.stuck === 1 ? 'ticket' : 'tickets'}
                  </span>
                </div>
                {/* Rendered even when empty — an assignee with no closed work still
                    needs a row here, or their card silently loses a line and the
                    grid stops aligning. */}
                <div className="flex justify-between gap-2">
                  <dt className="min-w-0 truncate text-slate-500" title={a.slowestTitle ?? undefined}>
                    Slowest: {a.slowestTitle ?? 'n/a'}
                  </dt>
                  <dd className="shrink-0 font-mono font-semibold text-slate-800 tabular-nums">
                    ({a.slowestHours.toFixed(1)} hrs)
                  </dd>
                </div>
              </dl>

              {/* Deep link into the ticket list with this person's queue already
                  filtered. The unassigned bucket is a synthetic id the gateway
                  invents to group orphaned tickets — it filters to nothing, so it
                  gets the label without the link. */}
              {a.id !== UNASSIGNED_ID ? (
                <a
                  href={`/ticketing?assignee=${encodeURIComponent(a.id)}`}
                  className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded"
                >
                  View Details
                  <span aria-hidden="true">→</span>
                  <span className="sr-only">for {a.name}</span>
                </a>
              ) : (
                <p className="mt-3 text-[11px] text-slate-400">Unassigned queue</p>
              )}
            </article>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ─── Top requested clients ───────────────────────────────────────────────────

const demandTone: Record<string, Tone> = { high: 'danger', medium: 'warning', low: 'neutral' };

export function ClientsPanel({ d }: { d: DashOverview }) {
  return (
    <SectionCard
      title="Top Requested Clients"
      action={<span className="text-slate-400" aria-hidden="true">
        <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2}
             strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d={ICONS.building} /></svg>
      </span>}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[24rem] text-left">
          <thead>
            <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
              <th className="pb-2 pr-3 font-semibold">Client</th>
              <th className="px-3 pb-2 text-right font-semibold">Count</th>
              <th className="px-3 pb-2 text-right font-semibold">Total</th>
              <th className="pb-2 pl-3 text-right font-semibold">Priority</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {d.clients.length === 0 && (
              <tr><td colSpan={4} className="py-4 text-xs text-slate-400">No client data.</td></tr>
            )}
            {d.clients.map((c) => (
              <tr key={c.id}>
                <td className="max-w-[14rem] truncate py-2.5 pr-3 text-xs font-semibold text-slate-800" title={c.name}>{c.name}</td>
                <td className="px-3 py-2.5 text-right font-mono text-xs text-slate-700 tabular-nums">{c.open.toLocaleString()}</td>
                <td className="px-3 py-2.5 text-right font-mono text-xs text-slate-500 tabular-nums">{c.total.toLocaleString()}</td>
                <td className="py-2.5 pl-3 text-right">
                  <Pill variant="solid" tone={demandTone[c.demand] ?? 'neutral'} className="capitalize">{c.demand}</Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ─── Per-user load grid (ORG_ADMIN) ──────────────────────────────────────────

export function UserLoadPanel({ rows }: { rows: DashUser[] }) {
  const busiest = rows[0]?.open ?? 0;
  return (
    <SectionCard
      title="User Ticket Load"
      subtitle="Your organisation's people, ordered by open tickets — who is carrying the backlog"
      action={<Pill>{rows.length} users</Pill>}
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.length === 0 && <p className="text-xs text-slate-400">Nobody in your organisation has raised a ticket yet.</p>}
        {rows.map((u) => {
          // The top card is flagged only when it is a genuine outlier, not just
          // first in a flat list — otherwise every dashboard has a "problem" user.
          const isOutlier = busiest > 0 && u.open === busiest && rows.length > 1 && u.open >= 2 * (rows[1]?.open ?? 0);
          return (
            <article key={u.id} className={`rounded-xl border p-4 ${isOutlier ? 'border-orange-300 bg-orange-50/50' : 'border-slate-200 bg-white'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="truncate text-sm font-semibold text-slate-900" title={u.name}>{u.name}</h4>
                  {u.email && <p className="mt-0.5 truncate text-[11px] text-slate-500" title={u.email}>{u.email}</p>}
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-2xl font-bold leading-none text-slate-900 tabular-nums">{u.open}</p>
                  <p className="text-[10px] uppercase tracking-[0.08em] text-slate-400">open</p>
                </div>
              </div>

              {/* Open vs completed as one bar — proportion is the point, so the
                  two segments share a track with a 2px gap between them. */}
              <div className="mt-3 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full" style={{ width: `${u.total ? (u.open / u.total) * 100 : 0}%`, backgroundColor: T.warning }} />
                <div className="h-full rounded-full" style={{ width: `${u.total ? (u.completed / u.total) * 100 : 0}%`, backgroundColor: T.success }} />
              </div>

              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Metric label="Total" value={u.total} />
                <Metric label="Closed" value={u.completed} tone="text-green-700" />
                <Metric label="High pri" value={u.highPriority} tone={u.highPriority > 0 ? 'text-red-700' : undefined} />
              </dl>

              <p className="mt-3 border-t border-slate-100 pt-2.5 text-[11px] text-slate-500">
                {u.open > 0
                  ? <>Avg open age <strong className="font-mono tabular-nums">{u.avgOpenAgeHours}h</strong></>
                  : 'No open tickets'}
                {u.lastActivityAt && <> · last activity {new Date(u.lastActivityAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</>}
              </p>

              {isOutlier && (
                <p className="mt-2 text-[11px] font-semibold" style={{ color: T.warningText }}>Carrying the largest share of open work.</p>
              )}
            </article>
          );
        })}
      </div>
    </SectionCard>
  );
}

function Metric({ label, value, tone = 'text-slate-800' }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 py-1.5">
      <dd className={`font-mono text-sm font-bold tabular-nums ${tone}`}>{value}</dd>
      <dt className="text-[10px] text-slate-400">{label}</dt>
    </div>
  );
}
