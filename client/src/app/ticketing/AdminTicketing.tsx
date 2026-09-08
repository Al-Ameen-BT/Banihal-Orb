'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, AreaChart, Area, BarChart, Bar, LabelList, XAxis, YAxis } from 'recharts';
import { agentApi, ticketingApi } from '@/lib/api';
import { exportXlsx } from '@/lib/exportXlsx';
import { useAuth } from '@/contexts/AuthContext';
import GlowButton from '@/components/ui/GlowButton';
import { ShimmerCard, ShimmerRow } from '@/components/ui/Shimmer';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import {
  NewTicketForm, StatusBadge, PriorityBadge, TypeBadge, SlaBar, PageHeader,
  Toolbar, Segmented, SearchInput, EmptyState, Avatar, Icons,
  priorityCls, timeAgo, STATUS_OPTIONS, PRIORITY_OPTIONS, staffLabel, apiErrorMessage,
  TicketActionsMenu, EditTicketModal, useDeleteTicket, useTicketProjects, useTicketAssignees,
  useCanEditTicket, type TicketMenuAction,
  Modal, ESCALATE_ADMINS_ID, fmtDate, type TicketCustomer,
} from './shared';
import AdminTicketDetail from './AdminTicketDetail';
import type { TicketDTO, TicketProject, TicketSla, TicketStats, TicketAnalytics, TicketReport, TicketReportType, ReportTicketRow, TicketStatus, TicketPriority, TicketActivityLogRow } from '@/lib/schemas';

const STATUS_TONES: Record<string, string> = { todo: '#64748b', in_progress: '#06b6d4', client_pending: '#f59e0b', completed: '#10b981' };

const TABS = ['overview', 'tickets', 'projects', 'slas', 'logs', 'reports', 'new'] as const;
type Tab = typeof TABS[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview', tickets: 'Tickets', projects: 'Projects', slas: 'SLAs',
  logs: 'Activity Log', reports: 'Reports', new: '+ New Ticket',
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

  const statusData = t ? ([
    { key: 'todo', name: 'To Do', value: t.todo },
    { key: 'in_progress', name: 'In Progress', value: t.inProgress },
    { key: 'client_pending', name: 'Client Pending', value: t.clientPending },
    { key: 'completed', name: 'Completed', value: t.completed },
  ]).filter((d) => d.value > 0) : [];
  const statusTotal = statusData.reduce((sum, d) => sum + d.value, 0) || 1;

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
        {/* Total tickets — donut by status, count in the middle */}
        <div className="card p-5">
          <h3 className="text-base font-semibold text-slate-900 mb-2">Total tickets</h3>
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
                    <Tooltip formatter={(v: number, n: string) => [`${v} tickets`, n]} contentStyle={chartTooltip} />
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

        <TopComplaintsChart />
      </div>
    </div>
  );
}

// ─── Top complaint categories (Analytics Agent) ────────────────────────────────
interface TopComplaints {
  complaints: { category: string; count: number }[];
  total: number;
  fetchedAt: string;
}

// Categorical hues in fixed order — slot i is category i in both charts, so a
// slice and its bar always carry the same colour. Never cycled: a ninth category
// folds into "Other" rather than reusing slot 1.
const COMPLAINT_HUES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

// Axis headings, not full names: the agent's categories run to 31 characters
// ("Endpoint Security / CrowdStrike"), which the old flat truncation cut
// mid-word. Keep the leading segment, drop the generic tail noun, and only then
// truncate — the untouched category still shows in full on hover.
const CATEGORY_NOISE = /\s+(issues?|problems?|requests?|tickets?|management|support|services?)$/i;

const shortLabel = (s: string) => {
  const head = (s.split(/\s*[&/·|,]\s*/)[0] ?? s).trim().replace(CATEGORY_NOISE, '').trim() || s;
  return head.length > 22 ? `${head.slice(0, 21)}…` : head;
};

const chartTooltip = {
  borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12,
  boxShadow: '0 4px 12px -2px rgba(15,23,42,0.1)',
} as const;

// The complaint mix across the whole estate, from the Analytics Agent's signed
// /v1 surface — a different source from the ticket counters above, which come
// from this platform's own store. The agent is a separate box, so a failure here
// is contained to this card (the call opts out of the global 5xx/403 redirects
// and `retry: false` keeps a dead agent cheap).
function TopComplaintsChart() {
  const { data, isLoading, isError } = useQuery<TopComplaints>({
    queryKey: ['ticketing', 'top-complaints'],
    queryFn: () => agentApi.topComplaints().then((r) => r.data as TopComplaints),
    staleTime: 300_000,
    retry: false,
  });

  const rows = useMemo(() => {
    const all = data?.complaints ?? [];
    if (all.length <= COMPLAINT_HUES.length) return all;
    const rest = all.slice(COMPLAINT_HUES.length - 1).reduce((sum, c) => sum + c.count, 0);
    return [...all.slice(0, COMPLAINT_HUES.length - 1), { category: 'Other', count: rest }];
  }, [data]);

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-base font-semibold text-slate-900">Top complaints by category</h3>
        {data && <span className="text-xs text-slate-400">{data.total.toLocaleString()} tickets · updated {timeAgo(data.fetchedAt)}</span>}
      </div>
      {isLoading ? <ShimmerCard /> : isError || rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-slate-500">
          {isError ? 'Analytics agent unavailable — complaint categories could not be loaded.' : 'No complaint categories reported yet.'}
        </p>
      ) : (
        <div className="h-[260px] -ml-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 34, left: 0, bottom: 0 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="category" tickFormatter={shortLabel} width={140}
                tick={{ fontSize: 11, fontWeight: 600, fill: '#334155' }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: '#f8fafc' }} formatter={(v: number) => [`${v} tickets`, 'Volume']} contentStyle={chartTooltip} />
              <Bar dataKey="count" barSize={14} radius={[0, 4, 4, 0]}>
                {rows.map((c, i) => <Cell key={c.category} fill={COMPLAINT_HUES[i]} />)}
                <LabelList dataKey="count" position="right" fontSize={11} fill="#475569" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ─── Tickets ───────────────────────────────────────────────────────────────────
/**
 * Which organization is this ticket for?
 *
 * The Customers row is the answer when there is one, but an ESCALATED ticket copied
 * into the admin store may have only the `org:<name>` label escalation stamps on it
 * — so a bare dash would hide the client on exactly the tickets an administrator most
 * needs it for. Shared by the card below and the escalated grouping in TicketsTab.
 */
const orgOf = (t: TicketDTO): string =>
  t.customer?.name ?? t.labels.find((l) => l.startsWith('org:'))?.slice(4) ?? 'Unknown organization';

// Image-matched admin card: #TKT + title + status/priority/type badges, assignee,
// "Created X ago", and the dual Response/Resolution SLA bars.
function AdminTicketCard({ ticket, onOpen, onEdit, onDelete }: {
  ticket: TicketDTO; onOpen: () => void; onEdit: () => void; onDelete: () => void;
}) {
  // Owner-based edit lock: only the ticket's reporter or assignee (with the write
  // permission) may edit/delete — see useCanEditTicket. Edit and Delete are left OUT
  // of the menu for everyone else; the server enforces the same rule regardless.
  const { user } = useAuth();
  const canEdit = useCanEditTicket(ticket, user);
  const actions: TicketMenuAction[] = [
    { label: 'Open', onSelect: onOpen },
    ...(canEdit
      ? [
          { label: 'Edit', onSelect: onEdit },
          { label: 'Delete', onSelect: onDelete, danger: true },
        ]
      : []),
  ];
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
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-slate-500 flex-wrap">
            <span className="inline-flex items-center gap-1.5 min-w-0" title={orgOf(ticket)}>
              <Avatar name={orgOf(ticket)} size="xs" />
              <span className="truncate max-w-[180px] font-medium text-slate-600">{orgOf(ticket)}</span>
            </span>
            <span className="text-slate-300">·</span>
            <span className="text-slate-400">Created {timeAgo(ticket.createdAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {ticket.assignee
            ? <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-slate-600"><Avatar name={ticket.assignee.name} size="xs" />{ticket.assignee.name}</span>
            : <span className="text-[10px] font-semibold text-red-500">Unassigned</span>}
          <TicketActionsMenu
            label={`Actions for ${ticket.ticketNumber}`}
            actions={actions}
          />
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

// Assignee ids are ticket-store UUIDs. A deep link carrying anything else (the
// ops dashboard's synthetic '__unassigned__' bucket, a stale id) must fall back
// to "no filter" rather than reach the API and fail validation.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function TicketsTab({ projectFilter, onClearProject, initialTicketId }: { projectFilter: string | null; onClearProject: () => void; initialTicketId?: string | null }) {
  const searchParams = useSearchParams();
  // Which ticket the edit modal is showing; null = closed.
  const [editing, setEditing] = useState<TicketDTO | null>(null);
  const { requestDelete } = useDeleteTicket();
  const [category, setCategory] = useState<Category>('all');
  const [statusFilter, setStatusFilter] = useState<'ALL' | TicketStatus>('ALL');
  const [priorityFilter, setPriorityFilter] = useState<'ALL' | TicketPriority>('ALL');
  // /ticketing?assignee=<id> lands pre-filtered — the deep link the ops
  // dashboard's assignee scorecards point at. Seeded once; the select owns it
  // afterwards, so clearing the filter does not fight the URL.
  const [assigneeFilter, setAssigneeFilter] = useState<'ALL' | string>(() => {
    // `??` does NOT catch an empty string, so `?assignee=` seeded the filter with
    // '' — which is not 'ALL', so it was sent as `assigneeId=''` and 400'd the
    // whole list. Anything that is not a real assignee id means "no filter".
    const raw = searchParams.get('assignee')?.trim();
    return raw && UUID_RE.test(raw) ? raw : 'ALL';
  });
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [detailId, setDetailId] = useState<string | null>(initialTicketId ?? null);

  const { data: staff = [] } = useTicketAssignees();
  const { data: projects = [] } = useTicketProjects();

  const { data, isLoading, isError, error, refetch } = useQuery<{ tickets: TicketDTO[] }>({
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
  const projectName = projectFilter ? projects.find((p) => p.id === projectFilter)?.name : null;

  const statusOptions: { value: 'ALL' | TicketStatus; label: string }[] = [{ value: 'ALL', label: 'All' }, ...STATUS_OPTIONS];
  const gridCls = view === 'grid' ? 'grid grid-cols-1 xl:grid-cols-2 gap-3' : 'space-y-3';

  // Group by originating organization for the Escalated category.
  const groups = new Map<string, TicketDTO[]>();
  if (category === 'escalated') for (const t of tickets) { const k = orgOf(t); (groups.get(k) ?? groups.set(k, []).get(k)!).push(t); }

  return (
    <>
      {detailId && <AdminTicketDetail ticketId={detailId} onClose={() => setDetailId(null)} />}
      {editing && <EditTicketModal ticket={editing} open onClose={() => setEditing(null)} />}
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
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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
        ) : isError ? (
          /* A failed fetch used to render as "No tickets match this filter" —
             indistinguishable from an empty result, so a rejected filter looked
             like an empty queue. Say what happened and offer a way out. */
          <div className="card p-8 text-center">
            <p className="text-sm font-medium text-slate-900">Couldn&apos;t load tickets</p>
            <p className="mt-1.5 text-sm text-slate-500">
              {apiErrorMessage(error, 'The ticket service did not respond. Your filters have not been changed.')}
            </p>
            <div className="mt-4 flex items-center justify-center gap-2">
              <GlowButton variant="secondary" className="py-1.5 px-3 text-xs" onClick={() => void refetch()}>Try again</GlowButton>
              <GlowButton variant="ghost" className="py-1.5 px-3 text-xs"
                onClick={() => { setStatusFilter('ALL'); setPriorityFilter('ALL'); setAssigneeFilter('ALL'); setSearch(''); onClearProject(); }}>
                Clear filters
              </GlowButton>
            </div>
          </div>
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
                  {list.map((t) => <AdminTicketCard key={`${t.id}-${t.updatedAt}`} ticket={t} onOpen={() => setDetailId(t.id)} onEdit={() => setEditing(t)} onDelete={() => void requestDelete(t)} />)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={gridCls}>
            {tickets.map((t) => <AdminTicketCard key={`${t.id}-${t.updatedAt}`} ticket={t} onOpen={() => setDetailId(t.id)} onEdit={() => setEditing(t)} onDelete={() => void requestDelete(t)} />)}
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

  const { data: projects = [], isLoading } = useTicketProjects();
  const { data: staff = [] } = useTicketAssignees();

  const createMut = useMutation({
    mutationFn: (payload: unknown) => ticketingApi.createProject(payload),
    onSuccess: () => { setShowForm(false); setName(''); setDescription(''); setRrEnabled(false); setRrAssignees([]); void qc.invalidateQueries({ queryKey: ['ticketing'] }); },
  });
  const deleteMut = useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm: string }) => ticketingApi.deleteProject(id, confirm),
    // Carries PROJECT_HAS_ESCALATIONS and CONFIRM_MISMATCH — both are things the
    // administrator has to read, not a generic failure.
    onError: (e: unknown) => toast((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Could not delete project', 'error'),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ticketing'] }); },
  });

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
                {/* Double verification: the dialog will not enable Delete until the
                    project's name is typed back, and the server re-checks the same
                    value. Deleting a project now takes its tickets with it, so the
                    message states the real count rather than "links to tickets". */}
                <button type="button" aria-label={`Delete ${p.name}`} onClick={async () => {
                  const ok = await confirm({
                    title: 'Delete project',
                    message: (
                      <>
                        &ldquo;{p.name}&rdquo; and its <span className="font-semibold text-slate-800">{p.ticketCount} ticket{p.ticketCount === 1 ? '' : 's'}</span> —
                        including every comment, attachment and activity record — will be permanently deleted. This can&rsquo;t be undone.
                      </>
                    ),
                    confirmText: 'Delete project',
                    variant: 'danger',
                    requireText: p.name,
                  });
                  if (ok) deleteMut.mutate({ id: p.id, confirm: p.name });
                }}
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

// ─── Activity Log ──────────────────────────────────────────────────────────────
// Every recorded action on every ticket in THIS store, newest first.
//
// Reads the ticket store's own Activities table rather than the platform AuditLog:
// it carries the fine-grained events (status/priority changes, assignment, comments,
// mentions, attachments) that the audit trail's five TICKET_* actions do not. The
// trade-off is that these rows cascade away with their ticket — the audit log in
// System Logs is the copy that survives a deletion, and the two are complementary.
//
// The server scopes the feed to the caller's own store and organization, so this one
// component serves ORG_ADMIN (their org, b2b_ticket) and ADMINISTRATOR (the whole
// admin store) with no branch here.
const ACTIVITY_TYPES = [
  { value: '', label: 'All activity' },
  { value: 'created', label: 'Created' },
  { value: 'updated', label: 'Edited' },
  { value: 'status_changed', label: 'Status changed' },
  { value: 'priority_changed', label: 'Priority changed' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'commented', label: 'Commented' },
  { value: 'attachment_added', label: 'Attachment added' },
  { value: 'mentioned', label: 'Mentioned' },
];

const ACTIVITY_TONE: Record<string, string> = {
  created: 'text-emerald-700 bg-emerald-50',
  updated: 'text-slate-600 bg-slate-100',
  status_changed: 'text-cyan-700 bg-cyan-50',
  priority_changed: 'text-amber-700 bg-amber-50',
  assigned: 'text-violet-700 bg-violet-50',
  commented: 'text-blue-700 bg-blue-50',
  attachment_added: 'text-slate-600 bg-slate-100',
  mentioned: 'text-fuchsia-700 bg-fuchsia-50',
};

const activityLabel = (t: string) => ACTIVITY_TYPES.find((a) => a.value === t)?.label ?? t;

// oldValue/newValue are Json columns, so they arrive as whatever was written —
// a string, a bool, an id, or null. Render something readable for each.
function valueText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function ActivityLogTab({ onOpenTicket }: { onOpenTicket: (id: string) => void }) {
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Cursor pages are a stack so "Previous" can pop back without re-querying forward.
  const [cursors, setCursors] = useState<string[]>([]);

  const cursor = cursors[cursors.length - 1];
  const params = useMemo(() => ({
    limit: 50,
    ...(type ? { type } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(from ? { from: `${from}T00:00:00` } : {}),
    ...(to ? { to: `${to}T23:59:59` } : {}),
    ...(cursor ? { cursor } : {}),
  }), [type, search, from, to, cursor]);

  const { data, isLoading, isError, error, refetch } = useQuery<{ activity: TicketActivityLogRow[]; nextCursor: string | null }>({
    queryKey: ['ticketing', 'activity-log', params],
    queryFn: () => ticketingApi.listActivityLog(params).then((r) => r.data as { activity: TicketActivityLogRow[]; nextCursor: string | null }),
    staleTime: 15_000,
  });

  const rows = data?.activity ?? [];

  // Any filter change invalidates the paging position — page 3 of the old filter is
  // meaningless under the new one.
  const resetPaging = () => setCursors([]);

  function exportCsv() {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      ['Time', 'Ticket', 'Title', 'Action', 'By', 'Field', 'From', 'To', 'Detail'],
      ...rows.map((a) => [
        new Date(a.createdAt).toISOString(), a.ticket?.ticketNumber ?? '', a.ticket?.title ?? '',
        activityLabel(a.type), a.user?.name ?? '', a.field ?? '',
        valueText(a.oldValue), valueText(a.newValue), a.description ?? '',
      ]),
    ].map((r) => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `ticket-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div className="space-y-4">
      <Toolbar>
        <select value={type} onChange={(e) => { setType(e.target.value); resetPaging(); }} className="input !py-1.5 text-xs w-auto" aria-label="Activity type">
          {ACTIVITY_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
        <SearchInput value={search} onChange={(v) => { setSearch(v); resetPaging(); }} placeholder="Search ticket number or title…" />
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          From
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); resetPaging(); }} className="input !py-1.5 text-xs w-auto" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          To
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); resetPaging(); }} className="input !py-1.5 text-xs w-auto" />
        </label>
        <GlowButton variant="secondary" className="py-1.5 px-3 text-xs" onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </GlowButton>
      </Toolbar>

      {isLoading ? (
        <div className="card divide-y divide-slate-100">{Array.from({ length: 8 }).map((_, i) => <ShimmerRow key={i} />)}</div>
      ) : isError ? (
        <div className="card p-8 text-center space-y-3">
          <p className="text-sm text-slate-600">{apiErrorMessage(error, 'The activity log could not be loaded.')}</p>
          <GlowButton variant="secondary" className="py-1.5 px-4 text-xs" onClick={() => void refetch()}>Try again</GlowButton>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No activity" hint="Nothing matches these filters yet." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 text-left">When</th>
                  <th className="px-4 py-2.5 text-left">Ticket</th>
                  <th className="px-4 py-2.5 text-left">Action</th>
                  <th className="px-4 py-2.5 text-left">By</th>
                  <th className="px-4 py-2.5 text-left">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50/70">
                    <td className="px-4 py-2.5 whitespace-nowrap text-xs text-slate-500" title={new Date(a.createdAt).toLocaleString()}>
                      {timeAgo(a.createdAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      {a.ticket ? (
                        <button type="button" onClick={() => onOpenTicket(a.ticket!.id)}
                          className="text-left cursor-pointer group">
                          <span className="font-mono text-xs font-semibold text-brand group-hover:underline">{a.ticket.ticketNumber}</span>
                          <span className="block max-w-[280px] truncate text-xs text-slate-500">{a.ticket.title}</span>
                        </button>
                      ) : <span className="text-xs text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex px-2 py-0.5 rounded-md text-[11px] font-semibold ${ACTIVITY_TONE[a.type] ?? 'text-slate-600 bg-slate-100'}`}>
                        {activityLabel(a.type)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-600 whitespace-nowrap">{a.user?.name ?? '—'}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {a.field
                        ? <span className="font-mono">{a.field}: {valueText(a.oldValue)} → {valueText(a.newValue)}</span>
                        : <span className="line-clamp-2 max-w-[420px]">{a.description ?? '—'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5">
            <span className="text-xs text-slate-400">{rows.length} entries{cursors.length > 0 ? ` · page ${cursors.length + 1}` : ''}</span>
            <div className="flex gap-2">
              <GlowButton variant="secondary" className="py-1 px-3 text-xs" disabled={cursors.length === 0}
                onClick={() => setCursors((c) => c.slice(0, -1))}>Previous</GlowButton>
              <GlowButton variant="secondary" className="py-1 px-3 text-xs" disabled={!data?.nextCursor}
                onClick={() => data?.nextCursor && setCursors((c) => [...c, data.nextCursor!])}>Next</GlowButton>
            </div>
          </div>
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
// Report type + client + date range → a field picker → an on-screen table and an
// .xlsx download.
//
// The server returns EVERY selectable column on every row, so the field picker is
// pure presentation: changing the column set re-renders, it never refetches.

const REPORT_TYPES: { value: TicketReportType; label: string }[] = [
  { value: 'client', label: 'Client-wise Report' },
  { value: 'assignee', label: 'Assignee-wise Report' },
  { value: 'overall', label: 'Overall Report' },
  { value: 'sla_breach', label: 'SLA Breach Report' },
];

// Every column the report can carry. `key` is what gets persisted, so renaming one
// silently drops it from a returning user's saved selection — add, don't rename.
interface ReportField {
  key: string;
  label: string;
  /** Cell value for the sheet: a real Date/number/boolean where the data is one, so
   *  Excel sorts and filters the column instead of treating it as text. */
  value: (t: ReportTicketRow) => string | number | boolean | Date | null;
  /** On-screen cell. Defaults to the exported value stringified. */
  render?: (t: ReportTicketRow) => React.ReactNode;
  numeric?: boolean;
}

const secondsToHours = (s: number): number => Math.round((s / 3600) * 10) / 10;

/** Age minus paused time — the same clock the server's breach rule runs, so the
 *  "Time open" column can never disagree with the SLA column beside it. */
function openHours(t: ReportTicketRow): number {
  const wall = (Date.now() - new Date(t.createdAt).getTime()) / 1000;
  let paused = t.totalPausedTime;
  if (t.status === 'client_pending' && t.pausedTime) paused += (Date.now() - new Date(t.pausedTime).getTime()) / 1000;
  return secondsToHours(Math.max(wall - paused, 0));
}

const isOpenStatus = (s: string) => s !== 'completed';
function breached(t: ReportTicketRow): boolean {
  if (!isOpenStatus(t.status) || t.slaResolutionSeconds === null) return false;
  return openHours(t) * 3600 > t.slaResolutionSeconds;
}

const REPORT_FIELDS: ReportField[] = [
  { key: 'ticketNumber', label: 'Ticket #', value: (t) => t.ticketNumber,
    render: (t) => <span className="font-mono text-xs font-semibold text-slate-900">{t.ticketNumber}</span> },
  { key: 'title', label: 'Title', value: (t) => t.title,
    render: (t) => <span className="block max-w-[320px] truncate">{t.title}</span> },
  { key: 'customerName', label: 'Client', value: (t) => t.customerName ?? '' },
  { key: 'projectName', label: 'Project', value: (t) => t.projectName ?? '' },
  { key: 'status', label: 'Status', value: (t) => t.status, render: (t) => <StatusBadge status={t.status} /> },
  { key: 'priority', label: 'Priority', value: (t) => t.priority, render: (t) => <PriorityBadge priority={t.priority} /> },
  { key: 'type', label: 'Type', value: (t) => t.type },
  { key: 'reporterName', label: 'Reporter', value: (t) => t.reporterName ?? '' },
  { key: 'reporterEmail', label: 'Reporter email', value: (t) => t.reporterEmail ?? '' },
  { key: 'assigneeName', label: 'Assignee', value: (t) => t.assigneeName ?? 'Unassigned' },
  { key: 'createdAt', label: 'Created', value: (t) => new Date(t.createdAt), render: (t) => timeAgo(t.createdAt) },
  { key: 'updatedAt', label: 'Updated', value: (t) => new Date(t.updatedAt), render: (t) => timeAgo(t.updatedAt) },
  { key: 'dueDate', label: 'Due', value: (t) => (t.dueDate ? new Date(t.dueDate) : null),
    render: (t) => (t.dueDate ? fmtDate(t.dueDate) : '—') },
  { key: 'slaName', label: 'SLA policy', value: (t) => t.slaName ?? '' },
  { key: 'slaBreached', label: 'SLA breached', value: (t) => breached(t),
    render: (t) => (breached(t)
      ? <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold text-red-700 bg-red-50">Breached</span>
      : <span className="text-slate-400">—</span>) },
  { key: 'openHours', label: 'Time open (h)', numeric: true, value: (t) => openHours(t) },
  { key: 'branch', label: 'Branch', value: (t) => t.branch ?? '' },
  { key: 'onSiteSupportRequired', label: 'On-site', value: (t) => t.onSiteSupportRequired,
    render: (t) => (t.onSiteSupportRequired ? 'Yes' : 'No') },
  { key: 'labels', label: 'Labels', value: (t) => t.labels.join(', ') },
];

// Mirrors REPORT_ROW_CAP in server/src/modules/ticketing/ticketing.client.ts — used
// only to word the truncation notice, so a drift here misstates a number, it does not
// change what the server returns.
const REPORT_ROW_CAP = 5000;

const DEFAULT_FIELDS = ['ticketNumber', 'title', 'customerName', 'status', 'priority', 'assigneeName', 'createdAt'];
const FIELDS_STORAGE_KEY = 'ticket-report-fields';

// localStorage throws in some privacy modes and can hold a stale key list from an
// older build — fall back to the defaults rather than rendering an empty table.
function loadFields(): string[] {
  try {
    const raw = window.localStorage.getItem(FIELDS_STORAGE_KEY);
    if (!raw) return DEFAULT_FIELDS;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_FIELDS;
    const known = parsed.filter((k): k is string => typeof k === 'string' && REPORT_FIELDS.some((f) => f.key === k));
    return known.length ? known : DEFAULT_FIELDS;
  } catch { return DEFAULT_FIELDS; }
}

function ReportsTab() {
  const toast = useToast();
  const { user } = useAuth();
  // The client pool lives behind `ticket.store.admin`; an ORG_ADMIN calling it gets a
  // 403 and lib/api.ts hard-navigates the whole app to /403. So the query is GATED on
  // the role, not merely hidden — and every ticket in an org admin's store is their
  // own organization's anyway, which is why the filter is meaningless for them.
  const isPlatformAdmin = user?.role === 'ADMINISTRATOR';

  const [type, setType] = useState<TicketReportType>('client');
  const [customerId, setCustomerId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [report, setReport] = useState<TicketReport | null>(null);
  const [generating, setGenerating] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fields, setFields] = useState<string[]>(DEFAULT_FIELDS);
  const [draftFields, setDraftFields] = useState<string[]>(DEFAULT_FIELDS);
  // Set while the picker is the FIRST step of Generate, so confirming runs the report;
  // false when it was reopened via "Change fields", which must not refetch.
  const [pickerGenerates, setPickerGenerates] = useState(false);

  // Read once on mount rather than in useState's initialiser: localStorage does not
  // exist during the server render, and touching it there is a hydration mismatch.
  useEffect(() => { const f = loadFields(); setFields(f); setDraftFields(f); }, []);

  const { data: customers } = useQuery<TicketCustomer[]>({
    queryKey: ['ticketing', 'customers'],
    queryFn: () => ticketingApi.listCustomers().then((r) => (r.data as { customers: TicketCustomer[] }).customers),
    enabled: isPlatformAdmin,
    staleTime: 60_000,
  });
  const { data: assignees } = useTicketAssignees();
  // The org-admin pool is prefixed with a synthetic "Escalate to Administrators"
  // entry, which is not a person and would filter to nothing.
  const realAssignees = (assignees ?? []).filter((a) => a.id !== ESCALATE_ADMINS_ID);

  const activeFields = REPORT_FIELDS.filter((f) => fields.includes(f.key));

  function openPickerThenGenerate() {
    setDraftFields(fields);
    setPickerGenerates(true);
    setPickerOpen(true);
  }

  function confirmFields() {
    // Never let the picker produce a table with no columns.
    const chosen = draftFields.length ? draftFields : DEFAULT_FIELDS;
    setFields(chosen);
    try { window.localStorage.setItem(FIELDS_STORAGE_KEY, JSON.stringify(chosen)); } catch { /* private mode */ }
    setPickerOpen(false);
    if (pickerGenerates) void generate();
  }

  async function generate() {
    setGenerating(true);
    try {
      // The client pool is deduplicated by email, so one option stands for several
      // merged Customers rows — send ALL of them, or a report on a merged client
      // would silently drop the other names' tickets.
      const selectedClient = customerId ? (customers ?? []).find((c) => c.id === customerId) : null;
      const { data } = await ticketingApi.getReport({
        type,
        ...(isPlatformAdmin && selectedClient ? { customerId: selectedClient.ids.join(',') } : {}),
        // Only when its picker is actually on screen. The state survives a change of
        // report type, so sending it unconditionally would silently narrow a
        // Client-wise report to one person the user picked on a different tab and can
        // no longer see — a filter with no visible cause.
        ...(type === 'assignee' && assigneeId ? { assigneeId } : {}),
        ...(from ? { from: `${from}T00:00:00` } : {}),
        ...(to ? { to: `${to}T23:59:59` } : {}),
      });
      setReport(data as TicketReport);
    } catch (err) {
      // Called as `void generate()`, so without this catch a failed report was an
      // unhandled rejection: the button reset and nothing ever appeared.
      toast(apiErrorMessage(err, 'Could not generate the report'), 'error');
    } finally { setGenerating(false); }
  }

  async function download() {
    if (!report) return;
    const rows = report.groups.flatMap((g) => g.tickets);
    if (rows.length === 0) { toast('Nothing to export — the report is empty.', 'error'); return; }
    try {
      const label = REPORT_TYPES.find((r) => r.value === report.type)?.label ?? 'report';
      await exportXlsx(
        `${label.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}`,
        // Group is a column in the sheet: a flat file loses the on-screen grouping
        // otherwise, and "which client is this row?" is the report's whole point.
        [
          { header: type === 'assignee' ? 'Assignee group' : 'Group', value: (r: ReportTicketRow & { __group: string }) => r.__group },
          ...activeFields.map((f) => ({ header: f.label, value: (r: ReportTicketRow) => f.value(r) })),
        ],
        report.groups.flatMap((g) => g.tickets.map((t) => ({ ...t, __group: g.label }))),
      );
    } catch (err) {
      toast(apiErrorMessage(err, 'Could not build the spreadsheet.'), 'error');
    }
  }

  const typeLabel = REPORT_TYPES.find((r) => r.value === type)?.label ?? '';

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="card p-5 flex items-end gap-3 flex-wrap">
        <div>
          <label htmlFor="rep-type" className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Report Type</label>
          <select id="rep-type" value={type} onChange={(e) => setType(e.target.value as TicketReportType)} className="input !py-1.5 text-xs w-auto">
            {REPORT_TYPES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        {isPlatformAdmin && (
          <div>
            <label htmlFor="rep-client" className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Select Client</label>
            <select id="rep-client" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="input !py-1.5 text-xs w-auto">
              <option value="">All clients</option>
              {(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        {type === 'assignee' && (
          <div>
            <label htmlFor="rep-assignee" className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Assignee</label>
            <select id="rep-assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className="input !py-1.5 text-xs w-auto">
              <option value="">Everyone</option>
              {realAssignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}

        <div>
          <label htmlFor="rep-from" className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Start Date</label>
          <input id="rep-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="input !py-1.5 text-xs w-auto" />
        </div>
        <div>
          <label htmlFor="rep-to" className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">End Date</label>
          <input id="rep-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="input !py-1.5 text-xs w-auto" />
        </div>

        <GlowButton className="py-1.5 px-4 text-xs inline-flex items-center gap-1.5" onClick={openPickerThenGenerate}
          disabled={generating} loading={generating}>
          {generating ? 'Generating…' : 'Generate Report'}
        </GlowButton>

        {report && (
          <div className="ml-auto flex items-end gap-2">
            <GlowButton variant="ghost" className="py-1.5 px-3 text-xs"
              onClick={() => { setDraftFields(fields); setPickerGenerates(false); setPickerOpen(true); }}>
              Change fields
            </GlowButton>
            <GlowButton variant="secondary" className="py-1.5 px-3 text-xs" onClick={() => void download()}>
              Download .xlsx
            </GlowButton>
          </div>
        )}
      </div>

      {/* Field picker */}
      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title="Select report fields" width="max-w-xl">
        <p className="text-sm text-slate-500 mb-4">
          Choose the columns for the report and its spreadsheet. Your selection is remembered on this device.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 max-h-[45vh] overflow-y-auto pr-1">
          {REPORT_FIELDS.map((f) => {
            const locked = f.key === 'ticketNumber';   // without it a row identifies nothing
            const checked = locked || draftFields.includes(f.key);
            return (
              <label key={f.key} className={`flex items-center gap-2.5 py-1.5 text-sm ${locked ? 'text-slate-400' : 'text-slate-700 cursor-pointer'}`}>
                <input type="checkbox" checked={checked} disabled={locked}
                  onChange={(e) => setDraftFields((prev) => (e.target.checked ? [...prev, f.key] : prev.filter((k) => k !== f.key)))}
                  className="w-4 h-4 rounded border-slate-300 text-brand focus:ring-2 focus:ring-brand/30 disabled:opacity-60" />
                {f.label}{locked && <span className="text-[11px] text-slate-400">(always)</span>}
              </label>
            );
          })}
        </div>
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <button type="button" onClick={() => setDraftFields(DEFAULT_FIELDS)} className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer">
            Reset to defaults
          </button>
          <div className="flex gap-2">
            <GlowButton variant="secondary" className="py-1.5 px-4 text-xs" onClick={() => setPickerOpen(false)}>Cancel</GlowButton>
            <GlowButton className="py-1.5 px-4 text-xs" onClick={confirmFields}>
              {pickerGenerates ? 'Generate Report' : 'Apply'}
            </GlowButton>
          </div>
        </div>
      </Modal>

      {/* Result */}
      {!report ? (
        <EmptyState icon={Icons.filter({ className: 'w-6 h-6' })} title="No report generated yet"
          hint='Configure the filters above and click "Generate Report" to create a report.' />
      ) : (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-baseline justify-between gap-3 flex-wrap">
            <p className="text-sm font-semibold text-slate-900">{typeLabel}</p>
            <span className="text-xs text-slate-400 tabular-nums">
              {report.totals.tickets} tickets · {report.totals.open} open · {report.totals.completed} completed
              {report.totals.breached > 0 && <span className="text-red-600"> · {report.totals.breached} SLA breached</span>}
            </span>
          </div>

          {report.truncated && (
            <p className="px-5 py-2 text-xs text-amber-700 bg-amber-50 border-b border-amber-100">
              This range exceeds the {REPORT_ROW_CAP.toLocaleString()}-ticket limit — only the most recent {REPORT_ROW_CAP.toLocaleString()} are shown. Narrow the dates for a complete report.
            </p>
          )}

          {report.groups.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-slate-500">No tickets match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    {activeFields.map((f) => (
                      <th key={f.key} className={`px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap ${f.numeric ? 'text-right' : 'text-left'}`}>
                        {f.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                {report.groups.map((g) => (
                  <tbody key={g.key} className="border-b border-slate-200 last:border-0">
                    {/* One header row per group — 'overall' has a single group, so this
                        degrades to a plain total line rather than needing its own branch. */}
                    <tr className="bg-slate-50/70">
                      <th colSpan={activeFields.length} className="px-4 py-2 text-left text-xs font-semibold text-slate-700">
                        {g.label}
                        <span className="ml-2 font-normal text-slate-400 tabular-nums">{g.tickets.length} ticket{g.tickets.length === 1 ? '' : 's'}</span>
                      </th>
                    </tr>
                    {g.tickets.map((t) => (
                      <tr key={t.id} className="border-t border-slate-100 hover:bg-slate-50/70">
                        {activeFields.map((f) => (
                          <td key={f.key} className={`px-4 py-2.5 text-slate-600 ${f.numeric ? 'text-right font-mono tabular-nums' : ''}`}>
                            {f.render ? f.render(t) : (String(f.value(t) ?? '') || '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
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
  // Set when a row in the Activity Log is clicked: TicketsTab opens that ticket's
  // detail on mount, the same way the ?ticket= deep link does.
  const [logTicketId, setLogTicketId] = useState<string | null>(null);

  const { data: projects = [] } = useTicketProjects();
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
        {tab === 'tickets' && <TicketsTab projectFilter={projectFilter} onClearProject={() => setProjectFilter(null)} initialTicketId={logTicketId ?? deepLinkTicket} />}
        {tab === 'projects' && <ProjectsTab onViewTickets={(id) => { setProjectFilter(id); setTab('tickets'); }} />}
        {tab === 'slas' && <SlasTab />}
        {tab === 'logs' && <ActivityLogTab onOpenTicket={(id) => { setLogTicketId(id); setTab('tickets'); }} />}
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
              <NewTicketForm projects={projects} role={user.role} onCreated={() => setTab('tickets')} onCancel={() => setTab('tickets')} />
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
