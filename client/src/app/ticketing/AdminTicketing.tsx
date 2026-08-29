'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, AreaChart, Area, XAxis, YAxis } from 'recharts';
import { ticketingApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import GlowButton from '@/components/ui/GlowButton';
import { ShimmerCard } from '@/components/ui/Shimmer';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import {
  NewTicketForm, StatusBadge, PriorityBadge, TypeBadge, SlaBar, PageHeader,
  Toolbar, Segmented, SearchInput, EmptyState, Avatar, Icons,
  priorityCls, timeAgo, STATUS_OPTIONS, PRIORITY_OPTIONS, staffLabel,
} from './shared';
import AdminTicketDetail from './AdminTicketDetail';
import type { TicketDTO, TicketProject, TicketSla, TicketStats, TicketAnalytics, TicketReport, TicketStatus, TicketPriority } from '@/lib/schemas';

type Staff = { id: string; name: string; email: string; role: string };
const STATUS_TONES: Record<string, string> = { todo: '#64748b', in_progress: '#06b6d4', client_pending: '#f59e0b', completed: '#10b981' };

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
  const daily = analytics?.daily ?? [];
  const createdTotal = daily.reduce((s, d) => s + d.created, 0);
  const peak = Math.max(1, ...daily.map((d) => d.created));
  const byPriority = analytics?.byPriority ?? [];
  const maxPrio = Math.max(1, ...byPriority.map((p) => p.count));

  const statusData = t ? ([
    { key: 'todo', name: 'To Do', value: t.todo },
    { key: 'in_progress', name: 'In Progress', value: t.inProgress },
    { key: 'client_pending', name: 'Client Pending', value: t.clientPending },
    { key: 'completed', name: 'Completed', value: t.completed },
  ]).filter((d) => d.value > 0) : [];
  const statusTotal = statusData.reduce((s, d) => s + d.value, 0) || 1;

  const StatSkeleton = <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">{Array.from({ length: 6 }).map((_, i) => <ShimmerCard key={i} />)}</div>;

  return (
    <div className="space-y-6">
      {sl ? StatSkeleton : (
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          <StatTile label="Total" value={t?.total ?? 0} tone="bg-brand" sub={`${t?.today ?? 0} today`} />
          <StatTile label="Open" value={t?.open ?? 0} tone="bg-amber-500" sub="unresolved" />
          <StatTile label="In Progress" value={t?.inProgress ?? 0} tone="bg-cyan-500" />
          <StatTile label="Completed" value={t?.completed ?? 0} tone="bg-emerald-500" />
          <StatTile label="High / Urgent" value={t?.highPriority ?? 0} tone="bg-red-500" sub="needs attention" />
          <StatTile label="Completion" value={`${t?.completionRate ?? 0}%`} tone="bg-violet-500" />
        </div>
      )}

      {/* Created trend — last 14 days */}
      <div className="card p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-base font-semibold text-slate-900">Created — last 14 days</h3>
          <span className="text-xs text-slate-400">
            <span className="font-mono font-bold text-slate-700 tabular-nums">{createdTotal}</span> new · peak <span className="font-mono font-semibold text-slate-600 tabular-nums">{peak}</span>/day
          </span>
        </div>
        {al ? <div className="h-[200px]"><ShimmerCard /></div> : (
          <div className="h-[200px] -ml-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={daily} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="createdFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2563EB" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="#2563EB" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} interval={1} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={26} />
                <Tooltip formatter={(v: number) => [`${v} ticket${v === 1 ? '' : 's'}`, 'Created']} labelFormatter={(d: string) => d}
                  contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12, boxShadow: '0 4px 12px -2px rgba(15,23,42,0.1)' }} />
                <Area type="monotone" dataKey="created" stroke="#2563EB" strokeWidth={2} fill="url(#createdFill)" dot={false} activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Status breakdown donut with total in the center */}
        <div className="card p-5">
          <h3 className="text-base font-semibold text-slate-900 mb-2">Status breakdown</h3>
          {sl ? <ShimmerCard /> : statusData.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-500">No tickets to analyze yet.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
              <div className="relative h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={statusData} dataKey="value" nameKey="name" innerRadius={64} outerRadius={92} paddingAngle={2} strokeWidth={0}>
                      {statusData.map((d) => <Cell key={d.key} fill={STATUS_TONES[d.key]} />)}
                    </Pie>
                    <Tooltip formatter={(v: number, n: string) => [`${v} tickets`, n]} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="font-mono text-2xl font-bold text-slate-900 tabular-nums leading-none">{t?.total ?? 0}</span>
                  <span className="text-[11px] text-slate-400 mt-1">total tickets</span>
                </div>
              </div>
              <div className="space-y-2">
                {statusData.map((d) => (
                  <div key={d.key} className="flex items-center gap-2 text-xs">
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: STATUS_TONES[d.key] }} />
                    <span className="flex-1 text-slate-700 truncate">{d.name}</span>
                    <span className="font-mono tabular-nums font-semibold text-slate-900">{d.value}</span>
                    <span className="font-mono tabular-nums text-slate-400 w-12 text-right">({((d.value / statusTotal) * 100).toFixed(0)}%)</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Priority distribution */}
        <div className="card p-5">
          <h3 className="text-base font-semibold text-slate-900 mb-4">Tickets by priority</h3>
          {al ? <ShimmerCard /> : byPriority.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-500">No data yet.</p>
          ) : (
            <div className="space-y-3.5 pt-2">
              {byPriority.map((p) => (
                <div key={p.priority} className="flex items-center gap-3">
                  <span className="w-16 text-xs font-medium text-slate-600 capitalize">{p.priority}</span>
                  <div className="flex-1 h-2.5 rounded-full bg-slate-100 overflow-hidden">
                    <motion.div initial={{ width: 0 }} animate={{ width: `${(p.count / maxPrio) * 100}%` }} transition={{ duration: 0.5 }}
                      className={`h-full rounded-full ${priorityCls[p.priority]?.split(' ').find((c) => c.startsWith('bg-')) ?? 'bg-slate-400'}`} />
                  </div>
                  <span className="w-10 text-right font-mono tabular-nums text-sm font-semibold text-slate-900">{p.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Tickets ───────────────────────────────────────────────────────────────────
// Image-matched admin card: #TKT + title + status/priority/type badges, assignee,
// "Created X ago", and the dual Response/Resolution SLA bars.
function AdminTicketCard({ ticket, onOpen }: { ticket: TicketDTO; onOpen: () => void }) {
  return (
    <div onClick={onOpen}
      className="card p-4 cursor-pointer hover:shadow-card-hover hover:border-slate-300 transition-all">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[10px] font-bold text-slate-400">{ticket.ticketNumber}</span>
            <StatusBadge status={ticket.status} /><PriorityBadge priority={ticket.priority} /><TypeBadge type={ticket.type} />
          </div>
          <p className="text-sm font-semibold text-slate-900 leading-snug mt-1.5 line-clamp-2">{ticket.title}</p>
          <p className="text-[11px] text-slate-400 mt-1">Created {timeAgo(ticket.createdAt)}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {ticket.assignee
            ? <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-slate-600"><Avatar name={ticket.assignee.name} size="xs" />{ticket.assignee.name}</span>
            : <span className="text-[10px] font-semibold text-red-500">Unassigned</span>}
          <button type="button" aria-label="Open ticket" onClick={(e) => { e.stopPropagation(); onOpen(); }} className="text-slate-300 hover:text-slate-600 cursor-pointer">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" /></svg>
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5 mt-3 pt-3 border-t border-slate-100">
        <SlaBar label="Response" evaluation={ticket.responseSla} />
        <SlaBar label="Resolution" evaluation={ticket.resolutionSla} />
      </div>
    </div>
  );
}

type Category = 'all' | 'escalated';

function TicketsTab({ projectFilter, onClearProject, initialTicketId }: { projectFilter: string | null; onClearProject: () => void; initialTicketId?: string | null }) {
  const searchParams = useSearchParams();
  const [category, setCategory] = useState<Category>('all');
  const [statusFilter, setStatusFilter] = useState<'ALL' | TicketStatus>('ALL');
  const [priorityFilter, setPriorityFilter] = useState<'ALL' | TicketPriority>('ALL');
  // /ticketing?assignee=<id> lands pre-filtered — the deep link the ops
  // dashboard's assignee scorecards point at. Seeded once; the select owns it
  // afterwards, so clearing the filter does not fight the URL.
  const [assigneeFilter, setAssigneeFilter] = useState<'ALL' | string>(
    () => searchParams.get('assignee') ?? 'ALL',
  );
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [detailId, setDetailId] = useState<string | null>(initialTicketId ?? null);

  const { data: staffData } = useQuery<{ assignees: Staff[] }>({
    queryKey: ['ticketing', 'assignees'], queryFn: () => ticketingApi.listAssignees().then((r) => r.data as { assignees: Staff[] }), staleTime: 60_000,
  });
  const { data: projectsData } = useQuery<{ projects: TicketProject[] }>({
    queryKey: ['ticketing', 'projects'], queryFn: () => ticketingApi.listProjects().then((r) => r.data as { projects: TicketProject[] }), staleTime: 60_000,
  });

  const { data, isLoading } = useQuery<{ tickets: TicketDTO[] }>({
    queryKey: ['ticketing', 'tickets', category, statusFilter, priorityFilter, assigneeFilter, projectFilter, search],
    queryFn: () => ticketingApi.listTickets({
      ...(category === 'escalated' ? { escalatedOnly: true } : {}),
      ...(statusFilter !== 'ALL' ? { status: statusFilter } : {}),
      ...(priorityFilter !== 'ALL' ? { priority: priorityFilter } : {}),
      ...(assigneeFilter !== 'ALL' ? { assigneeId: assigneeFilter } : {}),
      ...(projectFilter ? { projectId: projectFilter } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
    }).then((r) => r.data as { tickets: TicketDTO[] }),
    staleTime: 10_000,
  });

  const tickets = data?.tickets ?? [];
  const projects = projectsData?.projects ?? [];
  const projectName = projectFilter ? projects.find((p) => p.id === projectFilter)?.name : null;

  const statusOptions: { value: 'ALL' | TicketStatus; label: string }[] = [{ value: 'ALL', label: 'All' }, ...STATUS_OPTIONS];
  const gridCls = view === 'grid' ? 'grid grid-cols-1 xl:grid-cols-2 gap-3' : 'space-y-3';

  // Group by originating organization for the Escalated category.
  const orgOf = (t: TicketDTO) => t.customer?.name ?? t.labels.find((l) => l.startsWith('org:'))?.slice(4) ?? 'Unknown organization';
  const groups = new Map<string, TicketDTO[]>();
  if (category === 'escalated') for (const t of tickets) { const k = orgOf(t); (groups.get(k) ?? groups.set(k, []).get(k)!).push(t); }

  return (
    <>
      {detailId && <AdminTicketDetail ticketId={detailId} onClose={() => setDetailId(null)} />}
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Segmented value={category} onChange={setCategory} layoutId="adminCategory"
            options={[{ value: 'all', label: 'All tickets' }, { value: 'escalated', label: 'Escalated' }]} />
          <p className="text-xs text-slate-400">{tickets.length} ticket{tickets.length === 1 ? '' : 's'}{category === 'escalated' ? ` · ${groups.size} organization${groups.size === 1 ? '' : 's'}` : ''}</p>
        </div>

        <Toolbar>
          <Segmented value={statusFilter} onChange={setStatusFilter} options={statusOptions} size="sm" layoutId="adminStatus" />
          <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value as 'ALL' | TicketPriority)} className="input !py-1.5 text-xs w-auto">
            <option value="ALL">All priorities</option>
            {PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} className="input !py-1.5 text-xs w-auto">
            <option value="ALL">All assignees</option>
            {(staffData?.assignees ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {projectName && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold text-brand bg-brand-50">
              {projectName}
              <button type="button" onClick={onClearProject} className="hover:text-brand-700 cursor-pointer" aria-label="Clear project filter">✕</button>
            </span>
          )}
          <SearchInput value={search} onChange={setSearch} placeholder="Search title or TKT-number…" />
          <Segmented value={view} onChange={setView} size="sm" layoutId="adminView"
            options={[{ value: 'list', label: 'List', icon: Icons.list }, { value: 'grid', label: 'Grid', icon: Icons.board }]} />
        </Toolbar>

        {isLoading ? (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{Array.from({ length: 4 }).map((_, i) => <ShimmerCard key={i} />)}</div>
        ) : tickets.length === 0 ? (
          <EmptyState icon={Icons.ticket({ className: 'w-6 h-6' })}
            title={category === 'escalated' ? 'No escalated tickets' : 'No tickets match this filter'}
            hint={category === 'escalated' ? 'Escalations from organizations will appear here, grouped per organization.' : 'Adjust the status, priority, assignee, or search filters above.'} />
        ) : category === 'escalated' ? (
          <div className="space-y-6">
            {[...groups.entries()].map(([org, list]) => (
              <div key={org} className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-slate-800">{org}</h3>
                  <span className="font-mono text-[11px] font-bold text-slate-400 tabular-nums">{list.length}</span>
                  <span className="flex-1 h-px bg-slate-200" />
                </div>
                <div className={gridCls}>
                  {list.map((t) => <AdminTicketCard key={`${t.id}-${t.updatedAt}`} ticket={t} onOpen={() => setDetailId(t.id)} />)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={gridCls}>
            {tickets.map((t) => <AdminTicketCard key={`${t.id}-${t.updatedAt}`} ticket={t} onOpen={() => setDetailId(t.id)} />)}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Projects ──────────────────────────────────────────────────────────────────
function ProjectsTab({ onViewTickets }: { onViewTickets: (projectId: string) => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
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
    onError: (e: unknown) => toast((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Could not delete project', 'error'),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ticketing'] }); },
  });

  const projects = data?.projects ?? [];
  const staff = staffData?.assignees ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">{projects.length} projects</p>
        <GlowButton className="py-1.5 px-3 text-xs inline-flex items-center gap-1" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : <><Icons.plus className="w-3.5 h-3.5" />New project</>}</GlowButton>
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
                {staff.map((s) => <option key={s.id} value={s.id}>{staffLabel(s, user?.role)}</option>)}
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
        <EmptyState title="No projects yet" hint="Create one to group tickets under a project." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => (
            <div key={p.id} className="card p-5 border-t-2 border-t-brand/60 flex flex-col hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-200">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-base font-semibold text-slate-900">{p.name}</h3>
                <button type="button" aria-label={`Delete ${p.name}`} onClick={async () => { if (await confirm({ title: 'Delete project', message: <>&ldquo;{p.name}&rdquo; and its links to tickets will be removed. This can&rsquo;t be undone.</>, confirmText: 'Delete', variant: 'danger' })) deleteMut.mutate(p.id); }}
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
        <GlowButton className="py-1.5 px-3 text-xs inline-flex items-center gap-1" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : <><Icons.plus className="w-3.5 h-3.5" />New SLA</>}</GlowButton>
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
        <EmptyState title="No SLA policies yet" hint="Add a policy to start tracking response and resolution targets." />
      ) : (
        <div className="card overflow-hidden">
          <table className="min-w-full">
            <thead><tr className="bg-slate-50 border-b border-slate-200">{['Name', 'Priority', 'Response', 'Resolution', 'Active', ''].map((h) => <th key={h} className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">{h}</th>)}</tr></thead>
            <tbody>
              {slas.map((s) => (
                <tr key={s.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
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
  const typeLbl: Record<string, string> = { status: 'By Status', priority: 'By Priority', type: 'By Type', project: 'By Project', assignee: 'By Assignee' };

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
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)} className="input !py-1.5 text-xs w-auto">{Object.entries(typeLbl).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <GlowButton className="py-1.5 px-4 text-xs" onClick={() => void generate()} disabled={generating} loading={generating}>{generating ? 'Generating…' : 'Generate'}</GlowButton>
        {report && <GlowButton variant="secondary" className="py-1.5 px-3 text-xs ml-auto" onClick={exportCsv}>CSV ↓</GlowButton>}
      </div>
      {!report ? (
        <EmptyState icon={Icons.filter({ className: 'w-6 h-6' })} title="No report generated yet" hint="Pick a grouping and generate a breakdown of your tickets." />
      ) : (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-baseline justify-between"><p className="text-sm font-semibold text-slate-900">{typeLbl[report.type]}</p><span className="text-xs text-slate-400 tabular-nums">{report.totalTickets} tickets</span></div>
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
  // /ticketing?ticket=<id> (the assignment push deep link) lands on the Tickets tab
  // with that ticket already open, unless an explicit ?tab= says otherwise.
  const deepLinkTicket = searchParams.get('ticket');
  const deepLinkTickets = deepLinkTicket || searchParams.get('assignee');
  const [tab, setTab] = useState<Tab>(
    initialTab && TABS.includes(initialTab) ? initialTab : deepLinkTickets ? 'tickets' : 'overview',
  );
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  const { data: projectsData } = useQuery<{ projects: TicketProject[] }>({
    queryKey: ['ticketing', 'projects'], queryFn: () => ticketingApi.listProjects().then((r) => r.data as { projects: TicketProject[] }), staleTime: 60_000,
  });
  const visibleTabs = useMemo(() => TABS, []);

  return (
    <div className="p-6 sm:p-8 max-w-[1300px] mx-auto space-y-6">
      {user?.role === 'ADMINISTRATOR' ? (
        <PageHeader eyebrow="Platform · Administrators store" title="Platform Ticketing"
          subtitle="The platform administrators' isolated ticket store (b2b_ticketing_admin) — escalations from client organizations plus tickets you create here. Separate from every client's tickets." icon={Icons.board({ className: 'w-6 h-6' })} />
      ) : (
        <PageHeader eyebrow="Ticketing · Control System" title="Ticketing Dashboard"
          subtitle="Manage tickets, projects, and SLA policies — with ticket numbering, SLA timers, round-robin assignment, and an activity trail." icon={Icons.board({ className: 'w-6 h-6' })} />
      )}

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
        {tab === 'tickets' && <TicketsTab projectFilter={projectFilter} onClearProject={() => setProjectFilter(null)} initialTicketId={deepLinkTicket} />}
        {tab === 'projects' && <ProjectsTab onViewTickets={(id) => { setProjectFilter(id); setTab('tickets'); }} />}
        {tab === 'slas' && <SlasTab />}
        {tab === 'reports' && <ReportsTab />}
        {/* `user` is guaranteed by the RoleGuard wrapping this page, so waiting on it
            costs nothing — but defaulting the role would not be free: ROLE_FIELDS keys
            the whole form off it, so an ADMINISTRATOR rendered as ORG_ADMIN silently
            loses the client / client-email / contact / branch / on-site fields and
            fires a /api/bots request they have no use for. Never guess this one. */}
        {tab === 'new' && user && (
          <div className="max-w-[820px]">
            <div className="card p-6 sm:p-8">
              <h3 className="text-lg font-bold tracking-tight text-slate-900 mb-5">Create new ticket</h3>
              <NewTicketForm projects={projectsData?.projects ?? []} role={user.role} onCreated={() => setTab('tickets')} onCancel={() => setTab('tickets')} />
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
