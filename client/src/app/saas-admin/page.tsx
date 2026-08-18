'use client';

import { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { saasAdminApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import KpiCard from '@/components/ui/KpiCard';
import Toggle from '@/components/ui/Toggle';
import GlowButton from '@/components/ui/GlowButton';
import { ShimmerCard, ShimmerRow } from '@/components/ui/Shimmer';
import { useConfirm } from '@/components/ui/ConfirmDialog';

// ─── Types ───────────────────────────────────────────────────────────────────
interface PlatformMetrics {
  totalOrgs: number; totalUsers: number; totalAdmins: number;
  openRequests: number; criticalRequests: number;
  planBreakdown: Record<string, number>;
  mrr: number; arr: number;
  servicesActive: number; servicesExpiring: number; servicesExpired: number;
}
interface OrgOverview {
  id: string; name: string; slug: string; plan: string; suspended: boolean;
  industry: string | null; contractValue: number; healthScore: number; csm: string | null;
  ssoEnabled: boolean; mfaRequired: boolean; createdAt: string;
  _count: { users: number; requests: number; services: number };
  admin: { id: string; name: string; email: string; mfaEnabled: boolean; lastLoginAt: string | null } | null;
  mrr: number;
  servicesActive: number; servicesExpiring: number; servicesExpired: number; servicesSuspended: number;
  openRequests: number; criticalRequests: number;
}
interface ServiceRequest {
  id: string; type: string; status: string; priority: string; subject: string;
  description?: string | null; internalNotes?: string | null;
  service: string | null; assignedTo: string | null; createdAt: string; resolvedAt: string | null;
  customer: { id: string; name: string; industry: string | null; plan: string };
  createdBy?: { id: string; name: string; email: string } | null;
}
interface FeatureFlag { id: string; key: string; value: boolean; description?: string; }

// ─── Config maps ─────────────────────────────────────────────────────────────
const priorityConfig: Record<string, { cls: string; dot: string; label: string }> = {
  CRITICAL: { cls: 'text-red-700 bg-red-50',         dot: 'bg-red-500',    label: 'Critical' },
  HIGH:     { cls: 'text-amber-700 bg-amber-50',     dot: 'bg-amber-500',  label: 'High' },
  MEDIUM:   { cls: 'text-cyan-700 bg-cyan-50',       dot: 'bg-cyan-500',   label: 'Medium' },
  LOW:      { cls: 'text-slate-600 bg-slate-100',    dot: 'bg-slate-400',  label: 'Low' },
};
const statusConfig: Record<string, { cls: string; label: string }> = {
  OPEN:        { cls: 'text-brand-700 bg-brand-50',     label: 'Open' },
  IN_PROGRESS: { cls: 'text-amber-700 bg-amber-50',     label: 'In Progress' },
  ESCALATED:   { cls: 'text-red-700 bg-red-50',         label: 'Escalated' },
  RESOLVED:    { cls: 'text-emerald-700 bg-emerald-50', label: 'Resolved' },
  CLOSED:      { cls: 'text-slate-500 bg-slate-100',    label: 'Closed' },
};
const planConfig: Record<string, string> = {
  FREE:       'text-slate-600 bg-slate-100',
  PRO:        'text-cyan-700 bg-cyan-50',
  ENTERPRISE: 'text-violet-700 bg-violet-50',
};
const typeConfig: Record<string, string> = {
  SUPPORT: 'Support', INCIDENT: 'Incident', FEATURE_REQUEST: 'Feature', ONBOARDING: 'Onboarding', BILLING: 'Billing',
};

// ─── Ticket numbering (ADMINISTRATOR-only platform setting) ──────────────────
interface TicketNumberFormat { prefix: string; includeOrgCode: boolean; separator: string; padWidth: number; }
const SEPARATORS: { value: string; label: string }[] = [
  { value: '-', label: 'Dash  -' }, { value: '_', label: 'Underscore  _' },
  { value: '/', label: 'Slash  /' }, { value: '.', label: 'Dot  .' }, { value: '', label: 'None' },
];

function TicketNumberingCard() {
  const qc = useQueryClient();
  const { data } = useQuery<TicketNumberFormat>({
    queryKey: ['saas-admin', 'ticket-number-format'],
    queryFn: () => saasAdminApi.getTicketNumberFormat().then((r) => r.data as TicketNumberFormat),
  });

  const [prefix, setPrefix] = useState('TKT');
  const [includeOrgCode, setIncludeOrgCode] = useState(false);
  const [separator, setSeparator] = useState('-');
  const [padWidth, setPadWidth] = useState(3);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) { setPrefix(data.prefix); setIncludeOrgCode(data.includeOrgCode); setSeparator(data.separator); setPadWidth(data.padWidth); }
  }, [data]);

  const mut = useMutation({
    mutationFn: (payload: TicketNumberFormat) => saasAdminApi.updateTicketNumberFormat(payload),
    onSuccess: () => { setError(''); setSaved(true); void qc.invalidateQueries({ queryKey: ['saas-admin', 'ticket-number-format'] }); setTimeout(() => setSaved(false), 2500); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to save'),
  });

  const cleanPrefix = (prefix || 'TKT').toUpperCase();
  const seq = '1'.padStart(Math.min(Math.max(padWidth, 1), 8), '0');
  const preview = `${cleanPrefix}${separator}${includeOrgCode ? `DVB${separator}` : ''}${seq}`;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.19 }}>
      <h2 className="text-base font-semibold text-slate-900 mb-4">Ticket Numbering</h2>
      <div className="card p-5 space-y-4">
        <p className="text-xs text-slate-500">Controls how new ticket IDs are generated across the platform. Existing ticket numbers are unchanged.</p>

        <div className="flex items-center justify-between rounded-lg bg-slate-50 ring-1 ring-slate-200/70 px-4 py-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Preview</span>
          <span className="font-mono text-lg font-bold text-slate-900 tabular-nums">{preview}</span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">Prefix</label>
            <input value={prefix} maxLength={8} onChange={(e) => setPrefix(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())} className="input !py-1.5 text-sm" placeholder="TKT" />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">Separator</label>
            <select value={separator} onChange={(e) => setSeparator(e.target.value)} className="input !py-1.5 text-sm">
              {SEPARATORS.map((s) => <option key={s.value || 'none'} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">Number padding</label>
            <select value={padWidth} onChange={(e) => setPadWidth(Number(e.target.value))} className="input !py-1.5 text-sm">
              {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} digits ({'1'.padStart(n, '0')})</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <label className="inline-flex items-center gap-2.5 cursor-pointer select-none pb-1.5">
              <input type="checkbox" checked={includeOrgCode} onChange={(e) => setIncludeOrgCode(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-brand focus:ring-2 focus:ring-brand/40 cursor-pointer" />
              <span className="text-sm text-slate-700">Include org code</span>
            </label>
          </div>
        </div>

        {includeOrgCode && <p className="text-[11px] text-slate-400">Each organization counts from 1 (e.g. TKT-DVB-001). Set each org&apos;s code on its detail page.</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex items-center gap-3 pt-1">
          <GlowButton onClick={() => mut.mutate({ prefix: cleanPrefix, includeOrgCode, separator, padWidth })} disabled={mut.isPending} loading={mut.isPending}>
            Save Format
          </GlowButton>
          <AnimatePresence>
            {saved && (
              <motion.span initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                Saved
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Helpers / atoms ─────────────────────────────────────────────────────────
function Badge({ text, cls }: { text: string; cls: string }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold ${cls}`}>{text}</span>;
}
function HealthBar({ score }: { score: number }) {
  const color = score >= 90 ? 'bg-emerald-500' : score >= 75 ? 'bg-amber-500' : 'bg-red-500';
  const text  = score >= 90 ? 'text-emerald-700' : score >= 75 ? 'text-amber-700' : 'text-red-700';
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${score}%` }} />
      </div>
      <span className={`text-xs font-mono font-semibold tabular-nums ${text}`}>{score}</span>
    </div>
  );
}
function PriorityBadge({ priority }: { priority: string }) {
  const cfg = priorityConfig[priority] ?? priorityConfig['LOW']!;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold ${cfg.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}
function RequestAge({ createdAt }: { createdAt: string }) {
  const ms = Date.now() - new Date(createdAt).getTime();
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days >= 1) return <span className="font-mono tabular-nums text-slate-500 text-xs">{days}d</span>;
  return <span className="font-mono tabular-nums text-amber-600 text-xs font-semibold">{hours}h</span>;
}
function ImpersonateForm({ onImpersonate, loading }: { onImpersonate: (userId: string) => void; loading: boolean }) {
  const [userId, setUserId] = useState('');
  return (
    <div className="flex gap-3 items-end">
      <div className="flex-1">
        <label className="block text-sm font-medium text-slate-700 mb-1.5">User ID (cuid)</label>
        <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="cm…" className="input font-mono text-xs" />
      </div>
      <GlowButton variant="danger" onClick={() => { if (userId.trim()) onImpersonate(userId.trim()); }}
        disabled={!userId.trim() || loading} loading={loading}>
        Impersonate
      </GlowButton>
    </div>
  );
}

// ─── Org table row (the heart of the page) ──────────────────────────────────
function OrgRow({ org, onSuspendToggle, suspendPending, onImpersonate, impersonatePending }: {
  org: OrgOverview;
  onSuspendToggle: () => void;
  suspendPending: boolean;
  onImpersonate: () => void;
  impersonatePending: boolean;
}) {
  return (
    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
      {/* Organization */}
      <td className="px-5 py-3.5">
        <Link href={`/saas-admin/orgs/${org.id}`} className="block group">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-slate-900 leading-tight group-hover:text-brand transition-colors">{org.name}</p>
            {org.suspended && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-red-700 bg-red-50">
                <span className="w-1 h-1 rounded-full bg-red-500" />SUSPENDED
              </span>
            )}
            <span className="text-brand opacity-0 group-hover:opacity-100 transition-opacity text-xs">→</span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">{org.industry ?? '—'}  ·  Since {new Date(org.createdAt).toLocaleDateString()}</p>
        </Link>
      </td>

      {/* Plan */}
      <td className="px-5 py-3.5">
        <Badge text={org.plan} cls={planConfig[org.plan] ?? 'text-slate-600 bg-slate-100'} />
      </td>

      {/* Admin */}
      <td className="px-5 py-3.5">
        {org.admin ? (
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0">
              {org.admin.name.charAt(0)}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900 leading-tight truncate">{org.admin.name}</p>
              <p className="text-xs text-slate-400 font-mono truncate">{org.admin.email}</p>
            </div>
            {!org.admin.mfaEnabled && (
              <span title="Admin MFA disabled" className="text-amber-500 text-xs font-semibold flex-shrink-0">⚠</span>
            )}
          </div>
        ) : (
          <span className="text-xs text-slate-400">No admin assigned</span>
        )}
      </td>

      {/* Users */}
      <td className="px-5 py-3.5">
        <span className="font-mono tabular-nums text-slate-700 text-sm font-semibold">{org._count.users}</span>
      </td>

      {/* Services breakdown */}
      <td className="px-5 py-3.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          {org.servicesActive > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />{org.servicesActive}
            </span>
          )}
          {org.servicesExpiring > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />{org.servicesExpiring}
            </span>
          )}
          {org.servicesExpired > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-700 bg-red-50 px-1.5 py-0.5 rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500" />{org.servicesExpired}
            </span>
          )}
          {org.servicesSuspended > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />{org.servicesSuspended}
            </span>
          )}
          {org._count.services === 0 && <span className="text-xs text-slate-400">—</span>}
        </div>
      </td>

      {/* Health */}
      <td className="px-5 py-3.5"><HealthBar score={org.healthScore} /></td>

      {/* MRR */}
      <td className="px-5 py-3.5 text-right">
        <span className="font-mono tabular-nums text-sm font-semibold text-slate-900">₹{org.mrr.toLocaleString()}</span>
        <p className="text-[10px] text-slate-400 mt-0.5">₹{(org.contractValue / 1000).toFixed(0)}K ACV</p>
      </td>

      {/* Open requests */}
      <td className="px-5 py-3.5">
        <div className="flex items-center gap-1.5">
          <span className="font-mono tabular-nums text-sm text-slate-600">{org.openRequests}</span>
          {org.criticalRequests > 0 && (
            <span className="text-[10px] font-semibold text-red-700 bg-red-50 px-1.5 py-0.5 rounded">{org.criticalRequests} CRIT</span>
          )}
        </div>
      </td>

      {/* Actions */}
      <td className="px-5 py-3.5 text-right">
        <div className="flex gap-1.5 justify-end">
          <Link href={`/saas-admin/orgs/${org.id}`}>
            <GlowButton variant="secondary" className="py-1 px-2.5 text-xs">View →</GlowButton>
          </Link>
          <Link href={`/saas-admin/orgs/${org.id}#services`}>
            <GlowButton variant="ghost" className="py-1 px-2.5 text-xs">Services</GlowButton>
          </Link>
          {org.admin && (
            <GlowButton variant="ghost" className="py-1 px-2.5 text-xs"
              onClick={onImpersonate} disabled={impersonatePending}>
              Impersonate
            </GlowButton>
          )}
          <GlowButton variant={org.suspended ? 'primary' : 'danger'} className="py-1 px-2.5 text-xs"
            onClick={onSuspendToggle} disabled={suspendPending}>
            {org.suspended ? 'Restore' : 'Suspend'}
          </GlowButton>
        </div>
      </td>
    </tr>
  );
}

// ─── Filter tabs ─────────────────────────────────────────────────────────────
const ORG_FILTERS = ['ALL', 'ACTIVE', 'AT_RISK', 'SUSPENDED'] as const;
type OrgFilter = typeof ORG_FILTERS[number];
const ORG_FILTER_LABELS: Record<OrgFilter, string> = {
  ALL: 'All', ACTIVE: 'Active', AT_RISK: 'At Risk', SUSPENDED: 'Suspended',
};

const REQUEST_STATUSES = ['ALL', 'OPEN', 'IN_PROGRESS', 'ESCALATED', 'RESOLVED'] as const;
type RequestFilter = typeof REQUEST_STATUSES[number];

// ─── Administrator Dashboard ─────────────────────────────────────────────────
interface SadminUser {
  id: string; name: string; email: string; role: string;
  mfaEnabled: boolean; lastLoginAt: string | null; createdAt: string;
  customer: { id: string; name: string; slug: string; domain: string | null };
}

function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)  return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

// ─── Ticket workflow (removed from the control plane) ────────────────────────
// The admin control plane no longer surfaces organizations' own service requests —
// per the strict IAM rule, only escalations reach administrators (see the Ticketing
// feature). The former "Ticket Workflow" section and its row/section components were
// removed; org-side request management still lives on its own surface further down.

function AdminDashboard() {
  const { data: metrics, isLoading: metricsLoading } = useQuery<PlatformMetrics>({
    queryKey: ['admin-metrics'],
    queryFn: () => saasAdminApi.getMetrics().then((r) => r.data as PlatformMetrics),
    staleTime: 30_000,
  });
  // Sadmin count for the KPI card — the activity feed + full listing now live on the Users page.
  const { data: sadmins } = useQuery<SadminUser[]>({
    queryKey: ['sadmin-list'],
    queryFn: () => saasAdminApi.listSadmins().then((r) => (r.data as { sadmins: SadminUser[] }).sadmins),
    staleTime: 60_000,
  });
  const { data: orgsData, isLoading: orgsLoading } = useQuery<{ orgs: OrgOverview[]; total: number }>({
    queryKey: ['admin-orgs-overview'],
    queryFn: () => saasAdminApi.getOrgsOverview().then((r) => r.data as { orgs: OrgOverview[]; total: number }),
    staleTime: 30_000,
  });

  const orgs = orgsData?.orgs ?? [];

  return (
    <div className="p-8 max-w-[1400px] mx-auto space-y-8">
      {/* Header */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.22 }} className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse-soft" />
            <p className="text-sm font-semibold text-rose-600">Administrator · Platform Overview</p>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Administrator Dashboard</h1>
          <p className="mt-1 text-sm text-slate-500">
            Monitor Sadmin activity, platform health, and all client organizations
          </p>
        </div>
      </motion.div>

      {/* KPI strip */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.04 }}>
        {metricsLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{Array.from({ length: 4 }).map((_, i) => <ShimmerCard key={i} />)}</div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard title="Administrators"   value={sadmins?.length ?? 0}              tone="rose" />
            <KpiCard title="Client Orgs"      value={metrics?.totalOrgs ?? 0}           tone="brand" />
            <KpiCard title="Platform ARR"     value={`₹${((metrics?.arr ?? 0) / 1000).toFixed(0)}K`} tone="emerald" />
            <KpiCard title="Open Requests"    value={metrics?.openRequests ?? 0}        tone="amber"
              subtitle={metrics?.criticalRequests ? `${metrics.criticalRequests} critical` : undefined} />
          </div>
        )}
      </motion.div>

      {/* Client Organizations table */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.13 }}>
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-base font-semibold text-slate-900">Client Organizations</h2>
          <span className="text-xs text-slate-400">{orgs.length} organizations</span>
        </div>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Organization</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Plan</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Org Admin</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Health</th>
                  <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">MRR</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Services</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Requests</th>
                  <th className="px-5 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {orgsLoading ? (
                  Array.from({ length: 5 }).map((_, i) => <tr key={i}><td colSpan={8}><ShimmerRow /></td></tr>)
                ) : orgs.length === 0 ? (
                  <tr><td colSpan={8} className="px-5 py-12 text-center text-sm text-slate-500">No organizations found.</td></tr>
                ) : (
                  orgs.map((org) => (
                    <tr key={org.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
                      <td className="px-5 py-3.5">
                        <Link href={`/saas-admin/orgs/${org.id}`} className="block group">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold text-slate-900 group-hover:text-brand transition-colors">{org.name}</p>
                            {org.suspended && <span className="text-[10px] font-bold text-red-700 bg-red-50 px-1.5 py-0.5 rounded">SUSPENDED</span>}
                          </div>
                          <p className="text-xs text-slate-400 mt-0.5">{org.industry ?? '—'}</p>
                        </Link>
                      </td>
                      <td className="px-5 py-3.5">
                        <Badge text={org.plan} cls={planConfig[org.plan] ?? 'text-slate-600 bg-slate-100'} />
                      </td>
                      <td className="px-5 py-3.5">
                        {org.admin ? (
                          <div>
                            <p className="text-sm font-medium text-slate-900 leading-tight">{org.admin.name}</p>
                            <p className="text-xs text-slate-400">{org.admin.lastLoginAt ? timeAgo(org.admin.lastLoginAt) : 'Never logged in'}</p>
                          </div>
                        ) : <span className="text-xs text-slate-400">—</span>}
                      </td>
                      <td className="px-5 py-3.5"><HealthBar score={org.healthScore} /></td>
                      <td className="px-5 py-3.5 text-right">
                        <span className="font-mono tabular-nums text-sm font-semibold text-slate-900">₹{org.mrr.toLocaleString()}</span>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex gap-1">
                          {org.servicesActive > 0 && <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">{org.servicesActive}✓</span>}
                          {org.servicesExpiring > 0 && <span className="text-[11px] font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">{org.servicesExpiring}⚠</span>}
                          {org.servicesExpired > 0 && <span className="text-[11px] font-semibold text-red-700 bg-red-50 px-1.5 py-0.5 rounded">{org.servicesExpired}✗</span>}
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="font-mono tabular-nums text-sm text-slate-600">{org.openRequests}</span>
                        {org.criticalRequests > 0 && <span className="ml-1.5 text-[10px] font-semibold text-red-700 bg-red-50 px-1.5 py-0.5 rounded">{org.criticalRequests} CRIT</span>}
                      </td>
                      <td className="px-5 py-3.5 text-right whitespace-nowrap">
                        <Link href={`/saas-admin/orgs/${org.id}#services`} className="mr-2">
                          <GlowButton variant="ghost" className="py-1 px-2.5 text-xs">Services</GlowButton>
                        </Link>
                        <Link href={`/saas-admin/orgs/${org.id}`}>
                          <GlowButton variant="secondary" className="py-1 px-2.5 text-xs">View →</GlowButton>
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Main page (role-branched) ────────────────────────────────────────────────
export default function SaasAdminPage() {
  const { user } = useAuth();
  if (user?.role === 'ADMINISTRATOR') {
    return (
      <RoleGuard allowedRoles={['ADMINISTRATOR']}>
        <div className="flex h-screen overflow-hidden bg-canvas">
          <Sidebar />
          <main className="flex-1 overflow-y-auto">
            <AdminDashboard />
          </main>
        </div>
      </RoleGuard>
    );
  }
  return <SadminPage />;
}

function SadminPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [impersonateResult, setImpersonateResult] = useState<string | null>(null);
  const [orgFilter, setOrgFilter] = useState<OrgFilter>('ALL');
  const [orgSearch, setOrgSearch] = useState('');
  const [requestFilter, setRequestFilter] = useState<RequestFilter>('ALL');

  const { data: metrics, isLoading: metricsLoading } = useQuery<PlatformMetrics>({
    queryKey: ['saas-metrics'],
    queryFn: () => saasAdminApi.getMetrics().then((r) => r.data as PlatformMetrics),
    staleTime: 30_000,
  });

  const { data: orgsData, isLoading: orgsLoading } = useQuery<{ orgs: OrgOverview[]; total: number }>({
    queryKey: ['saas-orgs-overview'],
    queryFn: () => saasAdminApi.getOrgsOverview().then((r) => r.data as { orgs: OrgOverview[]; total: number }),
    staleTime: 20_000,
  });

  const { data: requestsData, isLoading: requestsLoading } = useQuery<{ requests: ServiceRequest[]; total: number }>({
    queryKey: ['saas-requests', requestFilter],
    queryFn: () => saasAdminApi.listRequests(
      requestFilter === 'ALL' ? { limit: 30 } : { status: requestFilter, limit: 30 }
    ).then((r) => r.data as { requests: ServiceRequest[]; total: number }),
    staleTime: 20_000,
  });

  const { data: flags } = useQuery<FeatureFlag[]>({
    queryKey: ['saas-flags'],
    queryFn: () => saasAdminApi.listFlags().then((r) => r.data as FeatureFlag[]),
    staleTime: 30_000,
  });

  // ─── Mutations ─────────────────────────────────────────────────────────────
  const suspendMutation = useMutation({
    mutationFn: ({ id, suspended }: { id: string; suspended: boolean }) => saasAdminApi.updateOrg(id, { suspended }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['saas-orgs-overview'] });
      qc.invalidateQueries({ queryKey: ['saas-metrics'] });
    },
  });
  const requestMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) => saasAdminApi.updateRequest(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['saas-requests'] });
      qc.invalidateQueries({ queryKey: ['saas-metrics'] });
    },
  });
  const flagMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: boolean }) => saasAdminApi.toggleFlag(key, { value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saas-flags'] }),
  });
  const impersonateMutation = useMutation({
    mutationFn: (userId: string) => saasAdminApi.impersonate(userId),
    onSuccess: (res) => setImpersonateResult((res.data as { impersonationToken: string }).impersonationToken),
  });

  // ─── Filtering logic ───────────────────────────────────────────────────────
  const allOrgs = useMemo(() => orgsData?.orgs ?? [], [orgsData]);
  const filterCounts = useMemo(() => ({
    ALL:       allOrgs.length,
    ACTIVE:    allOrgs.filter((o) => !o.suspended).length,
    AT_RISK:   allOrgs.filter((o) => !o.suspended && (o.servicesExpiring > 0 || o.servicesExpired > 0 || o.healthScore < 75 || o.criticalRequests > 0)).length,
    SUSPENDED: allOrgs.filter((o) => o.suspended).length,
  }), [allOrgs]);

  const filteredOrgs = useMemo(() => {
    let list = allOrgs;
    if (orgFilter === 'ACTIVE')    list = list.filter((o) => !o.suspended);
    if (orgFilter === 'AT_RISK')   list = list.filter((o) => !o.suspended && (o.servicesExpiring > 0 || o.servicesExpired > 0 || o.healthScore < 75 || o.criticalRequests > 0));
    if (orgFilter === 'SUSPENDED') list = list.filter((o) => o.suspended);
    if (orgSearch.trim()) {
      const q = orgSearch.trim().toLowerCase();
      list = list.filter((o) =>
        o.name.toLowerCase().includes(q) ||
        (o.industry ?? '').toLowerCase().includes(q) ||
        (o.admin?.name.toLowerCase().includes(q) ?? false) ||
        (o.admin?.email.toLowerCase().includes(q) ?? false)
      );
    }
    return list;
  }, [allOrgs, orgFilter, orgSearch]);

  return (
    <RoleGuard allowedRoles={['ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[1400px] mx-auto space-y-8">

            {/* ─── Header ─────────────────────────────────────────────────── */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.22 }} className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse-soft" />
                  <p className="text-sm font-semibold text-emerald-600">Super Admin · Control Plane</p>
                </div>
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Platform Admin</h1>
                <p className="mt-1 text-sm text-slate-500">
                  Manage all client organizations, their admins, users, and subscribed services
                </p>
              </div>
            </motion.div>

            {/* ─── KPI Strip ──────────────────────────────────────────────── */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.04 }}>
              {metricsLoading ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {Array.from({ length: 4 }).map((_, i) => <ShimmerCard key={i} />)}
                </div>
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <KpiCard title="Active Clients"  value={metrics?.totalOrgs ?? 0} tone="brand" />
                  <KpiCard title="Monthly Revenue" value={`₹${(metrics?.mrr ?? 0).toLocaleString()}`} tone="emerald" />
                  <KpiCard title="Services Active" value={metrics?.servicesActive ?? 0} tone="violet"
                    subtitle={metrics?.servicesExpiring ? `${metrics.servicesExpiring} expiring` : undefined} />
                  <KpiCard title="Open Requests"   value={metrics?.openRequests ?? 0} tone="amber"
                    subtitle={metrics?.criticalRequests ? `${metrics.criticalRequests} critical` : undefined} />
                </div>
              )}
            </motion.div>

            {/* ─── ORGANIZATIONS (primary section) ───────────────────────── */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.07 }}>
              <div className="flex items-baseline justify-between mb-4 flex-wrap gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Organizations</h2>
                  <p className="text-xs text-slate-500 mt-0.5">All client orgs — click any row to manage admin, users, and services</p>
                </div>
                <span className="text-xs text-slate-400">
                  Showing <span className="font-semibold text-slate-700 tabular-nums">{filteredOrgs.length}</span> of {allOrgs.length}
                </span>
              </div>

              <div className="card overflow-hidden">
                {/* Filter tabs + search */}
                <div className="px-3 py-2.5 border-b border-slate-100 flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1 overflow-x-auto">
                    {ORG_FILTERS.map((f) => (
                      <button
                        key={f}
                        onClick={() => setOrgFilter(f)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer
                          ${orgFilter === f ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}
                      >
                        {ORG_FILTER_LABELS[f]}
                        {filterCounts[f] > 0 && (
                          <span className={`tabular-nums px-1.5 rounded ${f === 'AT_RISK' && filterCounts[f] > 0 ? 'bg-amber-100 text-amber-700' : 'bg-slate-200 text-slate-600'}`}>
                            {filterCounts[f]}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="flex-1 min-w-[200px] ml-auto">
                    <div className="relative">
                      <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                      <input
                        type="search"
                        value={orgSearch}
                        onChange={(e) => setOrgSearch(e.target.value)}
                        placeholder="Search by name, industry, or admin…"
                        className="input pl-9 py-1.5 text-sm"
                      />
                    </div>
                  </div>
                </div>

                {/* Table */}
                <div className="overflow-x-auto">
                  <table className="min-w-full">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Organization</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Plan</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Org Admin</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Users</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Services</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Health</th>
                        <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">MRR</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Requests</th>
                        <th className="px-5 py-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {orgsLoading ? (
                        Array.from({ length: 5 }).map((_, i) => <tr key={i}><td colSpan={9}><ShimmerRow /></td></tr>)
                      ) : filteredOrgs.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="px-5 py-12 text-center text-sm text-slate-500">
                            {orgSearch ? `No organizations match "${orgSearch}".` : `No organizations in this filter.`}
                          </td>
                        </tr>
                      ) : (
                        filteredOrgs.map((org) => (
                          <OrgRow
                            key={org.id}
                            org={org}
                            onSuspendToggle={async () => {
                              const ok = await confirm(org.suspended
                                ? { title: 'Restore organization', message: <>Restore access for <b>{org.name}</b>?</>, confirmText: 'Restore' }
                                : { title: 'Suspend organization', message: <><b>{org.name}</b> will be suspended and all members will lose access.</>, confirmText: 'Suspend', variant: 'danger' });
                              if (ok) suspendMutation.mutate({ id: org.id, suspended: !org.suspended });
                            }}
                            suspendPending={suspendMutation.isPending}
                            onImpersonate={() => { if (org.admin) impersonateMutation.mutate(org.admin.id); }}
                            impersonatePending={impersonateMutation.isPending}
                          />
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </motion.div>

            {/* ─── Service Requests ───────────────────────────────────────── */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.1 }}>
              <h2 className="text-base font-semibold text-slate-900 mb-4">Service Requests</h2>
              <div className="card overflow-hidden">
                <div className="px-3 py-2.5 border-b border-slate-100 flex items-center gap-1 overflow-x-auto">
                  {REQUEST_STATUSES.map((s) => (
                    <button key={s} onClick={() => setRequestFilter(s)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer
                        ${requestFilter === s ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>
                      {s === 'ALL' ? 'All' : statusConfig[s]?.label ?? s}
                    </button>
                  ))}
                  <span className="ml-auto pr-2 text-xs text-slate-400 tabular-nums">{requestsData?.total ?? 0} total</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Priority</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Client</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Type</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Subject</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Age</th>
                        <th className="px-5 py-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {requestsLoading ? (
                        Array.from({ length: 4 }).map((_, i) => <tr key={i}><td colSpan={7}><ShimmerRow /></td></tr>)
                      ) : (requestsData?.requests ?? []).length === 0 ? (
                        <tr><td colSpan={7} className="px-5 py-12 text-center text-sm text-slate-500">No service requests in this filter.</td></tr>
                      ) : (
                        (requestsData?.requests ?? []).map((r) => {
                          const cfg = statusConfig[r.status] ?? statusConfig['OPEN']!;
                          const nextStatus = r.status === 'OPEN' ? 'IN_PROGRESS' : r.status === 'IN_PROGRESS' ? 'RESOLVED' : null;
                          return (
                            <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                              <td className="px-5 py-3.5"><PriorityBadge priority={r.priority} /></td>
                              <td className="px-5 py-3.5">
                                <Link href={`/saas-admin/orgs/${r.customer.id}`} className="block group">
                                  <p className="text-sm font-medium text-slate-900 leading-tight group-hover:text-brand transition-colors">{r.customer.name}</p>
                                  <p className="text-xs text-slate-400">{r.customer.industry ?? '—'}</p>
                                </Link>
                              </td>
                              <td className="px-5 py-3.5"><span className="text-xs font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md">{typeConfig[r.type] ?? r.type}</span></td>
                              <td className="px-5 py-3.5"><div className="max-w-xs"><p className="text-sm text-slate-700 leading-tight truncate">{r.subject}</p>{r.service && <p className="text-xs font-medium text-cyan-600 mt-0.5">{r.service}</p>}</div></td>
                              <td className="px-5 py-3.5"><Badge text={cfg.label} cls={cfg.cls} /></td>
                              <td className="px-5 py-3.5"><RequestAge createdAt={r.createdAt} /></td>
                              <td className="px-5 py-3.5 text-right">
                                {nextStatus && r.status !== 'RESOLVED' && r.status !== 'CLOSED' && (
                                  <GlowButton variant="secondary" className="py-1 px-2.5 text-xs"
                                    onClick={() => requestMutation.mutate({ id: r.id, data: { status: nextStatus } })} disabled={requestMutation.isPending}>
                                    {nextStatus === 'IN_PROGRESS' ? 'Assign' : 'Resolve'}
                                  </GlowButton>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </motion.div>

            {/* ─── Feature Flags + Impersonation ──────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.13 }}>
                <h2 className="text-base font-semibold text-slate-900 mb-4">Feature Flags</h2>
                <div className="card px-5">
                  {!flags?.length ? (
                    <p className="py-4 text-sm text-slate-400">No feature flags defined.</p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {flags.map((flag) => (
                        <Toggle key={flag.id} label={flag.key} description={flag.description} enabled={flag.value}
                          onChange={(v) => flagMutation.mutate({ key: flag.key, value: v })} disabled={flagMutation.isPending} />
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>

              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.16 }}>
                <h2 className="text-base font-semibold text-slate-900 mb-4">User Impersonation</h2>
                <div className="card p-5 space-y-4">
                  <div className="flex items-start gap-2.5 px-3 py-2.5 bg-amber-50 border border-amber-100 rounded-lg">
                    <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                    </svg>
                    <p className="text-xs text-amber-700">5-minute scoped token. All impersonation events are audit-logged.</p>
                  </div>

                  <AnimatePresence>
                    {impersonateResult && (
                      <motion.div key="imp" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
                        className="bg-slate-50 border border-slate-200 rounded-lg p-3.5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Token · 5 min expiry</p>
                            <code className="block text-xs font-mono text-slate-700 break-all leading-relaxed">{impersonateResult}</code>
                          </div>
                          <GlowButton variant="ghost" className="flex-shrink-0 text-xs py-1 px-2" onClick={() => setImpersonateResult(null)}>✕</GlowButton>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <ImpersonateForm onImpersonate={(id) => impersonateMutation.mutate(id)} loading={impersonateMutation.isPending} />
                </div>
              </motion.div>
            </div>

            {/* ─── Ticket numbering (platform-wide ID format) ─────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <TicketNumberingCard />
            </div>

          </div>
        </main>
      </div>
    </RoleGuard>
  );
}
