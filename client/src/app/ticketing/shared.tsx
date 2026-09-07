'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { ticketingApi, botsApi } from '@/lib/api';
import GlowButton from '@/components/ui/GlowButton';
import { BotFieldGrid } from '@/components/BotFormFields';
import { useAuth } from '@/contexts/AuthContext';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import type { TicketDTO, TicketProject, TicketStatus, TicketPriority, TicketType, SlaStatus, SlaEvaluation, Role, OrgBot } from '@/lib/schemas';

// ─── Option sets ──────────────────────────────────────────────────────────────
export const TICKET_TYPES: { value: TicketType; label: string }[] = [
  { value: 'task', label: 'Task' }, { value: 'bug', label: 'Bug' },
  { value: 'story', label: 'Story' }, { value: 'feature', label: 'Feature' },
];
export const PRIORITY_OPTIONS: { value: TicketPriority; label: string }[] = [
  { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' },
];
export const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: 'todo', label: 'To Do' }, { value: 'in_progress', label: 'In Progress' },
  { value: 'client_pending', label: 'Client Pending' }, { value: 'completed', label: 'Completed' },
];
// Canonical column order for board / pipeline views.
export const STATUS_ORDER: TicketStatus[] = ['todo', 'in_progress', 'client_pending', 'completed'];

// ─── Config ───────────────────────────────────────────────────────────────────
export const statusCfg: Record<string, { cls: string; dot: string; bar: string; label: string }> = {
  todo:           { cls: 'text-slate-600 bg-slate-100 ring-slate-500/15',     dot: 'bg-slate-400',   bar: 'bg-slate-400',   label: 'To Do' },
  in_progress:    { cls: 'text-cyan-700 bg-cyan-50 ring-cyan-600/15',         dot: 'bg-cyan-500',    bar: 'bg-cyan-400',    label: 'In Progress' },
  client_pending: { cls: 'text-amber-700 bg-amber-50 ring-amber-600/15',      dot: 'bg-amber-500',   bar: 'bg-amber-400',   label: 'Client Pending' },
  completed:      { cls: 'text-emerald-700 bg-emerald-50 ring-emerald-600/15', dot: 'bg-emerald-500', bar: 'bg-emerald-400', label: 'Completed' },
};
export const priorityCls: Record<string, string> = {
  urgent: 'text-red-700 bg-red-50 ring-red-600/15',
  high:   'text-amber-700 bg-amber-50 ring-amber-600/15',
  medium: 'text-cyan-700 bg-cyan-50 ring-cyan-600/15',
  low:    'text-slate-600 bg-slate-100 ring-slate-500/15',
};
export const priorityDot: Record<string, string> = {
  urgent: 'bg-red-500', high: 'bg-amber-500', medium: 'bg-cyan-500', low: 'bg-slate-400',
};
export const typeLabel: Record<string, string> = { bug: 'Bug', feature: 'Feature', task: 'Task', story: 'Story' };
const slaCfg: Record<SlaStatus, { cls: string; label: string }> = {
  breached: { cls: 'text-red-700 bg-red-50 ring-red-600/15', label: 'Breached' },
  critical: { cls: 'text-red-700 bg-red-50 ring-red-600/15', label: 'Critical' },
  warning:  { cls: 'text-amber-700 bg-amber-50 ring-amber-600/15', label: 'At risk' },
  paused:   { cls: 'text-slate-600 bg-slate-100 ring-slate-500/15', label: 'Paused' },
  normal:   { cls: 'text-emerald-700 bg-emerald-50 ring-emerald-600/15', label: 'On track' },
  none:     { cls: 'text-slate-500 bg-slate-50 ring-slate-400/15', label: 'No SLA' },
};

// ─── Inline icons (Heroicons, 24×24 stroke) ─────────────────────────────────────
type IconProps = { className?: string };
export const Icons = {
  list: (p: IconProps) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" /></svg>,
  board: (p: IconProps) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3.75 5.25h4.5v13.5h-4.5zM9.75 5.25h4.5v9h-4.5zM15.75 5.25h4.5v6h-4.5z" /></svg>,
  search: (p: IconProps) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>,
  plus: (p: IconProps) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.5v15m7.5-7.5h-15" /></svg>,
  close: (p: IconProps) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" /></svg>,
  chevron: (p: IconProps) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m19 9-7 7-7-7" /></svg>,
  ticket: (p: IconProps) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 0 1 0 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 0 1 0-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375Z" /></svg>,
  chat: (p: IconProps) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg>,
  paperclip: (p: IconProps) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13" /></svg>,
  eye: (p: IconProps) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>,
  filter: (p: IconProps) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z" /></svg>,
};

const typeIcon: Record<string, (p: IconProps) => React.JSX.Element> = {
  bug:     (p) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M12 12.75c1.148 0 2.278.08 3.383.237 1.037.146 1.866.966 1.866 2.013 0 3.728-2.35 6.75-5.25 6.75S6.75 18.728 6.75 15c0-1.046.83-1.867 1.866-2.013A24.2 24.2 0 0 1 12 12.75Zm0 0V8.25m0 0a3 3 0 0 0-3-3m3 3a3 3 0 0 1 3-3m-9 9h.008v.008H3v-.008Zm.375 3h.008v.008h-.008v-.008ZM21 12.75h-.008v.008H21v-.008Zm-.375 3h-.008v.008h.008v-.008Z" /></svg>,
  feature: (p) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" /></svg>,
  task:    (p) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>,
  story:   (p) => <svg {...p} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" /></svg>,
};

// ─── Badges ───────────────────────────────────────────────────────────────────
export function StatusBadge({ status }: { status: string }) {
  const cfg = statusCfg[status] ?? statusCfg['todo']!;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold ring-1 ring-inset ${cfg.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />{cfg.label}
    </span>
  );
}
export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold ring-1 ring-inset ${priorityCls[priority] ?? priorityCls['low']}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${priorityDot[priority] ?? priorityDot['low']}`} />
      {priority.charAt(0).toUpperCase() + priority.slice(1)}
    </span>
  );
}
export function TypeBadge({ type }: { type: string }) {
  const Ico = typeIcon[type];
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold text-slate-600 bg-slate-100 ring-1 ring-inset ring-slate-500/15">
      {Ico && <Ico className="w-3 h-3" />}{typeLabel[type] ?? type}
    </span>
  );
}
export function SlaBadge({ status, remainingSeconds }: { status: SlaStatus; remainingSeconds: number | null }) {
  // Same hazard SlaBar guards against below: an unknown/absent status yields
  // undefined here, and reading cfg.cls then throws — which unmounts the whole
  // page to the app error boundary over one malformed ticket. Every sibling
  // badge in this file already falls back; this one did not.
  const cfg = slaCfg[status] ?? slaCfg['none']!;
  const extra = status !== 'none' && status !== 'paused' && remainingSeconds != null
    ? ` · ${remainingSeconds <= 0 ? 'overdue' : formatDuration(remainingSeconds)}`
    : '';
  return <span className={`inline-flex px-2 py-0.5 rounded-md text-[11px] font-semibold ring-1 ring-inset ${cfg.cls}`}>{cfg.label}{extra}</span>;
}

// Dual SLA progress bar (matches the reference images: a labelled bar + a status pill
// that reads "<Response|Resolution> SLA Stopped" when the clock is not running —
// i.e. paused (client_pending) or the ticket is completed).
export function SlaBar({ label, evaluation }: { label: 'Response' | 'Resolution'; evaluation?: SlaEvaluation | null }) {
  // Destructuring an absent evaluation throws, and a throw here takes the whole
  // page to the error boundary — one ticket missing SLA data would unmount the
  // list. A ticket without an SLA is a normal state, so render it as one.
  const { status, budgetSeconds, remainingSeconds } = evaluation
    ?? { status: 'none' as SlaEvaluation['status'], budgetSeconds: null, remainingSeconds: null };
  const none = budgetSeconds == null;
  const stopped = status === 'paused' || (budgetSeconds != null && remainingSeconds == null);
  const overdue = !none && remainingSeconds != null && remainingSeconds <= 0;
  const ratio = none ? 0
    : remainingSeconds == null ? 1
    : Math.min(1, Math.max(0, 1 - remainingSeconds / budgetSeconds!));
  const barTone = none ? 'bg-slate-200'
    : overdue || status === 'breached' || status === 'critical' ? 'bg-red-500'
    : status === 'warning' ? 'bg-amber-500'
    : stopped ? 'bg-slate-300'
    : 'bg-emerald-500';
  const pillTone = none || stopped ? 'text-slate-500 bg-slate-100'
    : overdue || status === 'breached' || status === 'critical' ? 'text-red-700 bg-red-50'
    : status === 'warning' ? 'text-amber-700 bg-amber-50'
    : 'text-emerald-700 bg-emerald-50';
  const pill = none ? 'No SLA'
    : stopped ? `${label} SLA Stopped`
    : overdue ? 'Overdue'
    : `${formatDuration(remainingSeconds ?? 0)} left`;
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between mb-1 gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label} SLA</span>
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${pillTone}`}>{pill}</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${barTone}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

// ─── Avatar (deterministic initials chip) ───────────────────────────────────────
const AVATAR_TONES = ['bg-brand-50 text-brand', 'bg-emerald-50 text-emerald-600', 'bg-amber-50 text-amber-600', 'bg-violet-50 text-violet-600', 'bg-cyan-50 text-cyan-600', 'bg-rose-50 text-rose-600'];
export function Avatar({ name, size = 'sm' }: { name?: string | null; size?: 'xs' | 'sm' | 'md' }) {
  const label = (name ?? '?').trim();
  const initials = label.split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';
  let hash = 0; for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  const tone = AVATAR_TONES[hash % AVATAR_TONES.length];
  const dim = size === 'xs' ? 'w-5 h-5 text-[9px]' : size === 'md' ? 'w-8 h-8 text-xs' : 'w-6 h-6 text-[10px]';
  return <span title={label} className={`inline-flex items-center justify-center rounded-full font-bold flex-shrink-0 ${dim} ${tone}`}>{initials}</span>;
}

// ─── Person (identity value) ────────────────────────────────────────────────────
// Avatar + name + email inside a narrow column. Stacked on two lines and BOTH lines
// truncate, because the obvious one-line `inline-flex` version overflows: name and
// email become flex items, a flex item's default `min-width: auto` floors it at
// min-content, and `break-words` does NOT reduce min-content width (only
// `word-break: break-all` does) — so the row spills out of its cell instead of
// wrapping. `min-w-0` is what lets the text shrink; `title` keeps the full value
// reachable on hover so nothing is actually lost.
export function Person({ person, fallback = '—' }: {
  person?: { name: string; email?: string | null } | null; fallback?: React.ReactNode;
}) {
  if (!person) return <>{fallback}</>;
  return (
    <div className="min-w-0">
      <span className="flex items-center gap-1.5 min-w-0">
        <Avatar name={person.name} size="xs" />
        <span className="truncate" title={person.name}>{person.name}</span>
      </span>
      {person.email && (
        <span className="block truncate text-xs text-slate-400" title={person.email}>{person.email}</span>
      )}
    </div>
  );
}

// ─── Format helpers ─────────────────────────────────────────────────────────────
export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
export function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
export function formatDuration(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// ─── API error text ─────────────────────────────────────────────────────────────
// The server answers a rejected query with { error, code, details }, where a Zod
// failure puts the useful part in details.fieldErrors and leaves `error` as the
// bare string "Validation failed". Reading only `error` therefore tells the user
// nothing about WHICH filter was rejected, so name the offending fields too.
type ApiError = {
  response?: { data?: { error?: string; details?: { fieldErrors?: Record<string, string[]> } } };
};
export function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as ApiError)?.response?.data;
  if (!data) return fallback;
  const fields = Object.entries(data.details?.fieldErrors ?? {})
    .map(([field, msgs]) => `${field}: ${msgs?.[0] ?? 'invalid'}`);
  const base = data.error ?? fallback;
  return fields.length ? `${base} — ${fields.join('; ')}` : base;
}

// ─── Page header ────────────────────────────────────────────────────────────────
export function PageHeader({ eyebrow, title, subtitle, icon, actions }: {
  eyebrow: string; title: string; subtitle?: string; icon?: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
      className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div className="flex items-start gap-3.5">
        {icon && <div className="hidden sm:flex w-11 h-11 rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 ring-1 ring-brand-200/70 items-center justify-center flex-shrink-0 text-brand">{icon}</div>}
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="text-[1.6rem] font-bold tracking-tight text-slate-900 leading-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500 max-w-xl">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex-shrink-0">{actions}</div>}
    </motion.div>
  );
}

// ─── Stat strip / KPI cards ─────────────────────────────────────────────────────
export function StatStrip({ items }: { items: { label: string; value: number | string; dot: string }[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {items.map((s) => (
        <div key={s.label} className="card flex items-center gap-3 px-4 py-3">
          <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${s.dot}`} />
          <div className="min-w-0">
            <p className="font-mono text-xl font-bold text-slate-900 tabular-nums leading-none">{s.value}</p>
            <p className="text-[11px] font-medium text-slate-500 mt-1 truncate">{s.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Reusable dashboard primitives ──────────────────────────────────────────────

/** Segmented control / pill toggle. Generic over the value type. */
export function Segmented<T extends string>({ value, onChange, options, size = 'md', layoutId }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: (p: IconProps) => React.JSX.Element }[];
  size?: 'sm' | 'md'; layoutId?: string;
}) {
  const pad = size === 'sm' ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs';
  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-slate-100 ring-1 ring-slate-200/70">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} type="button" onClick={() => onChange(o.value)}
            className={`relative inline-flex items-center gap-1.5 font-semibold whitespace-nowrap rounded-lg transition-colors cursor-pointer ${pad} ${active ? 'text-brand' : 'text-slate-500 hover:text-slate-800'}`}>
            {active && <motion.span layoutId={layoutId} className="absolute inset-0 bg-white rounded-lg shadow-xs ring-1 ring-slate-200/80" transition={{ type: 'spring', stiffness: 400, damping: 32 }} />}
            <span className="relative z-10 inline-flex items-center gap-1.5">{o.icon && <o.icon className="w-3.5 h-3.5" />}{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Search box with a leading icon. */
export function SearchInput({ value, onChange, placeholder = 'Search…' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative flex-1 min-w-[180px]">
      <Icons.search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      {/* ListTicketsSchema caps `search` at 200 chars — without this the box lets
          you type past the limit and every further keystroke fires a 400. */}
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        maxLength={200} className="input !pl-9 !py-2 text-xs" />
    </div>
  );
}

/** Sticky toolbar shell for filter/search/action rows. */
export function Toolbar({ children }: { children: React.ReactNode }) {
  return (
    <div className="card px-3 py-2.5 flex items-center gap-2.5 flex-wrap sticky top-0 z-20">
      {children}
    </div>
  );
}

export function EmptyState({ icon, title, hint, action }: { icon?: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="card p-12 text-center flex flex-col items-center">
      {icon && <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3">{icon}</div>}
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {hint && <p className="text-xs text-slate-400 mt-1 max-w-xs">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Compact ticket card — used in board columns and dense list views. */
export function TicketCard({ ticket, onClick }: { ticket: TicketDTO; onClick?: () => void }) {
  const cfg = statusCfg[ticket.status] ?? statusCfg['todo']!;
  return (
    <motion.div layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}
      onClick={onClick}
      className="card group relative overflow-hidden p-3.5 cursor-pointer hover:shadow-card-hover hover:border-slate-300 transition-all">
      <span className={`absolute left-0 inset-y-0 w-1 ${cfg.bar}`} />
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-bold text-slate-400">{ticket.ticketNumber}</span>
        <PriorityBadge priority={ticket.priority} />
      </div>
      <p className="text-[13px] font-semibold text-slate-900 leading-snug mt-1.5 line-clamp-2">{ticket.title}</p>
      <div className="flex items-center justify-between gap-2 mt-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <TypeBadge type={ticket.type} />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {(ticket.counts.comments > 0) && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-slate-400"><Icons.chat className="w-3 h-3" />{ticket.counts.comments}</span>
          )}
          {ticket.assignee ? <Avatar name={ticket.assignee.name} size="xs" /> : <span className="text-[10px] font-semibold text-red-500">Unassigned</span>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-slate-100">
        <span className="text-[10px] text-slate-400 truncate">{ticket.projectName ?? 'No project'}</span>
        <span className="hidden sm:inline-flex"><SlaBadge status={ticket.slaStatus} remainingSeconds={ticket.slaRemainingSeconds} /></span>
      </div>
    </motion.div>
  );
}

/** Board (kanban) view grouping tickets by status into the canonical columns. */
export function TicketBoard({ tickets, onOpen }: { tickets: TicketDTO[]; onOpen: (id: string) => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {STATUS_ORDER.map((s) => {
        const cfg = statusCfg[s]!;
        const col = tickets.filter((t) => t.status === s);
        return (
          <div key={s} className="flex flex-col min-w-0">
            <div className="flex items-center justify-between px-1 mb-2.5">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
                <span className="text-xs font-semibold text-slate-700">{cfg.label}</span>
              </div>
              <span className="font-mono text-[11px] font-bold text-slate-400 tabular-nums">{col.length}</span>
            </div>
            <div className="flex-1 rounded-xl bg-slate-50/70 ring-1 ring-slate-200/60 p-2 space-y-2 min-h-[120px]">
              {col.length === 0
                ? <p className="text-[11px] text-slate-400 text-center py-6">No tickets</p>
                : col.map((t) => <TicketCard key={`${t.id}-${t.updatedAt}`} ticket={t} onClick={() => onOpen(t.id)} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FieldLabel({ htmlFor, children, required }: { htmlFor?: string; children: React.ReactNode; required?: boolean }) {
  return <label htmlFor={htmlFor} className="block text-[11px] font-medium text-slate-500 mb-1">{children}{required && <span className="text-red-500"> *</span>}</label>;
}

// ─── Attachments ────────────────────────────────────────────────────────────────
// One renderer for every attachment surface (ticket + comment, admin + user view):
// images become thumbnails served inline from the API with the session cookie, and
// anything else (legacy uploads — new ones are images-only) keeps a compact chip.
export function formatBytes(n: number | null): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export async function downloadAttachment(id: string, name: string) {
  const { data } = await ticketingApi.downloadAttachment(id);
  const url = URL.createObjectURL(data as Blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

type AnyAttachment = { id: string; originalName: string | null; mimeType: string | null; size: number | null };

export function AttachmentGrid({ attachments, size = 'md' }: { attachments: AnyAttachment[]; size?: 'sm' | 'md' }) {
  if (attachments.length === 0) return <p className="text-xs text-slate-400">No attachments.</p>;
  const box = size === 'sm' ? 'w-16 h-16' : 'w-24 h-24';
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((a) => {
        const name = a.originalName ?? 'attachment';
        if (a.mimeType?.startsWith('image/')) {
          return (
            <figure key={a.id} className="group relative">
              <a href={ticketingApi.attachmentUrl(a.id)} target="_blank" rel="noopener noreferrer" title={name}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={ticketingApi.attachmentUrl(a.id)} alt={name}
                  className={`${box} object-cover rounded-lg ring-1 ring-slate-200 bg-slate-50 hover:ring-brand/40 transition-colors`} />
              </a>
              <button type="button" aria-label={`Download ${name}`} onClick={() => void downloadAttachment(a.id, name)}
                className="absolute bottom-0.5 right-0.5 px-1.5 py-0.5 rounded bg-slate-900/65 text-white text-[10px] font-semibold opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
                Save
              </button>
            </figure>
          );
        }
        return (
          <button key={a.id} type="button" onClick={() => void downloadAttachment(a.id, name)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 h-fit rounded-lg text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer">
            <Icons.paperclip className="w-3.5 h-3.5 text-slate-400" />
            {name} <span className="text-slate-400">{formatBytes(a.size)}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Create ticket form (role-driven field set) ──────────────────────────────────
type FormField = 'project' | 'type' | 'priority' | 'status' | 'assignee' | 'client' | 'clientEmail' | 'contact' | 'branch' | 'onSite' | 'labels';
// 'client', 'clientEmail' + 'contact' are ADMINISTRATOR-only — they read/write the admin
// store's Customers table, which org-level roles must not reach (also enforced server-side:
// the controller strips those fields for any other role).
//
// LAYOUT RULE — the form is a 2-column grid. A field is either full-width (listed in
// FULL_WIDTH below) or half-width, and half-width fields pair up with their neighbour in
// the order below. So every UNBROKEN RUN OF HALF-WIDTH FIELDS MUST HAVE AN EVEN LENGTH:
// an odd run strands its last field beside an empty half. Adding a field means adding it
// here AND checking that parity — nothing else in this file decides the layout.
//
//   full: project / type / priority ... onSite ... labels
//   rows: status | assignee, client | clientEmail, contact | branch
const ROLE_FIELDS: Record<Role, FormField[]> = {
  USER:          ['project', 'type', 'priority'],
  ORG_ADMIN:     ['project', 'type', 'priority', 'status', 'assignee', 'labels'],
  ADMINISTRATOR: ['project', 'type', 'priority', 'status', 'assignee', 'client', 'clientEmail', 'contact', 'branch', 'onSite', 'labels'],
};

// How an assignee / staff option is labelled, for every pool in the ticketing UI.
//
// The ADMINISTRATOR pool is the whole b2b_ticketing_admin roster: B2B users bridged in
// AND people created natively in the ticketing tool. Their admin|manager|developer|tester
// role comes from the ticketing system and has nothing to do with the B2B role of the same
// name — so "Al Ameen N R · admin" next to a B2B ADMINISTRATOR reads as a contradiction.
// Administrators therefore see plain names; org-level pools keep the role, where it maps
// straight onto the platform role and is worth showing.
export function staffLabel(s: { name: string; role: string }, viewerRole?: Role): string {
  return viewerRole === 'ADMINISTRATOR' ? s.name : `${s.name} · ${s.role}`;
}

// The only place a field's width is decided. Everything unlisted is half-width.
const FULL_WIDTH: ReadonlySet<FormField> = new Set<FormField>(['project', 'type', 'priority', 'onSite', 'labels']);
const span = (f: FormField) => (FULL_WIDTH.has(f) ? 'sm:col-span-2' : undefined);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type TicketCustomer = { id: string; name: string; email: string | null; contactPerson: string | null; company: string | null };

// Synthetic assignee (org-admin only) that auto-escalates the new ticket to the
// platform administrators. Must match ESCALATE_ADMINS_ID in the server's
// ticketing.controller.ts — the server emits this option and interprets the
// resulting { escalateToAdministrators: true } payload.
const ESCALATE_ADMINS_ID = '__escalate_admins__';

// Mirrors the server's multer config (uploads.ts): images only, 5 files, 10 MB each.
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// EXACTLY the server's ALLOWED_TYPES (server/src/modules/ticketing/uploads.ts) —
// keep the two in step. `image/*` here was wrong in both directions: it let HEIC
// (every iPhone photo), AVIF, BMP and TIFF through to a 400 UNSUPPORTED_FILE_TYPE,
// and it offered SVG, which the server excludes on purpose because an SVG is a
// script-bearing document served back from the app's own origin.
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const ACCEPTED_IMAGE_ACCEPT = ACCEPTED_IMAGE_TYPES.join(',');
const ACCEPTED_IMAGE_LABEL = 'PNG, JPEG, GIF or WebP';

export function NewTicketForm({ projects, onCreated, onCancel, role = 'USER' }: {
  projects: TicketProject[]; onCreated?: () => void; onCancel?: () => void; role?: Role;
}) {
  const queryClient = useQueryClient();
  const fields = ROLE_FIELDS[role] ?? ROLE_FIELDS.USER;
  const has = (f: FormField) => fields.includes(f);
  const isOrgAdmin = role === 'ORG_ADMIN';

  const { data: assignees } = useQuery<{ id: string; name: string; email: string; role: string }[]>({
    queryKey: ['ticketing', 'assignees'],
    queryFn: () => ticketingApi.listAssignees().then((r) => (r.data as { assignees: { id: string; name: string; email: string; role: string }[] }).assignees),
    enabled: has('assignee'),
    staleTime: 60_000,
  });
  // Administrators pick the ticket's client from the admin store's Customers table.
  const { data: customers } = useQuery<TicketCustomer[]>({
    queryKey: ['ticketing', 'customers'],
    queryFn: () => ticketingApi.listCustomers().then((r) => (r.data as { customers: TicketCustomer[] }).customers),
    enabled: has('client'),
    staleTime: 60_000,
  });
  // Org-admins can assign a ticket to a Slack bot instead of a person (this org's bots).
  const { data: orgBots } = useQuery<OrgBot[]>({
    queryKey: ['bots', 'list'],
    queryFn: () => botsApi.list().then((r) => (r.data as { bots: OrgBot[] }).bots),
    enabled: isOrgAdmin,
    staleTime: 30_000,
  });

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const [type, setType] = useState<TicketType>('task');
  const [priority, setPriority] = useState<TicketPriority>('medium');
  const [status, setStatus] = useState<TicketStatus>('todo');
  const [assigneeId, setAssigneeId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  // What the client record already held, so an untouched field never rewrites it.
  const [prefilledContact, setPrefilledContact] = useState('');
  const [prefilledEmail, setPrefilledEmail] = useState('');
  const [branch, setBranch] = useState('');
  const [onSite, setOnSite] = useState(false);
  const [labelsText, setLabelsText] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [assigneeMode, setAssigneeMode] = useState<'person' | 'bot'>('person');
  const [botId, setBotId] = useState('');
  const [botValues, setBotValues] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [createdNo, setCreatedNo] = useState<string | null>(null);
  const [sentToSlack, setSentToSlack] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Administrators own what they raise: default the assignee to themselves rather
  // than "Unassigned (round-robin)". Matched on email because the dropdown carries
  // ticket-store user ids, not B2B ids. Still fully editable below.
  const { user } = useAuth();
  useEffect(() => {
    if (role !== 'ADMINISTRATOR' || assigneeId || !user?.email || !assignees) return;
    const me = assignees.find((a) => a.email.toLowerCase() === user.email.toLowerCase());
    if (me) setAssigneeId(me.id);
  }, [role, assigneeId, user?.email, assignees]);

  // Local previews for the images picked but not yet uploaded.
  const previews = useMemo(() => images.map((f) => URL.createObjectURL(f)), [images]);
  useEffect(() => () => { previews.forEach((u) => URL.revokeObjectURL(u)); }, [previews]);

  function addImages(picked: FileList | null) {
    if (!picked?.length) return;
    const files = Array.from(picked);
    const tooBig = files.find((f) => f.size > MAX_IMAGE_BYTES);
    if (tooBig) { setUploadWarning(`${tooBig.name} is larger than 10 MB.`); return; }
    const notImage = files.find((f) => !ACCEPTED_IMAGE_TYPES.includes(f.type));
    if (notImage) { setUploadWarning(`${notImage.name} is not a supported image — use ${ACCEPTED_IMAGE_LABEL}.`); return; }
    setUploadWarning(null);
    setImages((prev) => [...prev, ...files].slice(0, MAX_IMAGES));
  }

  const botMode = isOrgAdmin && assigneeMode === 'bot';
  const selectedBot = (orgBots ?? []).find((b) => b.id === botId) ?? null;
  const botFieldsValid = !botMode || (!!selectedBot && selectedBot.formFields.every(
    (f) => !f.required || f.type === 'CHECKBOX' || (botValues[f.key] !== undefined && botValues[f.key] !== ''),
  ));
  // The client's email is prefilled from the picked client record; when that record has
  // none, the administrator types one here and it is saved back onto the client.
  const selectedCustomer = (Array.isArray(customers) ? customers : []).find((c) => c.id === customerId) ?? null;
  const emailAutoFilled = !!selectedCustomer?.email && clientEmail.trim() === selectedCustomer.email;
  const emailValid = clientEmail.trim() === '' || EMAIL_RE.test(clientEmail.trim());
  const isValid = title.trim().length >= 1 && description.trim().length >= 1 && projectId !== '' && (!botMode || !!botId) && botFieldsValid && emailValid;
  // Bot tickets are created by botsApi.createTicket, whose payload carries neither an
  // assignee (the bot IS the assignee) nor a status (the server hardcodes 'todo').
  // Hide both rather than render a control whose value is thrown away.
  const effectiveFields = botMode ? fields.filter((f) => f !== 'assignee' && f !== 'status') : fields;

  const setBotVal = (key: string, v: unknown) => setBotValues((p) => ({ ...p, [key]: v }));

  function resetForm() {
    setTitle(''); setDescription(''); setProjectId(''); setType('task'); setPriority('medium');
    setStatus('todo'); setAssigneeId(''); setBranch(''); setOnSite(false); setError(null);
    setCustomerId(''); setClientEmail(''); setPrefilledEmail(''); setContactPerson(''); setPrefilledContact('');
    setLabelsText('');
    setImages([]); setUploadWarning(null);
    setAssigneeMode('person'); setBotId(''); setBotValues({});
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true); setError(null);
    try {
      let ticketNumber: string;
      let newTicketId = '';
      if (botMode) {
        // Assign the ticket to the selected bot; its dynamic form values are validated server-side.
        const { data } = await botsApi.createTicket(botId, {
          title: title.trim(), description: description.trim(), projectId, type, priority, values: botValues,
        });
        const res = data as { ticket: TicketDTO; slackNotified?: boolean };
        ticketNumber = res.ticket.ticketNumber;
        newTicketId = res.ticket.id;
        setSentToSlack(!!res.slackNotified);
      } else {
        setSentToSlack(false);
        const { data } = await ticketingApi.createTicket({
          title: title.trim(),
          description: description.trim(),
          projectId,
          type,
          priority,
          ...(has('status') ? { status } : {}),
          ...(has('assignee')
            ? (assigneeId === ESCALATE_ADMINS_ID
                ? { escalateToAdministrators: true }
                : { assigneeId: assigneeId || null })
            : {}),
          // Sent even when empty (as null) so the server does NOT fall back to linking
          // the administrator's own organization as the client.
          ...(has('client') ? { customerId: customerId || null } : {}),
          // Only when actually EDITED, for the same reason as contactPerson below — plus
          // one the contact field doesn't have: customerEmail is validated server-side as
          // an email, so echoing back an address the client record already holds makes the
          // WHOLE ticket fail with a 400 over a field the administrator never typed in.
          ...(has('clientEmail') && customerId && clientEmail.trim() !== prefilledEmail.trim()
            ? { customerEmail: clientEmail.trim() || null } : {}),
          // Only when actually EDITED: contactPerson is stored on the shared Customers
          // row, so echoing back the prefilled value would rewrite the client record on
          // every ticket. ponytail: per-ticket contacts need a contactPerson column on
          // Tickets — a migration on the externally-owned schema.
          ...(has('contact') && customerId && contactPerson.trim() !== prefilledContact.trim()
            ? { contactPerson: contactPerson.trim() || null } : {}),
          ...(has('branch') ? { branch: branch.trim() || null } : {}),
          ...(has('onSite') ? { onSiteSupportRequired: onSite } : {}),
          // Both caps mirror the server's schema (labels: array(string.max(60)).max(30)).
          // Only the count was capped here, so a single long label failed the WHOLE
          // ticket with a 400 — truncate instead of rejecting what the user typed.
          ...(has('labels') && labelsText.trim()
            ? { labels: labelsText.split(',').map((l) => l.trim().slice(0, 60)).filter(Boolean).slice(0, 30) } : {}),
        });
        ticketNumber = (data as TicketDTO).ticketNumber;
        newTicketId = (data as TicketDTO).id;
      }
      // Attachments need a ticket id, so they upload as a second call. A failed upload
      // must not lose the ticket the user just wrote — warn and keep going.
      let warning: string | null = null;
      if (images.length && newTicketId) {
        try {
          const form = new FormData();
          images.forEach((f) => form.append('files', f));
          await ticketingApi.uploadAttachments(newTicketId, form);
        } catch {
          warning = `Ticket ${ticketNumber} was created, but the images could not be attached. Add them from the ticket.`;
        }
      }

      setCreatedNo(ticketNumber);
      resetForm();          // clears uploadWarning — set it again below
      setUploadWarning(warning);
      await queryClient.invalidateQueries({ queryKey: ['ticketing'] });
      onCreated?.();
      setTimeout(() => { setCreatedNo(null); setSentToSlack(false); }, 6000);
    } catch (err) {
      // A Zod rejection carries only "Validation failed" in `error`; WHICH field failed is
      // in details.fieldErrors. Without this the form reports a 400 nobody — user or
      // developer reading a screenshot — can act on.
      const data = (err as { response?: { data?: { error?: string; details?: { fieldErrors?: Record<string, string[]> } } } })?.response?.data;
      const fields = Object.entries(data?.details?.fieldErrors ?? {}).map(([f, m]) => `${f}: ${m?.[0] ?? 'invalid'}`);
      setError(fields.length
        ? `${data?.error ?? 'Validation failed'} — ${fields.join('; ')}`
        : data?.error ?? 'Could not create the ticket. Please try again.');
    } finally { setSubmitting(false); }
  }

  function renderField(f: FormField) {
    switch (f) {
      case 'project':
        return (
          <div key={f} className={span(f)}>
            <FieldLabel htmlFor="tk-project" required>Project</FieldLabel>
            <select id="tk-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input"
              disabled={projects.length === 0}>
              <option value="">— Select a project —</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {/* A project is required, so with none the submit button is inert and
                nothing is ever sent — which reads as "New Ticket is broken". Say why. */}
            {projects.length === 0 && (
              <p className="mt-1.5 text-xs text-amber-600">
                No projects exist yet. An administrator has to create one before tickets can be raised.
              </p>
            )}
          </div>
        );
      case 'type':
        return (
          <div key={f} className={span(f)}>
            <FieldLabel required>Type</FieldLabel>
            <Segmented value={type} onChange={setType} layoutId="nt-type" size="sm"
              options={TICKET_TYPES.map((t) => ({ value: t.value, label: t.label, icon: typeIcon[t.value] }))} />
          </div>
        );
      case 'priority':
        return (
          <div key={f} className={span(f)}>
            <FieldLabel required>Priority</FieldLabel>
            <Segmented value={priority} onChange={setPriority} layoutId="nt-priority" size="sm" options={PRIORITY_OPTIONS} />
          </div>
        );
      case 'status':
        return (
          <div key={f}>
            <FieldLabel htmlFor="tk-status" required>Status</FieldLabel>
            <select id="tk-status" value={status} onChange={(e) => setStatus(e.target.value as TicketStatus)} className="input">
              {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        );
      case 'assignee':
        return (
          <div key={f}>
            <FieldLabel htmlFor="tk-assignee">Assignee</FieldLabel>
            <select id="tk-assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className="input">
              <option value="">— Unassigned (round-robin) —</option>
              {(Array.isArray(assignees) ? assignees : []).map((a) => (
                <option key={a.id} value={a.id}>{a.id === ESCALATE_ADMINS_ID ? `⤴ ${a.name}` : staffLabel(a, role)}</option>
              ))}
            </select>
          </div>
        );
      case 'client':
        return (
          <div key={f}>
            <FieldLabel htmlFor="tk-client">Client name</FieldLabel>
            <select id="tk-client" value={customerId} className="input"
              onChange={(e) => {
                const id = e.target.value;
                const picked = (customers ?? []).find((c) => c.id === id);
                setCustomerId(id);
                // Prefill email + contact person from the client record; both stay editable below.
                setClientEmail(picked?.email ?? '');
                setPrefilledEmail(picked?.email ?? '');
                setContactPerson(picked?.contactPerson ?? '');
                setPrefilledContact(picked?.contactPerson ?? '');
              }}>
              <option value="">— No client —</option>
              {(Array.isArray(customers) ? customers : []).map((c) => (
                <option key={c.id} value={c.id}>{c.company ? `${c.name} · ${c.company}` : c.name}</option>
              ))}
            </select>
          </div>
        );
      case 'clientEmail':
        return (
          <div key={f}>
            <FieldLabel htmlFor="tk-client-email">Client email</FieldLabel>
            <input id="tk-client-email" type="email" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)}
              maxLength={255} className="input" disabled={!customerId}
              placeholder={customerId ? 'name@company.com' : 'Select a client first'} />
            <p className={`text-[11px] mt-1 ${emailValid ? 'text-slate-400' : 'text-red-600'}`}>
              {!customerId ? 'Select a client first.'
                : !emailValid ? 'Enter a valid email address.'
                : emailAutoFilled ? 'Fetched from the client record — edit to update it.'
                : 'No email on file for this client — the address you enter is saved to their record.'}
            </p>
          </div>
        );
      case 'contact':
        return (
          <div key={f}>
            <FieldLabel htmlFor="tk-contact">Contact person</FieldLabel>
            <input id="tk-contact" value={contactPerson} onChange={(e) => setContactPerson(e.target.value)}
              maxLength={255} className="input" disabled={!customerId} placeholder="Who to reach at the client" />
            <p className="text-[11px] text-slate-400 mt-1">
              {customerId ? 'Edits update the client record itself, so they show on ALL of this client’s tickets.' : 'Select a client first.'}
            </p>
          </div>
        );
      case 'branch':
        return (
          <div key={f}>
            <FieldLabel htmlFor="tk-branch">Branch</FieldLabel>
            <input id="tk-branch" value={branch} onChange={(e) => setBranch(e.target.value)} maxLength={255} className="input" placeholder="e.g. release/2.1" />
          </div>
        );
      case 'onSite':
        return (
          <div key={f} className={span(f)}>
            <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={onSite} onChange={(e) => setOnSite(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-brand focus:ring-2 focus:ring-brand/40 cursor-pointer" />
              <span className="text-sm text-slate-700">On-site support required</span>
            </label>
          </div>
        );
      case 'labels':
        return (
          <div key={f} className={span(f)}>
            <FieldLabel htmlFor="tk-labels">Labels</FieldLabel>
            <input id="tk-labels" value={labelsText} onChange={(e) => setLabelsText(e.target.value)}
              className="input" placeholder="Comma separated — e.g. billing, urgent-callback" />
          </div>
        );
      default: return null;
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {createdNo && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2.5 px-3.5 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
          Ticket created — <span className="font-mono font-bold">{createdNo}</span>
          {sentToSlack && <span className="text-emerald-600">· sent to the bot&apos;s Slack channel</span>}
        </motion.div>
      )}

      <div>
        <FieldLabel htmlFor="tk-title" required>Title</FieldLabel>
        <input id="tk-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} className="input" placeholder="Brief summary of the issue" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">{effectiveFields.map(renderField)}</div>

      {isOrgAdmin && (
        <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200/70 p-4 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <FieldLabel>Assign to</FieldLabel>
            <Segmented value={assigneeMode} onChange={setAssigneeMode} size="sm" layoutId="nt-assignee-mode"
              options={[{ value: 'person', label: 'Person' }, { value: 'bot', label: 'Bot' }]} />
          </div>
          {botMode && (
            <>
              <div>
                <FieldLabel required>Bot</FieldLabel>
                <select value={botId} onChange={(e) => { setBotId(e.target.value); setBotValues({}); }} className="input">
                  <option value="">— Select a bot —</option>
                  {(Array.isArray(orgBots) ? orgBots : []).map((b) => <option key={b.id} value={b.id}>{b.name}{b.status !== 'CONNECTED' ? ` (${b.status.toLowerCase()})` : ''}</option>)}
                </select>
                {(orgBots ?? []).length === 0 && <p className="text-xs text-slate-400 mt-1">No bots have been assigned to your organization yet.</p>}
              </div>
              {selectedBot && selectedBot.formFields.length > 0 && (
                <div className="pt-1">
                  <BotFieldGrid fields={selectedBot.formFields} values={botValues} onChange={setBotVal} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div>
        <FieldLabel htmlFor="tk-desc" required>Description</FieldLabel>
        <textarea id="tk-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={10_000} className="input resize-none"
          placeholder="What you observed, error messages, affected machine…" />
      </div>

      <div>
        <FieldLabel>Images</FieldLabel>
        <div className="flex flex-wrap items-start gap-2.5">
          {previews.map((src, i) => (
            <div key={src} className="relative w-20 h-20 rounded-lg overflow-hidden ring-1 ring-slate-200 bg-slate-50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={images[i]?.name ?? 'Selected image'} className="w-full h-full object-cover" />
              <button type="button" aria-label={`Remove ${images[i]?.name ?? 'image'}`}
                onClick={() => setImages((prev) => prev.filter((_, n) => n !== i))}
                className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-slate-900/60 text-white text-xs leading-none cursor-pointer hover:bg-slate-900">×</button>
            </div>
          ))}
          {images.length < MAX_IMAGES && (
            <label className="w-20 h-20 rounded-lg ring-1 ring-dashed ring-slate-300 flex flex-col items-center justify-center gap-1 cursor-pointer text-slate-400 hover:text-brand hover:ring-brand/40 transition-colors">
              <Icons.paperclip className="w-4 h-4" />
              <span className="text-[10px] font-semibold">Add</span>
              <input type="file" accept={ACCEPTED_IMAGE_ACCEPT} multiple className="hidden"
                onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />
            </label>
          )}
        </div>
        <p className={`text-[11px] mt-1.5 ${uploadWarning ? 'text-amber-600 font-medium' : 'text-slate-400'}`}>
          {uploadWarning ?? `Images only — up to ${MAX_IMAGES} files, 10 MB each.`}
        </p>
      </div>

      <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
        {error && <span className="mr-auto text-xs text-red-600">{error}</span>}
        {!isValid && !error && <span className="mr-auto text-xs text-slate-400">Title, project and description are required</span>}
        <GlowButton type="button" variant="secondary" onClick={() => { resetForm(); onCancel?.(); }} disabled={submitting}>Cancel</GlowButton>
        <GlowButton type="submit" disabled={!isValid || submitting} loading={submitting}>{submitting ? 'Creating…' : 'Create ticket'}</GlowButton>
      </div>
    </form>
  );
}

// ─── Slide-over drawer shell (right side) ───────────────────────────────────────
export function Drawer({ open, onClose, children, width = 'max-w-2xl' }: { open: boolean; onClose: () => void; children: React.ReactNode; width?: string }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex justify-end bg-slate-900/40 backdrop-blur-sm" onClick={onClose}>
      <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', stiffness: 380, damping: 38 }}
        onClick={(e) => e.stopPropagation()}
        className={`relative w-full ${width} h-full bg-white shadow-pop overflow-y-auto`}>
        {children}
      </motion.div>
    </div>
  );
}

// ─── Comment box with @mentions ─────────────────────────────────────────────────
// Platform-provider store only. Typing "@" opens the staff roster; picking someone
// inserts their name AND records their id.
//
// The IDS are the source of truth, never the text. Matching typed names back to
// people would be guesswork — staff are "Firstname Lastname", there is no handle
// column, and two people can share a name. So the picker records the id, and any
// id whose name no longer appears in the text is dropped before submitting.

export interface MentionCandidate { id: string; name: string; email: string }

/** Where the caret sits inside an unfinished "@fragment", or null. */
function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;
  // Must start a word: "@x" or " @x", not "email@x".
  if (at > 0 && !/\s/.test(upto[at - 1]!)) return null;
  const query = upto.slice(at + 1);
  // A newline ends it, and so does a long run — this is a name, not a paragraph.
  if (/[\n]/.test(query) || query.length > 40) return null;
  return { start: at, query };
}

export function MentionTextarea({ value, onChange, candidates, onMentionsChange, placeholder, rows = 2 }: {
  value: string;
  onChange: (next: string) => void;
  candidates: MentionCandidate[];
  onMentionsChange: (ids: string[]) => void;
  placeholder?: string;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.query.toLowerCase();
    return candidates.filter((c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)).slice(0, 6);
  }, [query, candidates]);

  useEffect(() => { setActive(0); }, [query?.query]);

  // A mention only counts while its name is still in the text. Editing or deleting
  // the inserted name retracts it, so nobody is notified about a comment that no
  // longer names them.
  useEffect(() => {
    const live = picked.filter((p) => value.includes(`@${p.name}`));
    if (live.length !== picked.length) setPicked(live);
    onMentionsChange(live.map((p) => p.id));
  }, [value, picked, onMentionsChange]);

  function choose(c: MentionCandidate) {
    if (!query) return;
    const before = value.slice(0, query.start);
    const after = value.slice((ref.current?.selectionStart ?? value.length));
    const next = `${before}@${c.name} ${after}`;
    onChange(next);
    setPicked((prev) => (prev.some((p) => p.id === c.id) ? prev : [...prev, c]));
    setQuery(null);
    // Put the caret after the inserted name rather than leaving it mid-text.
    requestAnimationFrame(() => {
      const pos = before.length + c.name.length + 2;
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        placeholder={placeholder}
        className="input resize-none text-sm w-full"
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-autocomplete="list"
        aria-controls="mention-listbox"
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(activeMentionQuery(e.target.value, e.target.selectionStart));
        }}
        onClick={(e) => setQuery(activeMentionQuery(value, e.currentTarget.selectionStart))}
        onBlur={() => setTimeout(() => setQuery(null), 120)}  // let a click on an option land first
        onKeyDown={(e) => {
          if (matches.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(matches[active]!); }
          else if (e.key === 'Escape') { e.preventDefault(); setQuery(null); }
        }}
      />
      <AnimatePresence>
        {matches.length > 0 && (
          <motion.ul
            id="mention-listbox"
            role="listbox"
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="absolute left-0 bottom-full mb-1 z-50 w-64 card shadow-card-hover overflow-hidden py-1"
          >
            {matches.map((c, i) => (
              <li key={c.id} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  // onMouseDown, not onClick: blur fires first and would close the list.
                  onMouseDown={(e) => { e.preventDefault(); choose(c); }}
                  className={clsx(
                    'w-full text-left px-3 py-1.5 cursor-pointer transition-colors',
                    i === active ? 'bg-slate-100' : 'hover:bg-slate-50',
                  )}
                >
                  <span className="block text-xs font-semibold text-slate-800 truncate">{c.name}</span>
                  <span className="block text-[10px] text-slate-400 truncate">{c.email}</span>
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Render a comment, highlighting any "@Name" that matches a known colleague. */
export function CommentBody({ content, names }: { content: string; names: string[] }) {
  // Longest first so "@Ann Lee" wins over "@Ann".
  const sorted = [...names].filter(Boolean).sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return <p className="text-sm text-slate-700 whitespace-pre-wrap mt-0.5">{content}</p>;

  const escaped = sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = content.split(new RegExp(`(@(?:${escaped.join('|')}))`, 'g'));
  return (
    <p className="text-sm text-slate-700 whitespace-pre-wrap mt-0.5">
      {parts.map((part, i) => (part.startsWith('@') && sorted.some((n) => part === `@${n}`)
        ? <span key={i} className="font-semibold text-brand bg-brand-50 rounded px-1 py-0.5">{part}</span>
        : <span key={i}>{part}</span>))}
    </p>
  );
}

// ─── Ticket actions menu (⋮) ────────────────────────────────────────────────────
// The codebase had no dropdown/popover primitive and no dismiss-on-outside-click
// utility, so this is the first. Anchoring follows NotificationBell; the outside-
// click and Escape handling is what that one lacks.
//
// Every trigger sits inside a clickable ticket card, so the button and the panel
// both stopPropagation — without it, opening the menu also opens the ticket.

export interface TicketMenuAction {
  label: string;
  onSelect: () => void;
  /** Renders red, and is separated from the rest. For destructive items. */
  danger?: boolean;
}

export function TicketActionsMenu({ actions, label = 'Ticket actions' }: { actions: TicketMenuAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // `true` (capture): the card underneath stops propagation on its own handlers,
    // so a bubbling listener would never see the click that should close this.
    document.addEventListener('mousedown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative flex-shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="text-slate-300 hover:text-slate-600 transition-colors cursor-pointer p-0.5 rounded"
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
        </svg>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.13 }}
            className="absolute right-0 top-8 z-50 w-44 card shadow-card-hover overflow-hidden py-1"
          >
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                onClick={(e) => { e.stopPropagation(); setOpen(false); a.onSelect(); }}
                className={clsx(
                  'w-full text-left px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer',
                  a.danger
                    ? 'text-red-600 hover:bg-red-50 border-t border-slate-100'
                    : 'text-slate-700 hover:bg-slate-50',
                )}
              >
                {a.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Delete a ticket (asks twice) ───────────────────────────────────────────────
// Two sequential prompts, by request. useConfirm resolves its promise before it
// clears state, so a second await re-opens cleanly.
//
// NEITHER prompt passes `rememberKey`: a remembered "don't ask again" resolves
// instantly to true, which would defeat the entire point of asking twice.

export function useDeleteTicket(onDeleted?: () => void) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();

  const mut = useMutation({
    mutationFn: (id: string) => ticketingApi.deleteTicket(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ticketing'] });
      toast('Ticket deleted', 'success');
      onDeleted?.();
    },
    // The 409 for an escalated ticket explains itself — show the server's words.
    onError: (e: unknown) => toast(apiErrorMessage(e, 'Could not delete the ticket.'), 'error'),
  });

  async function requestDelete(ticket: { id: string; ticketNumber: string; title: string }) {
    const first = await confirm({
      title: 'Delete ticket',
      message: <>Are you really want to delete the ticket <strong>{ticket.ticketNumber}</strong> &ldquo;{ticket.title}&rdquo;?</>,
      confirmText: 'Delete',
      variant: 'danger',
    });
    if (!first) return;

    const second = await confirm({
      title: 'This cannot be undone',
      message: <>All comments, attachments and the ticket&rsquo;s history will be permanently deleted along with it. Delete <strong>{ticket.ticketNumber}</strong>?</>,
      confirmText: 'Delete permanently',
      variant: 'danger',
    });
    if (!second) return;

    mut.mutate(ticket.id);
  }

  return { requestDelete, deleting: mut.isPending };
}

// ─── Edit ticket (title + description) ──────────────────────────────────────────
// PATCH /tickets/:id already accepted both fields and was already staff-gated; there
// was simply no UI for them, so a ticket's wording was fixed forever at creation.
// Bounds mirror the server (ticketing.schema.ts): title 1-255, description 1-10000.

export function EditTicketModal({ ticket, open, onClose }: { ticket: TicketDTO; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);
  const [error, setError] = useState('');

  // Re-seed when a different ticket is opened, or after an external edit lands.
  useEffect(() => {
    if (open) { setTitle(ticket.title); setDescription(ticket.description); setError(''); }
  }, [open, ticket.title, ticket.description]);

  const mut = useMutation({
    mutationFn: (payload: unknown) => ticketingApi.updateTicket(ticket.id, payload),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ticketing'] }); onClose(); },
    onError: (e: unknown) => setError(apiErrorMessage(e, 'Could not save the ticket.')),
  });

  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();
  const dirty = trimmedTitle !== ticket.title || trimmedDescription !== ticket.description;
  const valid = trimmedTitle.length > 0 && trimmedTitle.length <= 255
    && trimmedDescription.length > 0 && trimmedDescription.length <= 10_000;

  return (
    <Modal open={open} onClose={onClose} title={`Edit ${ticket.ticketNumber}`}>
      <div className="space-y-4">
        <div>
          <label htmlFor="edit-ticket-title" className="block text-xs font-semibold text-slate-500 mb-1">Title</label>
          <input id="edit-ticket-title" value={title} onChange={(e) => setTitle(e.target.value)}
            maxLength={255} className="input text-sm w-full" />
        </div>
        <div>
          <label htmlFor="edit-ticket-description" className="block text-xs font-semibold text-slate-500 mb-1">Description</label>
          <textarea id="edit-ticket-description" value={description} onChange={(e) => setDescription(e.target.value)}
            rows={8} maxLength={10_000} className="input text-sm w-full resize-y" />
        </div>
        {!valid && (title || description) && (
          <p className="text-xs text-amber-600">Title and description cannot be empty.</p>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <GlowButton variant="ghost" className="py-1.5 px-3 text-xs" onClick={onClose}>Cancel</GlowButton>
          <GlowButton
            className="py-1.5 px-3 text-xs"
            disabled={!dirty || !valid || mut.isPending}
            loading={mut.isPending}
            // Send only what changed — the house dirty-diff idiom (TicketDetail QuickEdit).
            onClick={() => mut.mutate({
              ...(trimmedTitle !== ticket.title ? { title: trimmedTitle } : {}),
              ...(trimmedDescription !== ticket.description ? { description: trimmedDescription } : {}),
            })}
          >
            {mut.isPending ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
          </GlowButton>
        </div>
      </div>
    </Modal>
  );
}

// ─── Modal shell (centered) ─────────────────────────────────────────────────────
export function Modal({ open, onClose, title, children, width = 'max-w-2xl' }: { open: boolean; onClose: () => void; title?: React.ReactNode; children: React.ReactNode; width?: string }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-slate-900/40 backdrop-blur-sm p-4 sm:p-8" onClick={onClose}>
      <motion.div initial={{ opacity: 0, y: 12, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.18 }}
        onClick={(e) => e.stopPropagation()} className={`card w-full ${width} my-2 shadow-pop overflow-hidden`}>
        {title && (
          <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-100">
            <h3 className="text-lg font-bold tracking-tight text-slate-900">{title}</h3>
            <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700 cursor-pointer flex-shrink-0">
              <Icons.close className="w-5 h-5" />
            </button>
          </div>
        )}
        <div className="p-6">{children}</div>
      </motion.div>
    </div>
  );
}
