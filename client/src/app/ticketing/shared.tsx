'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ticketingApi } from '@/lib/api';
import GlowButton from '@/components/ui/GlowButton';
import type { TicketDTO, TicketProject, TicketStatus, TicketPriority, TicketType, SlaStatus, Role } from '@/lib/schemas';

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
  const cfg = slaCfg[status];
  const extra = status !== 'none' && status !== 'paused' && remainingSeconds != null
    ? ` · ${remainingSeconds <= 0 ? 'overdue' : formatDuration(remainingSeconds)}`
    : '';
  return <span className={`inline-flex px-2 py-0.5 rounded-md text-[11px] font-semibold ring-1 ring-inset ${cfg.cls}`}>{cfg.label}{extra}</span>;
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
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="input !pl-9 !py-2 text-xs" />
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

// ─── Create ticket form (role-driven field set) ──────────────────────────────────
type FormField = 'project' | 'type' | 'priority' | 'status' | 'assignee' | 'branch' | 'onSite';
const ROLE_FIELDS: Record<Role, FormField[]> = {
  USER:          ['project', 'type', 'priority'],
  ORG_ADMIN:     ['project', 'type', 'priority', 'status', 'assignee'],
  ADMINISTRATOR: ['project', 'type', 'priority', 'status', 'assignee', 'branch', 'onSite'],
};

export function NewTicketForm({ projects, onCreated, onCancel, role = 'USER' }: {
  projects: TicketProject[]; onCreated?: () => void; onCancel?: () => void; role?: Role;
}) {
  const queryClient = useQueryClient();
  const fields = ROLE_FIELDS[role] ?? ROLE_FIELDS.USER;
  const has = (f: FormField) => fields.includes(f);

  const { data: assignees } = useQuery<{ id: string; name: string; email: string; role: string }[]>({
    queryKey: ['ticketing', 'assignees'],
    queryFn: () => ticketingApi.listAssignees().then((r) => (r.data as { assignees: { id: string; name: string; email: string; role: string }[] }).assignees),
    enabled: has('assignee'),
    staleTime: 60_000,
  });

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const [type, setType] = useState<TicketType>('task');
  const [priority, setPriority] = useState<TicketPriority>('medium');
  const [status, setStatus] = useState<TicketStatus>('todo');
  const [assigneeId, setAssigneeId] = useState('');
  const [branch, setBranch] = useState('');
  const [onSite, setOnSite] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createdNo, setCreatedNo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isValid = title.trim().length >= 1 && description.trim().length >= 1 && projectId !== '';

  function resetForm() {
    setTitle(''); setDescription(''); setProjectId(''); setType('task'); setPriority('medium');
    setStatus('todo'); setAssigneeId(''); setBranch(''); setOnSite(false); setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true); setError(null);
    try {
      const { data } = await ticketingApi.createTicket({
        title: title.trim(),
        description: description.trim(),
        projectId,
        type,
        priority,
        ...(has('status') ? { status } : {}),
        ...(has('assignee') ? { assigneeId: assigneeId || null } : {}),
        ...(has('branch') ? { branch: branch.trim() || null } : {}),
        ...(has('onSite') ? { onSiteSupportRequired: onSite } : {}),
      });
      setCreatedNo((data as TicketDTO).ticketNumber);
      resetForm();
      await queryClient.invalidateQueries({ queryKey: ['ticketing'] });
      onCreated?.();
      setTimeout(() => setCreatedNo(null), 6000);
    } catch {
      setError('Could not create the ticket. Please try again.');
    } finally { setSubmitting(false); }
  }

  function renderField(f: FormField) {
    switch (f) {
      case 'project':
        return (
          <div key={f} className="sm:col-span-2">
            <FieldLabel htmlFor="tk-project" required>Project</FieldLabel>
            <select id="tk-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input">
              <option value="">— Select a project —</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        );
      case 'type':
        return (
          <div key={f} className="sm:col-span-2">
            <FieldLabel required>Type</FieldLabel>
            <Segmented value={type} onChange={setType} layoutId="nt-type" size="sm"
              options={TICKET_TYPES.map((t) => ({ value: t.value, label: t.label, icon: typeIcon[t.value] }))} />
          </div>
        );
      case 'priority':
        return (
          <div key={f} className="sm:col-span-2">
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
              {(assignees ?? []).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.role}</option>)}
            </select>
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
          <div key={f} className="sm:pt-7">
            <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={onSite} onChange={(e) => setOnSite(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-brand focus:ring-2 focus:ring-brand/40 cursor-pointer" />
              <span className="text-sm text-slate-700">On-site support required</span>
            </label>
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
        </motion.div>
      )}

      <div>
        <FieldLabel htmlFor="tk-title" required>Title</FieldLabel>
        <input id="tk-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} className="input" placeholder="Brief summary of the issue" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">{fields.map(renderField)}</div>

      <div>
        <FieldLabel htmlFor="tk-desc" required>Description</FieldLabel>
        <textarea id="tk-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={10_000} className="input resize-none"
          placeholder="What you observed, error messages, affected machine…" />
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
