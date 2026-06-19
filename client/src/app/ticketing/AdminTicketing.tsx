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
import {
  NewTicketForm, StatusBadge, PriorityBadge, TypeBadge, SlaBadge, PageHeader,
  statusCfg, priorityCls, timeAgo, STATUS_OPTIONS, PRIORITY_OPTIONS,
} from './shared';
import TicketDetail from './TicketDetail';
import type { TicketDTO, TicketProject, TicketSla, TicketStats, TicketAnalytics, TicketReport, TicketStatus, TicketPriority } from '@/lib/schemas';

const DONUT_COLORS = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#64748b'];
type Staff = { id: string; name: string; email: string; role: string };

const TABS = ['overview', 'tickets', 'projects', 'slas', 'reports', 'new'] as const;
type Tab = typeof TABS[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview', tickets: 'Tickets', projects: 'Projects', slas: 'SLAs', reports: 'Reports', new: '+ New Ticket',
};

function StatTile({ label, value, tone, sub }: { label: string; value: number | string; tone: string; sub?: string }) {
  return (
    <div className="card relative overflow-hidden p-5 hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-200">
      <span className={`absolute top-0 inset-x-0 h-0.5 ${tone}`} />
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">{label}</p>
        <span className={`w-2 h-2 rounded-full ${tone}`} />
      </div>
      <p className="font-mono text-[1.75rem] font-bold text-slate-900 tabular-nums leading-none">{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-2">{sub}</p>}
    </div>
  );
}

// ─── Overview ──────────────────────────────────────────────────────────────────
function OverviewTab() {
  const { data: stats, isLoading: sl } = useQuery<TicketStats>({
    queryKey: ['ticketing', 'stats'], queryFn: () => ticketingApi.getStats().then((r) => r.data as TicketStats), staleTime: 15_000,
  });
  const { data: analytics, isLoading: al } = useQuery<TicketAnalytics>({
    queryKey: ['ticketing', 'analytics'], queryFn: () => ticketingApi.getAnalytics().then((r) => r.data as TicketAnalytics), staleTime: 30_000,
  });
  const t = stats?.tickets;
  const dist = analytics?.issueDistribution ?? [];
  const distTotal = dist.reduce((s, d) => s + d.count, 0) || 1;

  return (
    <div className="space-y-6">
      {sl ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">{Array.from({ length: 6 }).map((_, i) => <ShimmerCard key={i} />)}</div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          <StatTile label="Total" value={t?.total ?? 0} tone="bg-brand" />
          <StatTile label="Completed" value={t?.completed ?? 0} tone="bg-emerald-500" />
          <StatTile label="In Progress" value={t?.inProgress ?? 0} tone="bg-cyan-500" />
          <StatTile label="Client Pending" value={t?.clientPending ?? 0} tone="bg-amber-500" />
          <StatTile label="High / Urgent" value={t?.highPriority ?? 0} tone="bg-red-500" />
          <StatTile label="Completion" value={`${t?.completionRate ?? 0}%`} tone="bg-violet-500" />
        </div>
      )}

      <div className="card p-5">
        <h3 className="text-base font-semibold text-slate-900 mb-2">Ticket types</h3>
        {al ? <ShimmerCard /> : dist.length === 0 ? (
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
            <div className="space-y-1.5">
              {dist.map((d, i) => (
                <div key={d.issue} className="flex items-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                  <span className="flex-1 text-slate-700 truncate capitalize">{d.issue}</span>
                  <span className="font-mono tabular-nums font-semibold text-slate-900">{d.count}</span>
                  <span className="font-mono tabular-nums text-slate-400 w-12 text-right">({((d.count / distTotal) * 100).toFixed(0)}%)</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tickets ───────────────────────────────────────────────────────────────────
function TicketRow({ ticket, projects, staff, expanded, onToggle, onOpenDetail }: {
  ticket: TicketDTO; projects: TicketProject[]; staff: Staff[]; expanded: boolean; onToggle: () => void; onOpenDetail: () => void;
}) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<TicketStatus>(ticket.status);
  const [priority, setPriority] = useState<TicketPriority>(ticket.priority);
  const [assigneeId, setAssigneeId] = useState(ticket.assignee?.id ?? '');
  const [projectId, setProjectId] = useState(ticket.projectId);

  const mut = useMutation({
    mutationFn: (payload: unknown) => ticketingApi.updateTicket(ticket.id, payload),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ticketing'] }); },
  });
  const dirty = status !== ticket.status || priority !== ticket.priority
    || assigneeId !== (ticket.assignee?.id ?? '') || projectId !== ticket.projectId;

  return (
    <>
      <tr onClick={onToggle} className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors cursor-pointer ${expanded ? 'bg-slate-50' : ''}`}>
        <td className="px-5 py-3.5 font-mono text-xs font-bold text-slate-400 whitespace-nowrap">{ticket.ticketNumber}</td>
        <td className="px-5 py-3.5">
          <p className="text-sm font-semibold text-slate-900 leading-tight truncate max-w-xs">{ticket.title}</p>
          <p className="text-[11px] text-slate-400 mt-0.5">{ticket.projectName ?? 'No project'} · {ticket.reporter?.name ?? 'Unknown'} · {timeAgo(ticket.createdAt)}</p>
        </td>
        <td className="px-5 py-3.5"><StatusBadge status={ticket.status} /></td>
        <td className="px-5 py-3.5"><PriorityBadge priority={ticket.priority} /></td>
        <td className="px-5 py-3.5"><SlaBadge status={ticket.slaStatus} remainingSeconds={ticket.slaRemainingSeconds} /></td>
        <td className="px-5 py-3.5 text-xs text-slate-600">{ticket.assignee?.name ?? <span className="text-red-500 font-semibold">Unassigned</span>}</td>
        <td className="px-5 py-3.5 text-right">
          <svg className={`w-4 h-4 text-slate-400 inline transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50/70 border-b border-slate-100">
          <td colSpan={7} className="px-5 py-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div>
                <div className="flex items-center gap-2 mb-1"><TypeBadge type={ticket.type} />{ticket.branch && <span className="text-[11px] font-mono text-slate-400">⎇ {ticket.branch}</span>}{ticket.onSiteSupportRequired && <span className="text-[10px] font-bold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">ON-SITE</span>}</div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Description</p>
                <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{ticket.description || <span className="text-slate-400 italic">None</span>}</p>
                <p className="text-[11px] text-slate-400 mt-2">
                  {ticket.sla ? `SLA: ${ticket.sla.name} · ${ticket.sla.resolutionTime}${ticket.sla.timeUnit[0]}` : 'No SLA'} ·
                  {' '}{ticket.counts.comments} comments · {ticket.counts.attachments} files · {ticket.counts.watchers} watchers
                </p>
                <button type="button" onClick={onOpenDetail} className="mt-2 text-xs font-semibold text-brand hover:text-brand-700 cursor-pointer">Open full detail →</button>
              </div>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Status</label>
                    <select value={status} onChange={(e) => setStatus(e.target.value as TicketStatus)} className="input !py-1.5 text-xs">
                      {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Priority</label>
                    <select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)} className="input !py-1.5 text-xs">
                      {PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Assignee</label>
                    <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className="input !py-1.5 text-xs">
                      <option value="">Unassigned</option>
                      {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Project</label>
                    <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input !py-1.5 text-xs">
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                </div>
                <GlowButton className="py-1.5 px-4 text-xs" disabled={!dirty || mut.isPending} loading={mut.isPending}
                  onClick={() => mut.mutate({
                    ...(status !== ticket.status ? { status } : {}),
                    ...(priority !== ticket.priority ? { priority } : {}),
                    ...(assigneeId !== (ticket.assignee?.id ?? '') ? { assigneeId: assigneeId || null } : {}),
                    ...(projectId !== ticket.projectId ? { projectId } : {}),
                  })}>
                  {mut.isPending ? 'Saving…' : 'Save Changes'}
                </GlowButton>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function TicketsTab({ projectFilter, onClearProject }: { projectFilter: string | null; onClearProject: () => void }) {
  const [statusFilter, setStatusFilter] = useState<'ALL' | TicketStatus>('ALL');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ tickets: TicketDTO[] }>({
    queryKey: ['ticketing', 'tickets', statusFilter, projectFilter, search],
    queryFn: () => ticketingApi.listTickets({
      ...(statusFilter !== 'ALL' ? { status: statusFilter } : {}),
      ...(projectFilter ? { projectId: projectFilter } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
    }).then((r) => r.data as { tickets: TicketDTO[] }),
    staleTime: 10_000,
  });
  const { data: projectsData } = useQuery<{ projects: TicketProject[] }>({
    queryKey: ['ticketing', 'projects'], queryFn: () => ticketingApi.listProjects().then((r) => r.data as { projects: TicketProject[] }), staleTime: 60_000,
  });
  const { data: staffData } = useQuery<{ assignees: Staff[] }>({
    queryKey: ['ticketing', 'assignees'], queryFn: () => ticketingApi.listAssignees().then((r) => r.data as { assignees: Staff[] }), staleTime: 60_000,
  });

  const tickets = data?.tickets ?? [];
  const projects = projectsData?.projects ?? [];
  const projectName = projectFilter ? projects.find((p) => p.id === projectFilter)?.name : null;

  return (
    <>
    {detailId && <TicketDetail ticketId={detailId} onClose={() => setDetailId(null)} />}
    <div className="card overflow-hidden">
      <div className="px-3 py-2.5 border-b border-slate-100 flex items-center gap-2 flex-wrap">
        {(['ALL', 'todo', 'in_progress', 'client_pending', 'completed'] as const).map((s) => (
          <button key={s} onClick={() => { setStatusFilter(s); setExpandedId(null); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${statusFilter === s ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>
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
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title or TKT-number…" className="input !py-1.5 text-xs" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {['Ticket #', 'Title', 'Status', 'Priority', 'SLA', 'Assignee', ''].map((h, i) => (
                <th key={i} className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => <tr key={i}><td colSpan={7}><ShimmerRow /></td></tr>)
            ) : tickets.length === 0 ? (
              <tr><td colSpan={7} className="px-5 py-12 text-center text-sm text-slate-500">No tickets match this filter.</td></tr>
            ) : (
              tickets.map((t) => (
                <TicketRow key={`${t.id}-${t.updatedAt}`} ticket={t} projects={projects} staff={staffData?.assignees ?? []}
                  expanded={expandedId === t.id} onToggle={() => setExpandedId((p) => (p === t.id ? null : t.id))} onOpenDetail={() => setDetailId(t.id)} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
    </>
  );
}

// ─── Projects ──────────────────────────────────────────────────────────────────
function ProjectsTab({ onViewTickets }: { onViewTickets: (projectId: string) => void }) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [type, setType] = useState('software');
  const [priority, setPriority] = useState('medium');
  const [rrEnabled, setRrEnabled] = useState(false);
  const [rrAssignees, setRrAssignees] = useState<string[]>([]);

  const { data, isLoading } = useQuery<{ projects: TicketProject[] }>({
    queryKey: ['ticketing', 'projects'], queryFn: () => ticketingApi.listProjects().then((r) => r.data as { projects: TicketProject[] }), staleTime: 30_000,
  });
  const { data: staffData } = useQuery<{ assignees: Staff[] }>({
    queryKey: ['ticketing', 'assignees'], queryFn: () => ticketingApi.listAssignees().then((r) => r.data as { assignees: Staff[] }), staleTime: 60_000,
  });

  const createMut = useMutation({
    mutationFn: (payload: unknown) => ticketingApi.createProject(payload),
    onSuccess: () => { setShowForm(false); setName(''); setDescription(''); setRrEnabled(false); setRrAssignees([]); void qc.invalidateQueries({ queryKey: ['ticketing'] }); },
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => ticketingApi.deleteProject(id),
    onError: (e: unknown) => alert((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Could not delete project'),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ticketing'] }); },
  });

  const projects = data?.projects ?? [];
  const staff = staffData?.assignees ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">{projects.length} projects</p>
        <GlowButton className="py-1.5 px-3 text-xs" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ New Project'}</GlowButton>
      </div>

      {showForm && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="card p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-slate-700 mb-1.5">Name</label><input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} className="input" placeholder="e.g. Network Refresh" /></div>
            <div><label className="block text-sm font-medium text-slate-700 mb-1.5">Category</label><input value={category} onChange={(e) => setCategory(e.target.value)} className="input" /></div>
          </div>
          <div><label className="block text-sm font-medium text-slate-700 mb-1.5">Description</label><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} className="input" /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-slate-700 mb-1.5">Type</label>
              <select value={type} onChange={(e) => setType(e.target.value)} className="input">{['software', 'marketing', 'research', 'other'].map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
            <div><label className="block text-sm font-medium text-slate-700 mb-1.5">Priority</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className="input">{['low', 'medium', 'high'].map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
          </div>
          <div className="rounded-lg border border-slate-200 p-3 space-y-2">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={rrEnabled} onChange={(e) => setRrEnabled(e.target.checked)} className="w-4 h-4 rounded border-slate-300 text-brand" />
              <span className="text-sm font-medium text-slate-700">Round-robin auto-assignment</span>
            </label>
            {rrEnabled && (
              <select multiple value={rrAssignees} onChange={(e) => setRrAssignees(Array.from(e.target.selectedOptions, (o) => o.value))} className="input h-28 text-xs">
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.role}</option>)}
              </select>
            )}
          </div>
          <GlowButton disabled={name.trim().length < 2 || createMut.isPending} loading={createMut.isPending}
            onClick={() => createMut.mutate({
              name: name.trim(), description: description.trim(), category, type, priority,
              settings: { roundRobin: { enabled: rrEnabled, lastAssignedId: null }, assignees: rrAssignees },
            })}>Create Project</GlowButton>
        </motion.div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{Array.from({ length: 2 }).map((_, i) => <ShimmerCard key={i} />)}</div>
      ) : projects.length === 0 ? (
        <div className="card p-10 text-center text-sm text-slate-500">No projects yet. Create one to group tickets.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => (
            <div key={p.id} className="card p-5 border-t-2 border-t-brand/60 flex flex-col hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-200">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-base font-semibold text-slate-900">{p.name}</h3>
                <button type="button" aria-label={`Delete ${p.name}`} onClick={() => { if (confirm(`Delete project "${p.name}"?`)) deleteMut.mutate(p.id); }}
                  className="text-slate-300 hover:text-red-500 transition-colors cursor-pointer">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-1.5 flex-1">{p.description || '—'}</p>
              <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold text-slate-600 bg-slate-100">{p.category}</span>
                <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold text-slate-600 bg-slate-100">{p.type}</span>
                <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold ${priorityCls[p.priority]}`}>{p.priority}</span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2">{p.ticketCount} tickets · lead {p.lead?.name ?? '—'}</p>
              <div className="flex gap-2 mt-4 pt-3 border-t border-slate-100">
                <GlowButton variant="secondary" className="py-1 px-3 text-xs flex-1" onClick={() => onViewTickets(p.id)}>View Tickets</GlowButton>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SLAs ──────────────────────────────────────────────────────────────────────
function SlasTab() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('high');
  const [responseTime, setResponseTime] = useState(4);
  const [resolutionTime, setResolutionTime] = useState(24);
  const [timeUnit, setTimeUnit] = useState('hours');

  const { data, isLoading } = useQuery<{ slas: TicketSla[] }>({
    queryKey: ['ticketing', 'slas'], queryFn: () => ticketingApi.listSlas().then((r) => r.data as { slas: TicketSla[] }), staleTime: 30_000,
  });
  const createMut = useMutation({
    mutationFn: (payload: unknown) => ticketingApi.createSla(payload),
    onSuccess: () => { setShowForm(false); setName(''); void qc.invalidateQueries({ queryKey: ['ticketing', 'slas'] }); },
  });
  const deleteMut = useMutation({ mutationFn: (id: string) => ticketingApi.deleteSla(id), onSuccess: () => void qc.invalidateQueries({ queryKey: ['ticketing', 'slas'] }) });
  const slas = data?.slas ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">{slas.length} SLA policies · one active SLA is matched per ticket priority</p>
        <GlowButton className="py-1.5 px-3 text-xs" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : '+ New SLA'}</GlowButton>
      </div>
      {showForm && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="card p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <div><label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Name</label><input value={name} onChange={(e) => setName(e.target.value)} className="input !py-1.5 text-xs" /></div>
          <div><label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Priority</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)} className="input !py-1.5 text-xs">{PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></div>
          <div><label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Response</label><input type="number" min={1} value={responseTime} onChange={(e) => setResponseTime(+e.target.value)} className="input !py-1.5 text-xs" /></div>
          <div><label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Resolution</label><input type="number" min={1} value={resolutionTime} onChange={(e) => setResolutionTime(+e.target.value)} className="input !py-1.5 text-xs" /></div>
          <div><label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Unit</label>
            <select value={timeUnit} onChange={(e) => setTimeUnit(e.target.value)} className="input !py-1.5 text-xs">{['minutes', 'hours', 'days'].map((u) => <option key={u} value={u}>{u}</option>)}</select></div>
          <GlowButton className="py-1.5 px-4 text-xs" disabled={name.trim().length < 2 || createMut.isPending} loading={createMut.isPending}
            onClick={() => createMut.mutate({ name: name.trim(), priority, responseTime, resolutionTime, timeUnit })}>Create</GlowButton>
        </motion.div>
      )}
      {isLoading ? <ShimmerCard /> : slas.length === 0 ? (
        <div className="card p-10 text-center text-sm text-slate-500">No SLA policies yet.</div>
      ) : (
        <div className="card overflow-hidden">
          <table className="min-w-full">
            <thead><tr className="bg-slate-50 border-b border-slate-200">{['Name', 'Priority', 'Response', 'Resolution', 'Active', ''].map((h) => <th key={h} className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">{h}</th>)}</tr></thead>
            <tbody>
              {slas.map((s) => (
                <tr key={s.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-5 py-3 text-sm font-medium text-slate-900">{s.name}</td>
                  <td className="px-5 py-3">{s.priority ? <PriorityBadge priority={s.priority} /> : <span className="text-xs text-slate-400">any</span>}</td>
                  <td className="px-5 py-3 text-xs text-slate-600">{s.responseTime} {s.timeUnit}</td>
                  <td className="px-5 py-3 text-xs text-slate-600">{s.resolutionTime} {s.timeUnit}</td>
                  <td className="px-5 py-3">{s.isActive ? <span className="text-xs font-semibold text-emerald-600">Active</span> : <span className="text-xs text-slate-400">Off</span>}</td>
                  <td className="px-5 py-3 text-right"><button onClick={() => deleteMut.mutate(s.id)} className="text-slate-300 hover:text-red-500 text-xs cursor-pointer">Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Reports ───────────────────────────────────────────────────────────────────
function ReportsTab() {
  const [type, setType] = useState<'status' | 'priority' | 'type' | 'project' | 'assignee'>('status');
  const [report, setReport] = useState<TicketReport | null>(null);
  const [generating, setGenerating] = useState(false);
  const typeLabel: Record<string, string> = { status: 'By Status', priority: 'By Priority', type: 'By Type', project: 'By Project', assignee: 'By Assignee' };

  async function generate() {
    setGenerating(true);
    try { const { data } = await ticketingApi.getReport({ type }); setReport(data as TicketReport); } finally { setGenerating(false); }
  }
  function exportCsv() {
    if (!report) return;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Group', 'Total', 'Completed', 'In Progress', 'To Do', 'High/Urgent'], ...report.rows.map((r) => [r.group, r.total, r.completed, r.inProgress, r.todo, r.highPriority])];
    const blob = new Blob([rows.map((r) => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `ticket-report-${type}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-4">
      <div className="card p-5 flex items-end gap-3 flex-wrap">
        <div><label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Report Type</label>
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)} className="input !py-1.5 text-xs w-auto">{Object.entries(typeLabel).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <GlowButton className="py-1.5 px-4 text-xs" onClick={() => void generate()} disabled={generating} loading={generating}>{generating ? 'Generating…' : 'Generate'}</GlowButton>
        {report && <GlowButton variant="secondary" className="py-1.5 px-3 text-xs ml-auto" onClick={exportCsv}>CSV ↓</GlowButton>}
      </div>
      {!report ? (
        <div className="card p-12 text-center"><p className="text-sm font-semibold text-slate-600">No report generated yet</p></div>
      ) : (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-baseline justify-between"><p className="text-sm font-semibold text-slate-900">{typeLabel[report.type]}</p><span className="text-xs text-slate-400 tabular-nums">{report.totalTickets} tickets</span></div>
          <table className="min-w-full">
            <thead><tr className="bg-slate-50 border-b border-slate-200">{['Group', 'Total', 'Completed', 'In Progress', 'To Do', 'High/Urgent'].map((h, i) => <th key={h} className={`px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {report.rows.length === 0 ? <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">No tickets in range.</td></tr> : report.rows.map((r) => (
                <tr key={r.group} className="border-b border-slate-100 last:border-0">
                  <td className="px-5 py-3 text-sm font-medium text-slate-900 capitalize">{r.group}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-sm font-semibold text-slate-900">{r.total}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-sm text-emerald-600">{r.completed}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-sm text-cyan-600">{r.inProgress}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-sm text-slate-600">{r.todo}</td>
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

// ─── Shell ─────────────────────────────────────────────────────────────────────
export default function AdminTicketing() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const initialTab = (searchParams.get('tab') as Tab | null);
  const [tab, setTab] = useState<Tab>(initialTab && TABS.includes(initialTab) ? initialTab : 'overview');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  const { data: projectsData } = useQuery<{ projects: TicketProject[] }>({
    queryKey: ['ticketing', 'projects'], queryFn: () => ticketingApi.listProjects().then((r) => r.data as { projects: TicketProject[] }), staleTime: 60_000,
  });
  const visibleTabs = useMemo(() => TABS, []);

  const DashIcon = (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" />
    </svg>
  );

  return (
    <div className="p-8 max-w-[1300px] mx-auto space-y-6">
      <PageHeader eyebrow="Ticketing · Control System" title="Ticketing Dashboard"
        subtitle="Manage tickets, projects, and SLA policies — with ticket numbering, SLA timers, round-robin assignment, and an activity trail." icon={DashIcon} />

      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.04 }}
        className="inline-flex items-center gap-1 p-1 rounded-xl bg-slate-100 ring-1 ring-slate-200/70 overflow-x-auto max-w-full">
        {visibleTabs.map((tb) => (
          <button key={tb} type="button" onClick={() => setTab(tb)}
            className={`relative px-3.5 py-1.5 text-sm font-semibold whitespace-nowrap rounded-lg transition-colors cursor-pointer ${tab === tb ? 'text-brand' : 'text-slate-500 hover:text-slate-800'}`}>
            {tab === tb && <motion.span layoutId="adminTab" className="absolute inset-0 bg-white rounded-lg shadow-xs ring-1 ring-slate-200/80" transition={{ type: 'spring', stiffness: 400, damping: 32 }} />}
            <span className="relative z-10">{TAB_LABELS[tb]}</span>
          </button>
        ))}
      </motion.div>

      <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
        {tab === 'overview' && <OverviewTab />}
        {tab === 'tickets' && <TicketsTab projectFilter={projectFilter} onClearProject={() => setProjectFilter(null)} />}
        {tab === 'projects' && <ProjectsTab onViewTickets={(id) => { setProjectFilter(id); setTab('tickets'); }} />}
        {tab === 'slas' && <SlasTab />}
        {tab === 'reports' && <ReportsTab />}
        {tab === 'new' && (
          <div className="max-w-[820px]">
            <NewTicketForm projects={projectsData?.projects ?? []} role={user?.role ?? 'ORG_ADMIN'} onCreated={() => setTab('tickets')} onCancel={() => setTab('tickets')} />
          </div>
        )}
      </motion.div>
    </div>
  );
}
