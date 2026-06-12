'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ticketingApi } from '@/lib/api';
import GlowButton from '@/components/ui/GlowButton';
import type { TicketingTicket, TicketingProject, Priority } from '@/lib/schemas';

export const ISSUE_TYPES = [
  'Printer issue', 'Password reset', 'AD account lockout', 'Proxy / site whitelist',
  'VPN connectivity', 'Outlook sync', 'Hardware request', 'Software install', 'Other',
];

export const PROJECT_CATEGORIES = ['software', 'hardware', 'network', 'other'];

export const statusCfg: Record<string, { cls: string; dot: string; label: string }> = {
  TODO:        { cls: 'text-amber-700 bg-amber-50',     dot: 'bg-amber-500',   label: 'To Do' },
  IN_PROGRESS: { cls: 'text-cyan-700 bg-cyan-50',       dot: 'bg-cyan-500',    label: 'In Progress' },
  COMPLETED:   { cls: 'text-emerald-700 bg-emerald-50', dot: 'bg-emerald-500', label: 'Completed' },
};

export const priorityCls: Record<string, string> = {
  CRITICAL: 'text-red-700 bg-red-50',
  HIGH:     'text-amber-700 bg-amber-50',
  MEDIUM:   'text-cyan-700 bg-cyan-50',
  LOW:      'text-slate-600 bg-slate-100',
};

export function StatusBadge({ status }: { status: string }) {
  const cfg = statusCfg[status] ?? statusCfg['TODO']!;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold ${cfg.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

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

// ─── New ticket form (USER view + admin quick-create) ────────────────────────
export function NewTicketForm({ projects, onCreated }: { projects: TicketingProject[]; onCreated?: () => void }) {
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState('');
  const [issueType, setIssueType] = useState(ISSUE_TYPES[0]!);
  const [priority, setPriority] = useState<Priority>('MEDIUM');
  const [projectId, setProjectId] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isValid = subject.trim().length >= 5;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await ticketingApi.createTicket({
        subject: subject.trim(),
        issueType,
        priority,
        projectId: projectId || null,
        description: description.trim(),
      });
      setCreatedId((data as TicketingTicket).id);
      setSubject(''); setDescription(''); setProjectId(''); setIssueType(ISSUE_TYPES[0]!); setPriority('MEDIUM');
      await queryClient.invalidateQueries({ queryKey: ['ticketing'] });
      onCreated?.();
      setTimeout(() => setCreatedId(null), 6000);
    } catch {
      setError('Could not create the ticket. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card p-6 space-y-4">
      <div className="flex items-center gap-3 pb-4 border-b border-slate-100">
        <div className="w-10 h-10 rounded-lg bg-brand-50 border border-brand-100 flex items-center justify-center flex-shrink-0">
          <svg className="w-5 h-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </div>
        <div>
          <h3 className="text-base font-semibold text-slate-900 leading-tight">Raise a Ticket</h3>
          <p className="text-xs text-slate-500 mt-0.5">Your org admin is alerted the moment you submit</p>
        </div>
      </div>

      {createdId && (
        <div className="flex items-center gap-2.5 px-3.5 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
          ✓ Ticket created — reference <span className="font-mono font-bold">{createdId.toUpperCase()}</span>
        </div>
      )}

      <div>
        <label htmlFor="tk-subject" className="block text-sm font-medium text-slate-700 mb-1.5">Subject <span className="text-red-500">*</span></label>
        <input id="tk-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} className="input" placeholder="Brief summary of the issue" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="tk-issue" className="block text-sm font-medium text-slate-700 mb-1.5">Issue Type</label>
          <select id="tk-issue" value={issueType} onChange={(e) => setIssueType(e.target.value)} className="input">
            {ISSUE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="tk-project" className="block text-sm font-medium text-slate-700 mb-1.5">Project</label>
          <select id="tk-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input">
            <option value="">— None —</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      <div>
        <span className="block text-sm font-medium text-slate-700 mb-1.5">Priority</span>
        <div className="flex flex-wrap gap-2">
          {(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as Priority[]).map((p) => (
            <button key={p} type="button" onClick={() => setPriority(p)} aria-pressed={priority === p}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${priorityCls[p]} ${priority === p ? 'ring-2 ring-offset-1 ring-slate-300' : 'opacity-70 hover:opacity-100'}`}>
              {p.charAt(0) + p.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label htmlFor="tk-desc" className="block text-sm font-medium text-slate-700 mb-1.5">Description</label>
        <textarea id="tk-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} className="input resize-none"
          placeholder="What you observed, error messages, affected machine…" />
      </div>

      <div className="flex items-center gap-3">
        <GlowButton type="submit" disabled={!isValid || submitting} loading={submitting}>
          {submitting ? 'Submitting…' : 'Submit Ticket'}
        </GlowButton>
        {!isValid && <span className="text-xs text-slate-400">Subject required (5+ chars)</span>}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </form>
  );
}
