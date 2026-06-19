'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { saasAdminApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import KpiCard from '@/components/ui/KpiCard';
import GlowButton from '@/components/ui/GlowButton';
import { ShimmerCard, ShimmerRow } from '@/components/ui/Shimmer';
import type {
  SlaBreachReport, SlaTicket, ChatAnalytics, Announcement, AnnouncementLevel,
  TicketEscalation, EscalationStatus,
} from '@/lib/schemas';

// ─── Local response types (saas-admin endpoints) ─────────────────────────────
interface PlatformMetrics {
  totalOrgs: number; totalUsers: number; totalAdmins: number;
  openRequests: number; criticalRequests: number;
  mrr: number; arr: number;
  servicesActive: number; servicesExpiring: number; servicesExpired: number;
}
interface OrgOverview {
  id: string; name: string; plan: string; suspended: boolean; industry: string | null;
  healthScore: number; mrr: number;
  servicesActive: number; servicesExpiring: number; servicesExpired: number;
  openRequests: number; criticalRequests: number;
  admin: { id: string; name: string; email: string } | null;
}
interface WatchService {
  id: string; customerId: string; serviceName: string; monthlyPrice: number;
  endDate: string; status: 'ACTIVE' | 'EXPIRING' | 'EXPIRED';
  customer: { id: string; name: string; plan: string };
}
interface AuditEntry {
  id: string; action: string; createdAt: string; targetId: string | null;
  metadata: Record<string, unknown> | null;
  performedBy: { id: string; name: string; email: string; role: string } | null;
  organization: { id: string; name: string; slug: string } | null;
}

// ─── Presentation config ──────────────────────────────────────────────────────
const priorityCls: Record<string, string> = {
  CRITICAL: 'text-red-700 bg-red-50',
  HIGH:     'text-amber-700 bg-amber-50',
  MEDIUM:   'text-cyan-700 bg-cyan-50',
  LOW:      'text-slate-600 bg-slate-100',
};
const levelCfg: Record<AnnouncementLevel, { cls: string; dot: string; label: string }> = {
  INFO:     { cls: 'text-cyan-700 bg-cyan-50',   dot: 'bg-cyan-500',  label: 'Info' },
  WARNING:  { cls: 'text-amber-700 bg-amber-50', dot: 'bg-amber-500', label: 'Warning' },
  CRITICAL: { cls: 'text-red-700 bg-red-50',     dot: 'bg-red-500',   label: 'Critical' },
};
const AUDIT_ACTIONS = [
  { value: '',  label: 'Session & lifecycle (default)' },
  { value: '*', label: 'All actions' },
  { value: 'LOGIN', label: 'Logins' },
  { value: 'LOGOUT', label: 'Logouts' },
  { value: 'CUSTOMER_CREATED', label: 'Org created' },
  { value: 'USER_REGISTERED', label: 'User registered' },
  { value: 'IMPERSONATE', label: 'Impersonations' },
  { value: 'UPDATE_SERVICE_REQUEST', label: 'Ticket updates' },
  { value: 'SERVICE_RENEWED', label: 'Service renewals' },
  { value: 'CUSTOMER_SERVICE_UPDATED', label: 'Service updates' },
  { value: 'ANNOUNCEMENT_CREATED', label: 'Announcement created' },
  { value: 'ANNOUNCEMENT_DELETED', label: 'Announcement deleted' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function humanizeMs(ms: number): string {
  const abs = Math.abs(ms);
  const mins = Math.floor(abs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000);
}

function SectionHeader({ title, hint, right }: { title: string; hint?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
      <div>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {hint && <p className="text-xs text-slate-500 mt-0.5">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

// ─── SLA breach row ───────────────────────────────────────────────────────────
function SlaRow({ t, breached }: { t: SlaTicket; breached: boolean }) {
  return (
    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
      <td className="px-5 py-3">
        <span className={`inline-flex px-2 py-0.5 rounded-md text-[11px] font-semibold ${priorityCls[t.priority]}`}>{t.priority}</span>
      </td>
      <td className="px-5 py-3">
        <Link href={`/saas-admin/orgs/${t.customer.id}`} className="text-sm font-medium text-slate-900 hover:text-brand transition-colors">
          {t.customer.name}
        </Link>
      </td>
      <td className="px-5 py-3">
        <p className="text-sm text-slate-700 leading-tight truncate max-w-xs">{t.subject}</p>
        <p className="text-[11px] text-slate-400 mt-0.5">
          {t.createdBy ? `by ${t.createdBy.name}` : 'Unattributed'} · raised {timeAgo(t.createdAt)}
        </p>
      </td>
      <td className="px-5 py-3 text-xs font-mono tabular-nums text-slate-500">{t.slaHours}h SLA</td>
      <td className="px-5 py-3">
        {breached ? (
          <span className="text-xs font-mono tabular-nums font-bold text-red-600">+{humanizeMs(t.overdueMs)} over</span>
        ) : (
          <span className="text-xs font-mono tabular-nums font-semibold text-amber-600">{humanizeMs(t.overdueMs)} left</span>
        )}
      </td>
      <td className="px-5 py-3">
        <span className="text-xs text-slate-500">{t.assignedTo ?? <span className="text-red-500 font-semibold">Unassigned</span>}</span>
      </td>
    </tr>
  );
}

// ─── Escalated tickets (forwarded by org admins), grouped by organization ────
const escStatusCfg: Record<EscalationStatus, { cls: string; label: string }> = {
  OPEN:         { cls: 'text-rose-700 bg-rose-50',       label: 'Open' },
  ACKNOWLEDGED: { cls: 'text-cyan-700 bg-cyan-50',       label: 'Acknowledged' },
  RESOLVED:     { cls: 'text-emerald-700 bg-emerald-50', label: 'Resolved' },
};

function EscalationsSection() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<EscalationStatus | 'ALL'>('OPEN');

  const { data, isLoading } = useQuery<{ escalations: TicketEscalation[]; total: number }>({
    queryKey: ['admin-escalations', filter],
    queryFn: () => saasAdminApi.listEscalations(filter === 'ALL' ? {} : { status: filter })
      .then((r) => r.data as { escalations: TicketEscalation[]; total: number }),
    staleTime: 10_000,
  });

  const updateMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: EscalationStatus }) => saasAdminApi.updateEscalation(id, { status }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-escalations'] }); },
  });

  const escalations = data?.escalations;

  // Categorized by organization, most recent escalation first within each group.
  const byOrg = useMemo(() => {
    const groups = new Map<string, { name: string; items: TicketEscalation[] }>();
    for (const e of escalations ?? []) {
      const key = e.customer?.id ?? 'unknown';
      const g = groups.get(key) ?? { name: e.customer?.name ?? 'Unknown organization', items: [] };
      g.items.push(e);
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) =>
      (b.items[0]?.createdAt ?? '').localeCompare(a.items[0]?.createdAt ?? ''));
  }, [escalations]);

  return (
    <div>
      <SectionHeader
        title="Escalated Tickets"
        hint="Forwarded to the platform by org admins — categorized by organization"
        right={
          <div className="flex items-center gap-1">
            {(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ALL'] as const).map((s) => (
              <button key={s} type="button" onClick={() => setFilter(s)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors cursor-pointer
                  ${filter === s ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>
                {s === 'ALL' ? 'All' : escStatusCfg[s].label}
              </button>
            ))}
          </div>
        }
      />

      {isLoading ? (
        <ShimmerCard />
      ) : escalations.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">
          {filter === 'OPEN' ? 'No open escalations — nothing needs your attention.' : 'No escalations match this filter.'}
        </div>
      ) : (
        <div className="space-y-4">
          {byOrg.map((group) => (
            <div key={group.name} className="card overflow-hidden">
              <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-200 flex items-baseline justify-between">
                <p className="text-sm font-semibold text-slate-900">{group.name}</p>
                <span className="text-[11px] text-slate-400 tabular-nums">{group.items.length} escalation{group.items.length === 1 ? '' : 's'}</span>
              </div>
              <div className="divide-y divide-slate-100">
                {group.items.map((e) => (
                  <div key={e.id} className="px-5 py-3.5 flex items-start gap-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-md text-[11px] font-semibold flex-shrink-0 mt-0.5 ${priorityCls[e.priority]}`}>
                      {e.priority}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-900">{e.subject}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        {e.issueType} · escalated by {e.escalatedBy?.name ?? 'Unknown'} · {timeAgo(e.createdAt)}
                        <span className="font-mono ml-1.5 text-slate-300">{e.ticketId.toUpperCase()}</span>
                      </p>
                      {e.note && (
                        <p className="text-xs text-slate-600 mt-1.5 italic border-l-2 border-slate-200 pl-2">&quot;{e.note}&quot;</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`inline-flex px-2 py-0.5 rounded-md text-[11px] font-semibold ${escStatusCfg[e.status].cls}`}>
                        {escStatusCfg[e.status].label}
                      </span>
                      {e.status === 'OPEN' && (
                        <GlowButton variant="secondary" className="py-1 px-2.5 text-xs"
                          onClick={() => updateMut.mutate({ id: e.id, status: 'ACKNOWLEDGED' })} disabled={updateMut.isPending}>
                          Acknowledge
                        </GlowButton>
                      )}
                      {e.status !== 'RESOLVED' && (
                        <GlowButton variant="ghost" className="py-1 px-2.5 text-xs"
                          onClick={() => updateMut.mutate({ id: e.id, status: 'RESOLVED' })} disabled={updateMut.isPending}>
                          Resolve
                        </GlowButton>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Announcements manager ────────────────────────────────────────────────────
function AnnouncementsManager({ orgs }: { orgs: OrgOverview[] }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [level, setLevel] = useState<AnnouncementLevel>('INFO');
  const [target, setTarget] = useState('');     // '' = all orgs
  const [expiresAt, setExpiresAt] = useState('');

  const { data, isLoading } = useQuery<{ announcements: Announcement[] }>({
    queryKey: ['admin-announcements'],
    queryFn: () => saasAdminApi.listAnnouncements().then((r) => r.data as { announcements: Announcement[] }),
    staleTime: 15_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-announcements'] });
  const createMut = useMutation({
    mutationFn: (payload: unknown) => saasAdminApi.createAnnouncement(payload),
    onSuccess: () => { setTitle(''); setMessage(''); setLevel('INFO'); setTarget(''); setExpiresAt(''); void invalidate(); },
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => saasAdminApi.updateAnnouncement(id, { active }),
    onSuccess: invalidate,
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => saasAdminApi.deleteAnnouncement(id),
    onSuccess: invalidate,
  });

  const announcements = data?.announcements ?? [];
  const isValid = title.trim().length >= 3 && message.trim().length >= 3;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
      {/* Compose */}
      <div className="card p-5 space-y-4">
        <p className="text-sm font-semibold text-slate-900">Broadcast an announcement</p>
        <div>
          <label htmlFor="ann-title" className="block text-sm font-medium text-slate-700 mb-1.5">Title</label>
          <input id="ann-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className="input" placeholder="Scheduled maintenance window" />
        </div>
        <div>
          <label htmlFor="ann-msg" className="block text-sm font-medium text-slate-700 mb-1.5">Message</label>
          <textarea id="ann-msg" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} rows={3} className="input resize-none"
            placeholder="The SIEM ingestion pipeline will be upgraded on Saturday 02:00–04:00 UTC…" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <span className="block text-sm font-medium text-slate-700 mb-1.5">Severity</span>
            <div className="flex gap-2">
              {(Object.keys(levelCfg) as AnnouncementLevel[]).map((l) => (
                <button key={l} type="button" onClick={() => setLevel(l)} aria-pressed={level === l}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${levelCfg[l].cls} ${level === l ? 'ring-2 ring-offset-1 ring-slate-300' : 'opacity-70 hover:opacity-100'}`}>
                  {levelCfg[l].label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="ann-target" className="block text-sm font-medium text-slate-700 mb-1.5">Audience</label>
            <select id="ann-target" value={target} onChange={(e) => setTarget(e.target.value)} className="input">
              <option value="">All organizations</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="ann-exp" className="block text-sm font-medium text-slate-700 mb-1.5">Expires <span className="text-slate-400 font-normal">(optional)</span></label>
          <input id="ann-exp" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="input" />
        </div>
        <GlowButton
          onClick={() => createMut.mutate({
            title: title.trim(), message: message.trim(), level,
            customerId: target || null,
            expiresAt: expiresAt ? `${expiresAt}T23:59:59` : null,
          })}
          disabled={!isValid || createMut.isPending} loading={createMut.isPending}>
          {createMut.isPending ? 'Publishing…' : 'Publish Announcement'}
        </GlowButton>
        {createMut.isError && <p className="text-xs text-red-600">Could not publish. Check the fields and try again.</p>}
      </div>

      {/* Existing */}
      <div className="space-y-2.5">
        {isLoading ? (
          <ShimmerCard />
        ) : announcements.length === 0 ? (
          <div className="card p-8 text-center text-sm text-slate-500">No announcements yet. Publish one to notify client organizations.</div>
        ) : (
          announcements.map((a) => {
            const cfg = levelCfg[a.level];
            const expired = a.expiresAt ? new Date(a.expiresAt).getTime() < Date.now() : false;
            return (
              <div key={a.id} className={`card p-4 ${!a.active || expired ? 'opacity-60' : ''}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold ${cfg.cls}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />{cfg.label}
                      </span>
                      <p className="text-sm font-semibold text-slate-900 truncate">{a.title}</p>
                    </div>
                    <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">{a.message}</p>
                    <p className="text-[11px] text-slate-400 mt-2">
                      {a.customer ? `→ ${a.customer.name}` : '→ All organizations'} · {timeAgo(a.createdAt)}
                      {a.expiresAt && ` · ${expired ? 'expired' : 'expires'} ${fmtDate(a.expiresAt)}`}
                      {!a.active && ' · INACTIVE'}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5 flex-shrink-0">
                    <button type="button"
                      onClick={() => toggleMut.mutate({ id: a.id, active: !a.active })}
                      disabled={toggleMut.isPending}
                      className="text-xs font-semibold text-slate-500 hover:text-brand transition-colors cursor-pointer disabled:opacity-50">
                      {a.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button type="button"
                      onClick={() => { if (confirm(`Delete "${a.title}"?`)) deleteMut.mutate(a.id); }}
                      disabled={deleteMut.isPending}
                      className="text-xs font-medium text-slate-400 hover:text-red-600 transition-colors cursor-pointer disabled:opacity-50">
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Audit log search + CSV export ───────────────────────────────────────────
function AuditLogSection({ orgs }: { orgs: OrgOverview[] }) {
  const [action, setAction] = useState('');
  const [orgId, setOrgId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const params = useMemo(() => ({
    limit: 100,
    ...(action ? { action } : {}),
    ...(orgId ? { orgId } : {}),
    ...(from ? { from: `${from}T00:00:00` } : {}),
    ...(to ? { to: `${to}T23:59:59` } : {}),
  }), [action, orgId, from, to]);

  const { data, isLoading } = useQuery<{ items: AuditEntry[]; total: number }>({
    queryKey: ['admin-audit', params],
    queryFn: () => saasAdminApi.getSystemActivity(params).then((r) => r.data as { items: AuditEntry[]; total: number }),
    staleTime: 15_000,
  });

  const items = data?.items ?? [];

  function exportCsv() {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [
      ['Time', 'Action', 'Performed By', 'Email', 'Role', 'Organization', 'Target ID', 'Metadata'],
      ...items.map((l) => [
        new Date(l.createdAt).toISOString(), l.action,
        l.performedBy?.name ?? '', l.performedBy?.email ?? '', l.performedBy?.role ?? '',
        l.organization?.name ?? '', l.targetId ?? '',
        l.metadata ? JSON.stringify(l.metadata) : '',
      ]),
    ];
    const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="card overflow-hidden">
      {/* Filters */}
      <div className="px-4 py-3 border-b border-slate-100 flex items-end gap-3 flex-wrap">
        <div>
          <label htmlFor="audit-action" className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Action</label>
          <select id="audit-action" value={action} onChange={(e) => setAction(e.target.value)} className="input !py-1.5 text-xs w-auto">
            {AUDIT_ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="audit-org" className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Organization</label>
          <select id="audit-org" value={orgId} onChange={(e) => setOrgId(e.target.value)} className="input !py-1.5 text-xs w-auto">
            <option value="">All</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="audit-from" className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">From</label>
          <input id="audit-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input !py-1.5 text-xs w-auto" />
        </div>
        <div>
          <label htmlFor="audit-to" className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">To</label>
          <input id="audit-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input !py-1.5 text-xs w-auto" />
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-slate-400 tabular-nums">{data?.total ?? 0} entries</span>
          <GlowButton variant="secondary" className="py-1.5 px-3 text-xs" onClick={exportCsv} disabled={items.length === 0}>
            Export CSV ↓
          </GlowButton>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
        <table className="min-w-full">
          <thead className="sticky top-0 bg-slate-50">
            <tr className="border-b border-slate-200">
              <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Time</th>
              <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Action</th>
              <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Performed By</th>
              <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Organization</th>
              <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Detail</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => <tr key={i}><td colSpan={5}><ShimmerRow /></td></tr>)
            ) : items.length === 0 ? (
              <tr><td colSpan={5} className="px-5 py-10 text-center text-sm text-slate-500">No audit entries match these filters.</td></tr>
            ) : (
              items.map((l) => (
                <tr key={l.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
                  <td className="px-5 py-2.5 whitespace-nowrap">
                    <p className="text-xs font-mono tabular-nums text-slate-600">{new Date(l.createdAt).toLocaleString()}</p>
                  </td>
                  <td className="px-5 py-2.5">
                    <span className="inline-flex px-2 py-0.5 rounded-md text-[11px] font-semibold text-slate-600 bg-slate-100">{l.action}</span>
                  </td>
                  <td className="px-5 py-2.5">
                    {l.performedBy ? (
                      <div>
                        <p className="text-xs font-medium text-slate-900">{l.performedBy.name}</p>
                        <p className="text-[11px] text-slate-400">{l.performedBy.email}</p>
                      </div>
                    ) : <span className="text-xs text-slate-400">—</span>}
                  </td>
                  <td className="px-5 py-2.5 text-xs text-slate-600">{l.organization?.name ?? '—'}</td>
                  <td className="px-5 py-2.5">
                    <p className="text-[11px] font-mono text-slate-400 truncate max-w-[260px]">
                      {l.metadata ? JSON.stringify(l.metadata) : '—'}
                    </p>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function AdminPlatformDashboard() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [showApproaching, setShowApproaching] = useState(false);

  const { data: metrics, isLoading: metricsLoading } = useQuery<PlatformMetrics>({
    queryKey: ['admin-metrics'],
    queryFn: () => saasAdminApi.getMetrics().then((r) => r.data as PlatformMetrics),
    staleTime: 30_000,
  });
  const { data: sla, isLoading: slaLoading } = useQuery<SlaBreachReport>({
    queryKey: ['admin-sla'],
    queryFn: () => saasAdminApi.getSlaBreaches().then((r) => r.data as SlaBreachReport),
    staleTime: 30_000,
  });
  const { data: orgsData } = useQuery<{ orgs: OrgOverview[] }>({
    queryKey: ['admin-orgs-overview'],
    queryFn: () => saasAdminApi.getOrgsOverview().then((r) => r.data as { orgs: OrgOverview[] }),
    staleTime: 30_000,
  });
  const { data: expiringData, isLoading: expiringLoading } = useQuery<{ services: WatchService[]; total: number }>({
    queryKey: ['admin-expiring-services'],
    queryFn: () => saasAdminApi.listServices({ status: 'EXPIRING', limit: 6 }).then((r) => r.data as { services: WatchService[]; total: number }),
    staleTime: 30_000,
  });
  const { data: chat, isLoading: chatLoading } = useQuery<ChatAnalytics>({
    queryKey: ['admin-chat-analytics'],
    queryFn: () => saasAdminApi.getChatAnalytics().then((r) => r.data as ChatAnalytics),
    staleTime: 60_000,
  });

  const renewMut = useMutation({
    mutationFn: (id: string) => saasAdminApi.renewService(id, { months: 12 }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-expiring-services'] });
      void qc.invalidateQueries({ queryKey: ['admin-metrics'] });
    },
  });

  const orgs = orgsData?.orgs;

  // At-risk scoring: low health, critical tickets, expired/expiring services.
  const atRisk = useMemo(() => (orgs ?? [])
    .map((o) => {
      const reasons: string[] = [];
      if (o.healthScore < 80) reasons.push(`Health ${o.healthScore}`);
      if (o.criticalRequests > 0) reasons.push(`${o.criticalRequests} critical ticket${o.criticalRequests > 1 ? 's' : ''}`);
      if (o.servicesExpired > 0) reasons.push(`${o.servicesExpired} expired service${o.servicesExpired > 1 ? 's' : ''}`);
      if (o.servicesExpiring > 0) reasons.push(`${o.servicesExpiring} expiring soon`);
      const score = (100 - o.healthScore) + o.criticalRequests * 15 + o.servicesExpired * 10 + o.servicesExpiring * 3;
      return { ...o, reasons, score };
    })
    .filter((o) => !o.suspended && o.reasons.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6), [orgs]);

  const maxDaily = Math.max(1, ...(chat?.daily.map((d) => d.messages) ?? [1]));
  const breaches = sla?.breached ?? [];
  const approaching = sla?.approaching ?? [];

  return (
    <RoleGuard allowedRoles={['ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[1400px] mx-auto space-y-8">

            {/* Header */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.22 }} className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse-soft" />
                  <p className="text-sm font-semibold text-rose-600">Administrator · Platform Monitoring</p>
                </div>
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Welcome back, {user?.name?.split(' ')[0]}</h1>
                <p className="mt-1 text-sm text-slate-500">SLA health, account risk, service expiry, and platform activity across every client organization</p>
              </div>
              <Link href="/saas-admin">
                <GlowButton variant="secondary">Open Control Plane →</GlowButton>
              </Link>
            </motion.div>

            {/* KPI strip */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.03 }}>
              {metricsLoading ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{Array.from({ length: 4 }).map((_, i) => <ShimmerCard key={i} />)}</div>
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <KpiCard title="Client Orgs"   value={metrics?.totalOrgs ?? 0} tone="brand" />
                  <KpiCard title="SLA Breaches"  value={breaches.length} tone="rose"
                    subtitle={approaching.length ? `${approaching.length} approaching` : 'all within SLA'} />
                  <KpiCard title="Monthly Revenue" value={`₹${(metrics?.mrr ?? 0).toLocaleString()}`} tone="emerald" />
                  <KpiCard title="Open Tickets"  value={metrics?.openRequests ?? 0} tone="amber"
                    subtitle={metrics?.criticalRequests ? `${metrics.criticalRequests} critical` : undefined} />
                </div>
              )}
            </motion.div>

            {/* SLA breach monitor */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.06 }}>
              <SectionHeader
                title="SLA Breach Monitor"
                hint="Open tickets past their response SLA — Critical 1h · High 4h · Medium 1d · Low 3d"
                right={approaching.length > 0 ? (
                  <button type="button" onClick={() => setShowApproaching((v) => !v)}
                    className="text-xs font-semibold text-amber-600 hover:text-amber-700 transition-colors cursor-pointer">
                    {showApproaching ? 'Hide' : 'Show'} {approaching.length} approaching ▾
                  </button>
                ) : undefined}
              />
              <div className="card overflow-hidden">
                {slaLoading ? (
                  <div className="p-4 space-y-2">{Array.from({ length: 3 }).map((_, i) => <ShimmerRow key={i} />)}</div>
                ) : breaches.length === 0 && (!showApproaching || approaching.length === 0) ? (
                  <div className="p-10 text-center">
                    <p className="text-sm font-semibold text-emerald-600">✓ No SLA breaches</p>
                    <p className="text-xs text-slate-400 mt-1">{sla?.totalOpen ?? 0} open tickets, all inside their response window.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Priority</th>
                          <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Client</th>
                          <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Ticket</th>
                          <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">SLA</th>
                          <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Overdue</th>
                          <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Assignee</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breaches.map((t) => <SlaRow key={t.id} t={t} breached />)}
                        {showApproaching && approaching.map((t) => <SlaRow key={t.id} t={t} breached={false} />)}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </motion.div>

            {/* Escalated tickets (forwarded by org admins) */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.08 }}>
              <EscalationsSection />
            </motion.div>

            {/* Watchtower + At-risk orgs */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.09 }}>
                <SectionHeader
                  title="Service Expiry Watchtower"
                  hint={`${metrics?.servicesExpiring ?? 0} expiring in 30 days · ${metrics?.servicesExpired ?? 0} already expired`}
                  right={<Link href="/saas-admin/services" className="text-xs font-semibold text-brand hover:text-brand-700 transition-colors">All services →</Link>}
                />
                <div className="card divide-y divide-slate-100">
                  {expiringLoading ? (
                    <div className="p-4"><ShimmerRow /></div>
                  ) : (expiringData?.services ?? []).length === 0 ? (
                    <p className="p-8 text-center text-sm text-slate-500">Nothing expires in the next 30 days.</p>
                  ) : (
                    (expiringData?.services ?? []).map((s) => {
                      const days = daysUntil(s.endDate);
                      return (
                        <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-slate-900 truncate">{s.serviceName}</p>
                            <p className="text-xs text-slate-400 mt-0.5">{s.customer.name} · ₹{s.monthlyPrice.toLocaleString()}/mo</p>
                          </div>
                          <span className={`text-xs font-mono tabular-nums font-bold flex-shrink-0 ${days <= 7 ? 'text-red-600' : 'text-amber-600'}`}>
                            {days <= 0 ? 'today' : `${days}d left`}
                          </span>
                          <GlowButton variant="secondary" className="py-1 px-2.5 text-xs flex-shrink-0"
                            onClick={() => renewMut.mutate(s.id)} disabled={renewMut.isPending}>
                            Renew +12mo
                          </GlowButton>
                        </div>
                      );
                    })
                  )}
                </div>
              </motion.div>

              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.12 }}>
                <SectionHeader title="At-Risk Accounts" hint="Low health, critical tickets, or lapsing services — for CSM follow-up" />
                <div className="space-y-2.5">
                  {atRisk.length === 0 ? (
                    <div className="card p-8 text-center text-sm text-slate-500">No accounts flagged. All organizations look healthy.</div>
                  ) : (
                    atRisk.map((o) => (
                      <Link key={o.id} href={`/saas-admin/orgs/${o.id}`} className="card p-4 flex items-center gap-4 hover:shadow-card-hover hover:border-slate-300 transition-all group block">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-slate-900 group-hover:text-brand transition-colors truncate">{o.name}</p>
                          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                            {o.reasons.map((r) => (
                              <span key={r} className="text-[10px] font-semibold text-red-700 bg-red-50 px-1.5 py-0.5 rounded">{r}</span>
                            ))}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="font-mono text-lg font-bold tabular-nums text-slate-900 leading-none">{o.healthScore}</p>
                          <p className="text-[10px] text-slate-400 mt-1">health</p>
                        </div>
                      </Link>
                    ))
                  )}
                </div>
              </motion.div>
            </div>

            {/* Chat analytics */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.15 }}>
              <SectionHeader title="Assistant Analytics" hint="AI assistant adoption across client organizations" />
              {chatLoading ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{Array.from({ length: 3 }).map((_, i) => <ShimmerCard key={i} />)}</div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
                  <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="card p-4 text-center">
                        <p className="font-mono text-xl font-bold tabular-nums text-slate-900">{chat?.totalSessions ?? 0}</p>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mt-1">Sessions</p>
                      </div>
                      <div className="card p-4 text-center">
                        <p className="font-mono text-xl font-bold tabular-nums text-slate-900">{chat?.totalMessages ?? 0}</p>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mt-1">Messages</p>
                      </div>
                      <div className="card p-4 text-center">
                        <p className="font-mono text-xl font-bold tabular-nums text-slate-900">{chat?.activeChatUsers ?? 0}</p>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mt-1">Users</p>
                      </div>
                    </div>
                    {/* 14-day volume */}
                    <div className="card p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-3">Messages · last 14 days</p>
                      <div className="flex items-end gap-1 h-20">
                        {(chat?.daily ?? []).map((d) => (
                          <div key={d.date} className="flex-1 flex flex-col items-center gap-1" title={`${d.date}: ${d.messages}`}>
                            <div className="w-full rounded-t bg-brand/70 hover:bg-brand transition-colors min-h-[2px]"
                              style={{ height: `${Math.max(3, (d.messages / maxDaily) * 100)}%` }} />
                          </div>
                        ))}
                      </div>
                      <div className="flex justify-between mt-1.5">
                        <span className="text-[10px] text-slate-400">{chat?.daily[0]?.date.slice(5)}</span>
                        <span className="text-[10px] text-slate-400">today</span>
                      </div>
                    </div>
                  </div>
                  <div className="lg:col-span-2 card overflow-hidden">
                    <table className="min-w-full">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Organization</th>
                          <th className="px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Conversations</th>
                          <th className="px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Messages</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(chat?.perOrg ?? []).length === 0 ? (
                          <tr><td colSpan={3} className="px-5 py-10 text-center text-sm text-slate-500">No assistant usage recorded yet.</td></tr>
                        ) : (
                          (chat?.perOrg ?? []).map((o) => (
                            <tr key={o.customerId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
                              <td className="px-5 py-3 text-sm font-medium text-slate-900">{o.name}</td>
                              <td className="px-5 py-3 text-right font-mono tabular-nums text-sm text-slate-600">{o.sessions}</td>
                              <td className="px-5 py-3 text-right font-mono tabular-nums text-sm text-slate-600">{o.messages}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </motion.div>

            {/* Announcements */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.18 }}>
              <SectionHeader title="Platform Announcements" hint="Broadcast maintenance windows and incident notices to client dashboards" />
              <AnnouncementsManager orgs={orgs} />
            </motion.div>

            {/* Audit log */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.21 }}>
              <SectionHeader title="Audit Log" hint="Search the platform audit trail and export filtered results" />
              <AuditLogSection orgs={orgs} />
            </motion.div>

          </div>
        </main>
      </div>
    </RoleGuard>
  );
}
