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
  return <span className="inline-flex px-2 py-0.5 rounded-md text-[11px] font-semibold text-slate-600 bg-slate-100 ring-1 ring-inset ring-slate-500/15">{typeLabel[type] ?? type}</span>;
}
export function SlaBadge({ status, remainingSeconds }: { status: SlaStatus; remainingSeconds: number | null }) {
  const cfg = slaCfg[status];
  const extra = status !== 'none' && status !== 'paused' && remainingSeconds != null
    ? ` · ${remainingSeconds <= 0 ? 'overdue' : formatDuration(remainingSeconds)}`
    : '';
  return <span className={`inline-flex px-2 py-0.5 rounded-md text-[11px] font-semibold ring-1 ring-inset ${cfg.cls}`}>{cfg.label}{extra}</span>;
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

// ─── Page header + stat strip ────────────────────────────────────────────────────
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
export function StatStrip({ items }: { items: { label: string; value: number | string; dot: string }[] }) {
  return (
    <div className="flex flex-wrap items-stretch gap-3">
      {items.map((s) => (
        <div key={s.label} className="card flex items-center gap-3 px-4 py-3 flex-1 min-w-[140px]">
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
          <div key={f}>
            <FieldLabel htmlFor="tk-project" required>Project</FieldLabel>
            <select id="tk-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input">
              <option value="">— Select a project —</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        );
      case 'type':
        return (
          <div key={f}>
            <FieldLabel htmlFor="tk-type" required>Type</FieldLabel>
            <select id="tk-type" value={type} onChange={(e) => setType(e.target.value as TicketType)} className="input">
              {TICKET_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        );
      case 'priority':
        return (
          <div key={f}>
            <FieldLabel htmlFor="tk-priority" required>Priority</FieldLabel>
            <select id="tk-priority" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)} className="input">
              {PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
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

  const heading = role === 'USER' ? 'Raise a Ticket' : 'Create New Ticket';

  return (
    <form onSubmit={handleSubmit} className="card p-6 sm:p-8 space-y-5 shadow-card">
      <h3 className="text-lg font-bold tracking-tight text-slate-900">{heading}</h3>

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
        <GlowButton type="submit" disabled={!isValid || submitting} loading={submitting}>{submitting ? 'Creating…' : 'Create'}</GlowButton>
      </div>
    </form>
  );
}
