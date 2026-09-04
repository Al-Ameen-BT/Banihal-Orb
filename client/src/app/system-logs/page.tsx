'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { saasAdminApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import { ShimmerRow } from '@/components/ui/Shimmer';
import GlowButton from '@/components/ui/GlowButton';

// Only the fields the organization filter actually reads. The dashboard's fuller
// OrgOverview carries health, MRR and service counts this page has no use for.
interface OrgOption { id: string; name: string }

// The platform audit trail, lifted off the Administrator dashboard into its own
// workspace. On the dashboard it sat under "Communication & Governance" beside
// the announcement composer — two unrelated jobs sharing a section, on a page
// already long enough that the log was below three other groups.
//
// Gated on `system_activity.view`, which is what the endpoint itself now
// requires. On the dashboard it was gated on `platform_audit.view`, so an
// HR Admin rendered the panel and then got a 403 from the API — a permanently
// empty table with no explanation.

interface AuditEntry {
  id: string; action: string; createdAt: string; targetId: string | null;
  metadata: Record<string, unknown> | null;
  performedBy: { id: string; name: string; email: string; role: string } | null;
  organization: { id: string; name: string; slug: string } | null;
}

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

// ─── Audit log search + CSV export ───────────────────────────────────────────
function AuditLogSection({ orgs }: { orgs: OrgOption[] }) {
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


export default function SystemLogsPage() {
  const { can } = useAuth();
  const canViewLog = can('system_activity.view');

  // The organization filter needs the org list; orgs.manage is what gates that
  // endpoint. Without it the filter is simply absent rather than broken.
  const { data: orgs } = useQuery<OrgOption[]>({
    queryKey: ['org-options-logs'],
    queryFn: () => saasAdminApi.listOrgs({ limit: 100 }).then((r) => (r.data as { orgs: OrgOption[] }).orgs),
    enabled: can('orgs.manage'),
    staleTime: 300_000,
  });

  return (
    <RoleGuard allowedRoles={['ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-6 sm:p-8 max-w-[1200px] mx-auto space-y-6">

            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
              <p className="text-sm text-slate-500 mb-1">Platform</p>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">System Logs</h1>
              <p className="mt-1 text-sm text-slate-500">Search the platform audit trail and export filtered results.</p>
            </motion.div>

            {canViewLog ? (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.04 }}>
                <AuditLogSection orgs={orgs ?? []} />
              </motion.div>
            ) : (
              // RoleGuard admits any ADMINISTRATOR; the audit trail needs its own
              // key, so say which one rather than showing an empty table.
              <div className="card p-8 text-center">
                <p className="text-sm font-medium text-slate-900">You don&apos;t have access to the audit trail</p>
                <p className="mt-1.5 text-sm text-slate-500">System Logs requires the <span className="font-mono text-xs">system_activity.view</span> permission. Ask an administrator to grant it.</p>
              </div>
            )}

          </div>
        </main>
      </div>
    </RoleGuard>
  );
}
