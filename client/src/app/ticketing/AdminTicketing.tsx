'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { ticketingApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import GlowButton from '@/components/ui/GlowButton';
import { ShimmerCard, ShimmerRow } from '@/components/ui/Shimmer';
import { NewTicketForm, StatusBadge, statusCfg, priorityCls, fmtDate, timeAgo, PROJECT_CATEGORIES } from './shared';
import type {
  TicketingTicket, TicketingProject, TicketingStats, TicketingAnalytics, TicketingReport, Priority, TicketingStatus,
} from '@/lib/schemas';

const DONUT_COLORS = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#64748b'];

const TABS = ['overview', 'tickets', 'projects', 'reports', 'new'] as const;
type Tab = typeof TABS[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview', tickets: 'Tickets', projects: 'Projects', reports: 'Reports', new: '+ New Ticket',
};

function StatTile({ label, value, tone, sub }: { label: string; value: number | string; tone: string; sub?: string }) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">{label}</p>
        <span className={`w-2 h-2 rounded-full ${tone}`} />
      </div>
      <p className="font-mono text-[1.75rem] font-bold text-slate-900 tabular-nums leading-none">{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-2">{sub}</p>}
    </div>
  );
}

// ─── Overview tab ─────────────────────────────────────────────────────────────
function OverviewTab() {
  const { data: stats, isLoading: statsLoading } = useQuery<TicketingStats>({
    queryKey: ['ticketing', 'stats'],
    queryFn: () => ticketingApi.getStats().then((r) => r.data as TicketingStats),
    staleTime: 15_000,
  });
  const { data: analytics, isLoading: anaLoading } = useQuery<TicketingAnalytics>({
    queryKey: ['ticketing', 'analytics'],
    queryFn: () => ticketingApi.getAnalytics().then((r) => r.data as TicketingAnalytics),
    staleTime: 30_000,
  });

  const t = stats?.tickets;
  const dist = analytics?.issueDistribution ?? [];
  const distTotal = dist.reduce((s, d) => s + d.count, 0) || 1;
  const maxDaily = Math.max(1, ...(analytics?.daily.map((d) => d.created) ?? [1]));

  return (
    <div className="space-y-6">
      {stats?.fallback && (
        <div className="flex items-center gap-2.5 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse-soft flex-shrink-0" />
          Live updates: using fallback data — the external ticketing API is not connected yet.
        </div>
      )}

      {/* Ticket statistics */}
      {statsLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">{Array.from({ length: 6 }).map((_, i) => <ShimmerCard key={i} />)}</div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          <StatTile label="Total Tickets"   value={t?.total ?? 0}        tone="bg-brand" />
          <StatTile label="Completed"       value={t?.completed ?? 0}    tone="bg-emerald-500" />
          <StatTile label="In Progress"     value={t?.inProgress ?? 0}   tone="bg-cyan-500" />
          <StatTile label="To Do"           value={t?.todo ?? 0}         tone="bg-amber-500" />
          <StatTile label="High Priority"   value={t?.highPriority ?? 0} tone="bg-red-500" />
          <StatTile label="Completion Rate" value={`${t?.completionRate ?? 0}%`} tone="bg-violet-500" />
        </div>
      )}

      {/* Analytics: donut + legend + KPI panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 card p-5">
          <div className="flex items-baseline justify-between mb-2">
            <div>
              <h3 className="text-base font-semibold text-slate-900">Issue Distribution</h3>
              <p className="text-xs text-slate-500 mt-0.5">Scope: all tickets</p>
            </div>
            <span className="text-[11px] font-semibold text-brand bg-brand-50 px-2 py-1 rounded-md">{analytics?.analyzed ?? 0} tickets analyzed</span>
          </div>
          {anaLoading ? (
            <ShimmerCard />
          ) : dist.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-500">No tickets to analyze yet.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
              <div className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={dist} dataKey="count" nameKey="issue" innerRadius={62} outerRadius={95} paddingAngle={2} strokeWidth={0}>
                      {dist.map((_, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v: number, name: string) => [`${v} tickets`, name]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Top issues</p>
                <div className="space-y-1.5">
                  {dist.map((d, i) => (
                    <div key={d.issue} className="flex items-center gap-2 text-xs">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                      <span className="flex-1 text-slate-700 truncate">{d.issue}</span>
                      <span className="font-mono tabular-nums font-semibold text-slate-900">{d.count}</span>
                      <span className="font-mono tabular-nums text-slate-400 w-12 text-right">({((d.count / distTotal) * 100).toFixed(1)}%)</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* KPI + live panel */}
        <div className="space-y-4">
          <div className="card p-4 bg-emerald-50/50 border-emerald-100">
            <p className="text-xs font-semibold text-slate-600">Tickets Today</p>
            <p className="font-mono text-2xl font-bold tabular-nums text-emerald-700 mt-1">{t?.today ?? 0}</p>
          </div>
          <div className="card p-4 bg-cyan-50/50 border-cyan-100">
            <p className="text-xs font-semibold text-slate-600">Open Tickets</p>
            <p className="font-mono text-2xl font-bold tabular-nums text-cyan-700 mt-1">{t?.open ?? 0}</p>
          </div>
          <div className="card p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-3">Created · last 14 days</p>
            <div className="flex items-end gap-1 h-16">
              {(analytics?.daily ?? []).map((d) => (
                <div key={d.date} className="flex-1" title={`${d.date}: ${d.created}`}>
                  <div className="w-full rounded-t bg-brand/70 hover:bg-brand transition-colors min-h-[2px]"
                    style={{ height: `${Math.max(4, (d.created / maxDaily) * 100)}%` }} />
                </div>
              ))}
            </div>
          </div>
          <div className="card p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">By priority</p>
            <div className="space-y-1.5">
              {(analytics?.byPriority ?? []).map((p) => (
                <div key={p.priority} className="flex items-center justify-between text-xs">
                  <span className={`px-2 py-0.5 rounded-md font-semibold ${priorityCls[p.priority]}`}>{p.priority}</span>
                  <span className="font-mono tabular-nums font-semibold text-slate-900">{p.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Tickets tab (management queue) ──────────────────────────────────────────
function TicketRow({ ticket, projects, expanded, onToggle }: {
  ticket: TicketingTicket;
  projects: TicketingProject[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [status, setStatus] = useState<TicketingStatus>(ticket.status);
  const [priority, setPriority] = useState<Priority>(ticket.priority);
  const [assignee, setAssignee] = useState(ticket.assignee ?? '');
  const [projectId, setProjectId] = useState(ticket.projectId ?? '');
  const [showEscalate, setShowEscalate] = useState(false);
  const [escalateNote, setEscalateNote] = useState('');

  // Escalation is an ORG_ADMIN-only action (Administrators are the recipients).
  const canEscalate = user?.role === 'ORG_ADMIN';

  const mut = useMutation({
    mutationFn: (payload: unknown) => ticketingApi.updateTicket(ticket.id, payload),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ticketing'] }); },
  });

  const escalateMut = useMutation({
    mutationFn: () => ticketingApi.escalateTicket(ticket.id, { note: escalateNote.trim() || undefined }),
    onSuccess: () => {
      setShowEscalate(false);
      setEscalateNote('');
      void qc.invalidateQueries({ queryKey: ['ticketing'] });
    },
  });

  const dirty = status !== ticket.status || priority !== ticket.priority
    || assignee !== (ticket.assignee ?? '') || projectId !== (ticket.projectId ?? '');

  return (
    <>
      <tr onClick={onToggle} className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors cursor-pointer ${expanded ? 'bg-slate-50' : ''}`}>
        <td className="px-5 py-3.5"><StatusBadge status={ticket.status} /></td>
        <td className="px-5 py-3.5">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-slate-900 leading-tight truncate max-w-xs">{ticket.subject}</p>
            {ticket.escalated && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-rose-700 bg-rose-50 flex-shrink-0" title="Forwarded to platform administrators">
                ↑ ESCALATED
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">{ticket.issueType} · {ticket.raisedBy?.name ?? 'Unknown'} · {timeAgo(ticket.createdAt)}</p>
        </td>
        <td className="px-5 py-3.5">
          <span className={`inline-flex px-2 py-0.5 rounded-md text-[11px] font-semibold ${priorityCls[ticket.priority]}`}>{ticket.priority}</span>
        </td>
        <td className="px-5 py-3.5 text-xs text-slate-600">{ticket.assignee ?? <span className="text-red-500 font-semibold">Unassigned</span>}</td>
        <td className="px-5 py-3.5 text-right">
          <svg className={`w-4 h-4 text-slate-400 inline transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50/70 border-b border-slate-100">
          <td colSpan={5} className="px-5 py-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Description</p>
                <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
                  {ticket.description || <span className="text-slate-400 italic">No description provided.</span>}
                </p>
                {ticket.raisedBy && <p className="text-[11px] text-slate-400 mt-2">Raised by {ticket.raisedBy.name} · {ticket.raisedBy.email} · {fmtDate(ticket.createdAt)}</p>}
              </div>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Status</label>
                    <select value={status} onChange={(e) => setStatus(e.target.value as TicketingStatus)} className="input !py-1.5 text-xs">
                      {(['TODO', 'IN_PROGRESS', 'COMPLETED'] as const).map((s) => <option key={s} value={s}>{statusCfg[s]?.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Priority</label>
                    <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className="input !py-1.5 text-xs">
                      {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Assignee</label>
                    <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="Unassigned" className="input !py-1.5 text-xs" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Project</label>
                    <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input !py-1.5 text-xs">
                      <option value="">— None —</option>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <GlowButton className="py-1.5 px-4 text-xs" disabled={!dirty || mut.isPending} loading={mut.isPending}
                    onClick={() => mut.mutate({
                      ...(status !== ticket.status ? { status } : {}),
                      ...(priority !== ticket.priority ? { priority } : {}),
                      ...(assignee !== (ticket.assignee ?? '') ? { assignee: assignee || null } : {}),
                      ...(projectId !== (ticket.projectId ?? '') ? { projectId: projectId || null } : {}),
                    })}>
                    {mut.isPending ? 'Saving…' : 'Save Changes'}
                  </GlowButton>

                  {/* Escalation to platform administrators — ORG_ADMIN only */}
                  {canEscalate && (ticket.escalated ? (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold text-rose-700 bg-rose-50">
                      ↑ Escalated to platform administrators
                    </span>
                  ) : !showEscalate ? (
                    <button type="button" onClick={() => setShowEscalate(true)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-rose-600 border border-rose-200 hover:bg-rose-50 transition-colors cursor-pointer">
                      ↑ Escalate
                    </button>
                  ) : null)}
                </div>

                {canEscalate && showEscalate && !ticket.escalated && (
                  <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                    className="p-3 rounded-lg bg-rose-50/60 border border-rose-200 space-y-2">
                    <p className="text-[11px] font-semibold text-rose-700">
                      Forward this ticket to the platform administrators — they are notified immediately.
                    </p>
                    <textarea value={escalateNote} onChange={(e) => setEscalateNote(e.target.value)} rows={2} maxLength={1000}
                      placeholder="Why are you escalating? (optional, visible to administrators)" className="input resize-none text-xs" />
                    <div className="flex items-center gap-2">
                      <GlowButton variant="danger" className="py-1 px-3 text-xs"
                        disabled={escalateMut.isPending} loading={escalateMut.isPending}
                        onClick={() => escalateMut.mutate()}>
                        {escalateMut.isPending ? 'Escalating…' : 'Confirm Escalation'}
                      </GlowButton>
                      <button type="button" onClick={() => setShowEscalate(false)}
                        className="text-xs font-medium text-slate-500 hover:text-slate-800 cursor-pointer">Cancel</button>
                      {escalateMut.isError && <span className="text-[11px] text-red-600">Could not escalate — it may already be escalated.</span>}
                    </div>
                  </motion.div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function TicketsTab({ projectFilter, onClearProject }: { projectFilter: string | null; onClearProject: () => void }) {
  const [statusFilter, setStatusFilter] = useState<'ALL' | TicketingStatus>('ALL');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ tickets: TicketingTicket[] }>({
    queryKey: ['ticketing', 'tickets', statusFilter, projectFilter, search],
    queryFn: () => ticketingApi.listTickets({
      ...(statusFilter !== 'ALL' ? { status: statusFilter } : {}),
      ...(projectFilter ? { projectId: projectFilter } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
    }).then((r) => r.data as { tickets: TicketingTicket[] }),
    staleTime: 10_000,
  });

  const { data: projectsData } = useQuery<{ projects: TicketingProject[] }>({
    queryKey: ['ticketing', 'projects'],
    queryFn: () => ticketingApi.listProjects().then((r) => r.data as { projects: TicketingProject[] }),
    staleTime: 60_000,
  });

  const tickets = data?.tickets ?? [];
  const projects = projectsData?.projects ?? [];
  const projectName = projectFilter ? projects.find((p) => p.id === projectFilter)?.name : null;

  return (
    <div className="card overflow-hidden">
      <div className="px-3 py-2.5 border-b border-slate-100 flex items-center gap-2 flex-wrap">
        {(['ALL', 'TODO', 'IN_PROGRESS', 'COMPLETED'] as const).map((s) => (
          <button key={s} onClick={() => { setStatusFilter(s); setExpandedId(null); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer
              ${statusFilter === s ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>
            {s === 'ALL' ? 'All' : statusCfg[s]?.label}
          </button>
        ))}
        {projectName && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold text-brand bg-brand-50">
            Project: {projectName}
            <button type="button" onClick={onClearProject} className="hover:text-brand-700 cursor-pointer" aria-label="Clear project filter">✕</button>
          </span>
        )}
        <div className="flex-1 min-w-[180px] ml-auto">
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subject or issue type…" className="input !py-1.5 text-xs" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</th>
              <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Ticket</th>
              <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Priority</th>
              <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Assignee</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => <tr key={i}><td colSpan={5}><ShimmerRow /></td></tr>)
            ) : tickets.length === 0 ? (
              <tr><td colSpan={5} className="px-5 py-12 text-center text-sm text-slate-500">No tickets match this filter.</td></tr>
            ) : (
              tickets.map((t) => (
                <TicketRow
                  key={`${t.id}-${t.updatedAt}`}
                  ticket={t}
                  projects={projects}
                  expanded={expandedId === t.id}
                  onToggle={() => setExpandedId((prev) => (prev === t.id ? null : t.id))}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Projects tab ─────────────────────────────────────────────────────────────
function ProjectsTab({ onViewTickets }: { onViewTickets: (projectId: string) => void }) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState(PROJECT_CATEGORIES[0]!);
  const [priority, setPriority] = useState<Priority>('MEDIUM');
  const [assignees, setAssignees] = useState('');

  const { data, isLoading } = useQuery<{ projects: TicketingProject[] }>({
    queryKey: ['ticketing', 'projects'],
    queryFn: () => ticketingApi.listProjects().then((r) => r.data as { projects: TicketingProject[] }),
    staleTime: 30_000,
  });

  const createMut = useMutation({
    mutationFn: (payload: unknown) => ticketingApi.createProject(payload),
    onSuccess: () => {
      setShowForm(false); setName(''); setDescription(''); setAssignees('');
      void qc.invalidateQueries({ queryKey: ['ticketing'] });
    },
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => ticketingApi.deleteProject(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ticketing'] }); },
  });

  const projects = data?.projects ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">{projects.length} projects</p>
        <GlowButton className="py-1.5 px-3 text-xs" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : '+ New Project'}
        </GlowButton>
      </div>

      {showForm && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="card p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="input" placeholder="e.g. Network Refresh" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="input">
                {PROJECT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Description</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} className="input" placeholder="What this project covers" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <span className="block text-sm font-medium text-slate-700 mb-1.5">Priority</span>
              <div className="flex gap-2">
                {(['LOW', 'MEDIUM', 'HIGH'] as Priority[]).map((p) => (
                  <button key={p} type="button" onClick={() => setPriority(p)} aria-pressed={priority === p}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${priorityCls[p]} ${priority === p ? 'ring-2 ring-offset-1 ring-slate-300' : 'opacity-70 hover:opacity-100'}`}>
                    {p.charAt(0) + p.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Assignees <span className="text-slate-400 font-normal">(comma-separated)</span></label>
              <input value={assignees} onChange={(e) => setAssignees(e.target.value)} className="input" placeholder="IT Helpdesk, Network Team" />
            </div>
          </div>
          <GlowButton disabled={name.trim().length < 2 || createMut.isPending} loading={createMut.isPending}
            onClick={() => createMut.mutate({
              name: name.trim(),
              description: description.trim(),
              category,
              priority,
              assignees: assignees.split(',').map((a) => a.trim()).filter(Boolean),
            })}>
            Create Project
          </GlowButton>
        </motion.div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{Array.from({ length: 2 }).map((_, i) => <ShimmerCard key={i} />)}</div>
      ) : projects.length === 0 ? (
        <div className="card p-10 text-center text-sm text-slate-500">No projects yet. Create one to group tickets.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => (
            <div key={p.id} className="card p-5 border-t-2 border-t-brand/60 flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-base font-semibold text-slate-900">{p.name}</h3>
                <button type="button" aria-label={`Delete ${p.name}`}
                  onClick={() => { if (confirm(`Delete project "${p.name}"? Its tickets are kept and unassigned.`)) deleteMut.mutate(p.id); }}
                  className="text-slate-300 hover:text-red-500 transition-colors cursor-pointer">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-1.5 flex-1">{p.description || '—'}</p>
              <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold text-slate-600 bg-slate-100">{p.category}</span>
                <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold ${priorityCls[p.priority]}`}>{p.priority.toLowerCase()}</span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2">
                {p.assignees.length} assignee{p.assignees.length === 1 ? '' : 's'}{p.assignees.length > 0 && ` · ${p.assignees.join(', ')}`}
              </p>
              <div className="flex gap-2 mt-4 pt-3 border-t border-slate-100">
                <GlowButton variant="secondary" className="py-1 px-3 text-xs flex-1" onClick={() => onViewTickets(p.id)}>
                  View Tickets
                </GlowButton>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Reports tab ──────────────────────────────────────────────────────────────
function ReportsTab() {
  const [type, setType] = useState<'issue' | 'status' | 'user' | 'project'>('issue');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [report, setReport] = useState<TicketingReport | null>(null);
  const [generating, setGenerating] = useState(false);

  const typeLabel: Record<string, string> = {
    issue: 'Issue-wise Report', status: 'Status-wise Report', user: 'User-wise Report', project: 'Project-wise Report',
  };

  async function generate() {
    setGenerating(true);
    try {
      const { data } = await ticketingApi.getReport({
        type,
        ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
        ...(to ? { to: `${to}T23:59:59.999Z` } : {}),
      });
      setReport(data as TicketingReport);
    } finally {
      setGenerating(false);
    }
  }

  function exportCsv() {
    if (!report) return;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['Group', 'Total', 'Completed', 'In Progress', 'To Do', 'High Priority'],
      ...report.rows.map((r) => [r.group, r.total, r.completed, r.inProgress, r.todo, r.highPriority]),
    ];
    const blob = new Blob([rows.map((r) => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ticket-report-${type}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function exportPdf() {
    if (!report) return;
    const { default: JsPDF } = await import('jspdf');
    const doc = new JsPDF();
    doc.setFontSize(16);
    doc.text(typeLabel[type] ?? 'Ticket Report', 14, 18);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Generated ${new Date().toLocaleString()} · ${report.totalTickets} tickets${from ? ` · from ${from}` : ''}${to ? ` to ${to}` : ''}`, 14, 26);

    let y = 38;
    doc.setTextColor(0);
    doc.setFont('helvetica', 'bold');
    doc.text('Group', 14, y); doc.text('Total', 110, y); doc.text('Done', 130, y);
    doc.text('In Prog', 148, y); doc.text('To Do', 170, y); doc.text('High', 188, y);
    doc.setFont('helvetica', 'normal');
    y += 4; doc.line(14, y, 196, y); y += 6;

    for (const r of report.rows) {
      if (y > 280) { doc.addPage(); y = 20; }
      doc.text(r.group.slice(0, 52), 14, y);
      doc.text(String(r.total), 110, y); doc.text(String(r.completed), 130, y);
      doc.text(String(r.inProgress), 148, y); doc.text(String(r.todo), 170, y);
      doc.text(String(r.highPriority), 188, y);
      y += 7;
    }
    doc.save(`ticket-report-${type}-${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="text-sm font-semibold text-slate-900 mb-3">Generate Report</p>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Report Type</label>
            <select value={type} onChange={(e) => setType(e.target.value as typeof type)} className="input !py-1.5 text-xs w-auto">
              {Object.entries(typeLabel).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Start Date</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input !py-1.5 text-xs w-auto" />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">End Date</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input !py-1.5 text-xs w-auto" />
          </div>
          <GlowButton className="py-1.5 px-4 text-xs" onClick={() => void generate()} disabled={generating} loading={generating}>
            {generating ? 'Generating…' : 'Generate Report'}
          </GlowButton>
          {report && (
            <div className="flex gap-2 ml-auto">
              <GlowButton variant="secondary" className="py-1.5 px-3 text-xs" onClick={exportCsv}>CSV ↓</GlowButton>
              <GlowButton variant="secondary" className="py-1.5 px-3 text-xs" onClick={() => void exportPdf()}>PDF ↓</GlowButton>
            </div>
          )}
        </div>
      </div>

      {!report ? (
        <div className="card p-12 text-center">
          <p className="text-sm font-semibold text-slate-600">No report generated yet</p>
          <p className="text-xs text-slate-400 mt-1">Configure the filters above and click "Generate Report"</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-baseline justify-between">
            <p className="text-sm font-semibold text-slate-900">{typeLabel[report.type]}</p>
            <span className="text-xs text-slate-400 tabular-nums">{report.totalTickets} tickets in range</span>
          </div>
          <table className="min-w-full">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {['Group', 'Total', 'Completed', 'In Progress', 'To Do', 'High Priority'].map((h, i) => (
                  <th key={h} className={`px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">No tickets in the selected range.</td></tr>
              ) : report.rows.map((r) => (
                <tr key={r.group} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-3 text-sm font-medium text-slate-900">{r.group}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-sm font-semibold text-slate-900">{r.total}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-sm text-emerald-600">{r.completed}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-sm text-cyan-600">{r.inProgress}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-sm text-amber-600">{r.todo}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-sm text-red-600">{r.highPriority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Control system shell ─────────────────────────────────────────────────────
export default function AdminTicketing() {
  const searchParams = useSearchParams();
  const initialTab = (searchParams.get('tab') as Tab | null);
  const [tab, setTab] = useState<Tab>(initialTab && TABS.includes(initialTab) ? initialTab : 'overview');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  const { data: projectsData } = useQuery<{ projects: TicketingProject[] }>({
    queryKey: ['ticketing', 'projects'],
    queryFn: () => ticketingApi.listProjects().then((r) => r.data as { projects: TicketingProject[] }),
    staleTime: 60_000,
  });

  const visibleTabs = useMemo(() => TABS, []);

  return (
    <div className="p-8 max-w-[1300px] mx-auto space-y-6">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
        <p className="text-sm text-slate-500 mb-1">Ticketing · Control System</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Ticketing Dashboard</h1>
        <p className="mt-1 text-sm text-slate-500">Manage your organization's IT tickets — you're alerted instantly when a user raises one.</p>
      </motion.div>

      {/* Tabs */}
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.04 }}
        className="flex items-center gap-1 border-b border-slate-200 overflow-x-auto">
        {visibleTabs.map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors cursor-pointer border-b-2 -mb-px
              ${tab === t ? 'border-brand text-brand' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </motion.div>

      <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
        {tab === 'overview' && <OverviewTab />}
        {tab === 'tickets' && <TicketsTab projectFilter={projectFilter} onClearProject={() => setProjectFilter(null)} />}
        {tab === 'projects' && <ProjectsTab onViewTickets={(id) => { setProjectFilter(id); setTab('tickets'); }} />}
        {tab === 'reports' && <ReportsTab />}
        {tab === 'new' && (
          <div className="max-w-[640px]">
            <NewTicketForm projects={projectsData?.projects ?? []} onCreated={() => setTab('tickets')} />
          </div>
        )}
      </motion.div>
    </div>
  );
}
