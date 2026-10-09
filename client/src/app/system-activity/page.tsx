'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { saasAdminApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar, { icons } from '@/components/ui/Sidebar';
import { PageHeader } from '@/components/ui/PageHeader';
import GlowButton from '@/components/ui/GlowButton';
import { ShimmerRow } from '@/components/ui/Shimmer';
import { roleBadgeFor } from '@/lib/display';

// The cross-tenant audit trail, lifted out of the Users page into its own
// workspace. It is gated on `system_activity.view` — held today only by
// Administration — where it previously rode on `platform_audit.view`, which HR
// Admin also holds for the staff directory. Splitting the key is what makes
// "audit trail" and "see who the staff are" separately grantable.

// System-wide audit log (Administrator console)
interface SystemLogEntry {
  id: string;
  action: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  // NULL once the performer's account has been deleted (AuditLog.performedById is
  // ON DELETE SET NULL) — the name then comes back from the metadata snapshot that
  // lib/audit.ts writes at insert time, so deleted users stay identifiable.
  performedBy: { id: string; name: string; email: string; role: string; platformRole: { id: string; key: string; name: string } | null } | null;
  organization: { id: string; name: string; slug: string } | null;
}
interface SystemActivityResp { items: SystemLogEntry[]; total: number; page: number; limit: number }
// Logins classified by organization (compliance / log-analysis summary)
interface OrgLoginStat { id: string; name: string; slug: string | null; logins: number; users: number; lastLogin: string | null }
interface LoginsByOrgResp { items: OrgLoginStat[]; totalLogins: number; orgCount: number }
const ACTION_LABEL: Record<string, { label: string; cls: string; icon: string }> = {
  LOGIN:                               { label: 'Logged in',        cls: 'text-emerald-700 bg-emerald-50', icon: '→' },
  LOGOUT:                              { label: 'Signed out',       cls: 'text-slate-600 bg-slate-100',    icon: '←' },
  CUSTOMER_CREATED:                    { label: 'Org created',      cls: 'text-indigo-700 bg-indigo-50',   icon: '＋' },
  USER_REGISTERED:                     { label: 'User registered',  cls: 'text-cyan-700 bg-cyan-50',       icon: '★' },
  ADMIN_PASSWORD_RESET:                { label: 'Password reset',   cls: 'text-amber-700 bg-amber-50',     icon: '🔑' },
  ADMINISTRATOR_SADMIN_PASSWORD_RESET: { label: 'Sadmin pwd reset', cls: 'text-amber-700 bg-amber-50',     icon: '🔑' },
  ADMIN_USER_UPDATE:                   { label: 'User updated',     cls: 'text-brand-700 bg-brand-50',     icon: '✎' },
  ADMINISTRATOR_SADMIN_UPDATE:         { label: 'Sadmin updated',   cls: 'text-brand-700 bg-brand-50',     icon: '✎' },
  ADMINISTRATOR_SADMIN_REMOVE:         { label: 'Sadmin removed',   cls: 'text-red-700 bg-red-50',         icon: '🗑' },
  ADMIN_USER_REMOVE:                   { label: 'User removed',     cls: 'text-red-700 bg-red-50',         icon: '🗑' },
  USER_REMOVED:                        { label: 'User removed',     cls: 'text-red-700 bg-red-50',         icon: '🗑' },
};
// Role badge is resolved through display.roleBadgeFor, keyed on the platform
// role (administration / hr_admin / employee / intern), not the legacy User.role
// enum which is ADMINISTRATOR for every staff member.
const LOG_ACTION_OPTIONS = [
  { value: '', label: 'All events' },
  { value: 'CUSTOMER_CREATED', label: 'Org created' },
  { value: 'USER_REGISTERED', label: 'User registered' },
  { value: 'LOGIN', label: 'Login' },
  { value: 'LOGOUT', label: 'Logout' },
];
function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)  return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}


export default function SystemActivityPage() {
  const { can } = useAuth();
  const canViewLog = can('system_activity.view');
  const canFilterByOrg = can('orgs.manage');

  const LOG_LIMIT = 50;
  const [logAction, setLogAction] = useState('');
  const [logRole, setLogRole]     = useState('');
  const [logOrg, setLogOrg]       = useState('');
  const [logFrom, setLogFrom]     = useState('');
  const [logTo, setLogTo]         = useState('');
  const [logPage, setLogPage]     = useState(1);

  const { data: orgOptions } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['org-options'],
    queryFn: () => saasAdminApi.listOrgs({ limit: 100 }).then((r) => (r.data as { orgs: { id: string; name: string }[] }).orgs),
    enabled: canFilterByOrg,
    staleTime: 300_000,
  });

  const logParams: Record<string, unknown> = {
    page: logPage,
    limit: LOG_LIMIT,
    ...(logAction ? { action: logAction } : {}),
    ...(logRole ? { role: logRole } : {}),
    ...(logOrg ? { orgId: logOrg } : {}),
    ...(logFrom ? { from: logFrom } : {}),
    ...(logTo ? { to: logTo } : {}),
  };
  const { data: syslog, isLoading: syslogLoading } = useQuery<SystemActivityResp>({
    queryKey: ['system-activity', logParams],
    queryFn: () => saasAdminApi.getSystemActivity(logParams).then((r) => r.data as SystemActivityResp),
    enabled: canViewLog,
    staleTime: 10_000,
    refetchInterval: 20_000,
  });

  // Logins-by-org summary — shares the role + date filters so the classification
  // matches the detailed log below. Not affected by the org filter (it IS the
  // per-org breakdown) or the event filter (it always counts LOGINs).
  const loginStatParams: Record<string, unknown> = {
    ...(logRole ? { role: logRole } : {}),
    ...(logFrom ? { from: logFrom } : {}),
    ...(logTo ? { to: logTo } : {}),
  };
  const { data: loginsByOrg, isLoading: loginsByOrgLoading } = useQuery<LoginsByOrgResp>({
    queryKey: ['logins-by-org', loginStatParams],
    queryFn: () => saasAdminApi.getLoginsByOrg(loginStatParams).then((r) => r.data as LoginsByOrgResp),
    enabled: canViewLog,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  // Any filter change resets to the first page.
  const onFilter = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setLogPage(1); };
  const logTotal = syslog?.total ?? 0;
  const logPages = Math.max(1, Math.ceil(logTotal / LOG_LIMIT));

  return (
    <RoleGuard allowedRoles={['ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-6 sm:p-8 max-w-[1600px] mx-auto space-y-6">

            <PageHeader eyebrow="Platform" title="System Activity" icon={icons.activity}
              subtitle="Every audited action across the platform — logins, account changes and organization events." />

            {!canViewLog ? (
              // RoleGuard admits any ADMINISTRATOR; the audit trail itself needs
              // its own key, so say so rather than rendering empty tables.
              <div className="card p-8 text-center">
                <p className="text-sm font-medium text-slate-900">You don&apos;t have access to the audit trail</p>
                <p className="mt-1.5 text-sm text-slate-500">System Activity requires the <span className="font-mono text-xs">system_activity.view</span> permission. Ask an administrator to grant it.</p>
              </div>
            ) : (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.19 }}>
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-base font-semibold text-slate-900">System Activity Log</h2>
                <span className="text-xs text-slate-400">{logTotal} {logTotal === 1 ? 'event' : 'events'}</span>
              </div>

              {/* Logins classified by organization — click an org to drill the log below into it */}
              <div className="card p-4 mb-4">
                <div className="flex items-baseline justify-between mb-3">
                  <h3 className="text-sm font-semibold text-slate-900">Logins by Organization</h3>
                  <span className="text-xs text-slate-400">
                    {loginsByOrg ? `${loginsByOrg.totalLogins} logins · ${loginsByOrg.orgCount} orgs` : ''}
                    {(logRole || logFrom || logTo) ? ' · filtered' : ''}
                  </span>
                </div>
                {loginsByOrgLoading ? (
                  <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <ShimmerRow key={i} />)}</div>
                ) : !loginsByOrg?.items.length ? (
                  <p className="py-6 text-center text-sm text-slate-400">No logins in this window.</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {loginsByOrg.items.map((o) => {
                      const active = logOrg === o.id;
                      return (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => onFilter(setLogOrg)(active ? '' : o.id)}
                          aria-pressed={active}
                          title={active ? 'Clear org filter' : `Filter the log to ${o.name}`}
                          className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${active ? 'border-brand-400 bg-brand-50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-sm font-semibold text-slate-900">{o.name}</span>
                            <span className="shrink-0 text-sm font-mono font-semibold tabular-nums text-brand-700">{o.logins}</span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            {o.users} {o.users === 1 ? 'user' : 'users'} · {o.lastLogin ? `last ${timeAgo(o.lastLogin)}` : 'no logins'}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Filters */}
              <div className="card p-4 mb-4">
                <div className="flex flex-wrap gap-3 items-end">
                  <div className="min-w-40">
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Event</label>
                    <select value={logAction} onChange={(e) => onFilter(setLogAction)(e.target.value)} className="input py-1.5 text-sm">
                      {LOG_ACTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div className="min-w-36">
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Role</label>
                    <select value={logRole} onChange={(e) => onFilter(setLogRole)(e.target.value)} className="input py-1.5 text-sm">
                      <option value="">All roles</option>
                      <option value="USER">User</option>
                      <option value="ORG_ADMIN">Org Admin</option>
                      <option value="ADMINISTRATOR">Administrator</option>
                    </select>
                  </div>
                  <div className="min-w-44">
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Organization</label>
                    <select value={logOrg} onChange={(e) => onFilter(setLogOrg)(e.target.value)} className="input py-1.5 text-sm">
                      <option value="">All organizations</option>
                      {orgOptions?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">From</label>
                    <input type="date" value={logFrom} onChange={(e) => onFilter(setLogFrom)(e.target.value)} className="input py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">To</label>
                    <input type="date" value={logTo} onChange={(e) => onFilter(setLogTo)(e.target.value)} className="input py-1.5 text-sm" />
                  </div>
                  {(logAction || logRole || logOrg || logFrom || logTo) && (
                    <GlowButton variant="ghost" className="py-1.5 px-3 text-xs"
                      onClick={() => { setLogAction(''); setLogRole(''); setLogOrg(''); setLogFrom(''); setLogTo(''); setLogPage(1); }}>
                      Clear
                    </GlowButton>
                  )}
                </div>
              </div>

              {/* Log table */}
              <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                        <th className="px-4 py-2.5">When</th>
                        <th className="px-4 py-2.5">User</th>
                        <th className="px-4 py-2.5">Role</th>
                        <th className="px-4 py-2.5">Event</th>
                        <th className="px-4 py-2.5">Organization</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {syslogLoading ? (
                        Array.from({ length: 6 }).map((_, i) => (
                          <tr key={i}><td colSpan={5} className="px-4 py-3"><ShimmerRow /></td></tr>
                        ))
                      ) : !syslog?.items.length ? (
                        <tr><td colSpan={5} className="px-5 py-12 text-center text-sm text-slate-400">No matching activity.</td></tr>
                      ) : (
                        syslog.items.map((e) => {
                          const cfg = ACTION_LABEL[e.action] ?? { label: e.action, cls: 'text-slate-600 bg-slate-100', icon: '•' };
                          return (
                            <tr key={e.id} className="hover:bg-slate-50 transition-colors">
                              <td className="px-4 py-3 whitespace-nowrap text-slate-500" title={new Date(e.createdAt).toLocaleString()}>{timeAgo(e.createdAt)}</td>
                              <td className="px-4 py-3">
                                <div className="font-medium text-slate-900">{e.performedBy?.name ?? (e.metadata?.performedByName as string | undefined) ?? 'Deleted user'}</div>
                                <div className="text-xs text-slate-400">{e.performedBy?.email ?? (e.metadata?.performedByEmail as string | undefined) ?? ''}</div>
                              </td>
                              <td className="px-4 py-3">
                                {(() => {
                                  const badge = roleBadgeFor(e.performedBy?.platformRole ?? null);
                                  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${badge.cls}`}>{badge.label}</span>;
                                })()}
                              </td>
                              <td className="px-4 py-3">
                                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold ${cfg.cls}`}>{cfg.icon} {cfg.label}</span>
                              </td>
                              <td className="px-4 py-3 text-slate-600">{e.organization?.name ?? <span className="text-slate-400">—</span>}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                {/* Pagination */}
                <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100">
                  <span className="text-xs text-slate-400">Page {logPage} of {logPages}</span>
                  <div className="flex gap-1.5">
                    <GlowButton variant="ghost" className="py-1 px-2.5 text-xs" disabled={logPage <= 1} onClick={() => setLogPage((p) => Math.max(1, p - 1))}>Prev</GlowButton>
                    <GlowButton variant="ghost" className="py-1 px-2.5 text-xs" disabled={logPage >= logPages} onClick={() => setLogPage((p) => Math.min(logPages, p + 1))}>Next</GlowButton>
                  </div>
                </div>
              </div>
            </motion.div>
            )}

          </div>
        </main>
      </div>
    </RoleGuard>
  );
}
