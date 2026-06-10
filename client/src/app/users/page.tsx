'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { usersApi, orgsApi, saasAdminApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import DataTable from '@/components/ui/DataTable';
import GlowButton from '@/components/ui/GlowButton';
import Toggle from '@/components/ui/Toggle';
import { ShimmerRow } from '@/components/ui/Shimmer';
import type { User, Customer } from '@/lib/schemas';

// ─── Confirmation Modal ─────────────────────────────────────────────────────
function ConfirmDeleteModal({
  userName,
  userEmail,
  isPending,
  onConfirm,
  onCancel,
}: {
  userName: string;
  userEmail: string;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onCancel}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: 0.18 }}
        className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex items-start gap-4">
          <div className="w-11 h-11 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-slate-900">Remove User</h3>
            <p className="mt-1.5 text-sm text-slate-500 leading-relaxed">
              Are you sure you want to remove <span className="font-semibold text-slate-700">{userName}</span>?
              This action cannot be undone.
            </p>
            <p className="mt-1 text-xs text-slate-400 font-mono">{userEmail}</p>
          </div>
        </div>

        {/* Actions */}
        <div className="px-6 py-4 bg-slate-50/80 border-t border-slate-100 flex items-center justify-end gap-3">
          <GlowButton variant="ghost" onClick={onCancel} disabled={isPending}>
            Cancel
          </GlowButton>
          <GlowButton variant="danger" onClick={onConfirm} disabled={isPending} loading={isPending}>
            Yes, Remove
          </GlowButton>
        </div>
      </motion.div>
    </div>
  );
}

const roleConfig: Record<string, { label: string; cls: string }> = {
  USER:          { label: 'User',          cls: 'text-slate-600 bg-slate-100' },
  ORG_ADMIN:     { label: 'Org Admin',     cls: 'text-violet-700 bg-violet-50' },
  ADMINISTRATOR: { label: 'Administrator', cls: 'text-rose-700 bg-rose-50' },
};

// ─── Platform-admin (Sadmin) monitoring — relocated here from the Control Plane ──
interface ActivityEntry {
  id: string;
  action: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  performedBy: { id: string; name: string; email: string; role: string };
}
interface SadminUser {
  id: string; name: string; email: string; role: string;
  mfaEnabled: boolean; lastLoginAt: string | null; createdAt: string;
  customer: { id: string; name: string; slug: string; domain: string | null };
}
// System-wide audit log (Administrator console)
interface SystemLogEntry {
  id: string;
  action: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  performedBy: { id: string; name: string; email: string; role: string };
  organization: { id: string; name: string; slug: string } | null;
}
interface SystemActivityResp { items: SystemLogEntry[]; total: number; page: number; limit: number }
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
const roleBadgeCls: Record<string, string> = {
  USER:          'text-slate-600 bg-slate-100',
  ORG_ADMIN:     'text-violet-700 bg-violet-50',
  ADMINISTRATOR: 'text-rose-700 bg-rose-50',
};
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

export default function UsersPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const { user } = useAuth();
  const isPlatformAdmin = user?.role === 'ADMINISTRATOR';
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName,  setInviteName]  = useState('');
  const [inviteRole,  setInviteRole]  = useState<'USER' | 'ORG_ADMIN'>('USER');

  // Confirmation modal state
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; email: string; type: 'user' | 'sadmin' } | null>(null);

  const { data: users, isLoading: usersLoading } = useQuery<{ users: User[] }>({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then((r) => r.data as { users: User[] }),
    staleTime: 30_000,
  });

  const { data: org } = useQuery<Customer>({
    queryKey: ['org'],
    queryFn: () => orgsApi.getMe().then((r) => r.data as Customer),
    staleTime: 60_000,
  });

  // Platform-admin only: live Sadmin activity + listing (polled for real-time updates)
  const { data: activity, isLoading: activityLoading } = useQuery<ActivityEntry[]>({
    queryKey: ['sadmin-activity'],
    queryFn: () => saasAdminApi.getSadminActivity(60).then((r) => r.data as ActivityEntry[]),
    enabled: isPlatformAdmin,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  const { data: sadmins, isLoading: sadminsLoading } = useQuery<SadminUser[]>({
    queryKey: ['sadmin-list'],
    queryFn: () => saasAdminApi.listSadmins().then((r) => (r.data as { sadmins: SadminUser[] }).sadmins),
    enabled: isPlatformAdmin,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  // ─── System-wide activity log (Administrator audit console) ───────────────
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
    enabled: isPlatformAdmin,
    staleTime: 60_000,
  });

  const logParams: Record<string, unknown> = {
    page: logPage, limit: LOG_LIMIT,
    ...(logAction ? { action: logAction } : {}),
    ...(logRole ? { role: logRole } : {}),
    ...(logOrg ? { orgId: logOrg } : {}),
    ...(logFrom ? { from: logFrom } : {}),
    ...(logTo ? { to: logTo } : {}),
  };
  const { data: syslog, isLoading: syslogLoading } = useQuery<SystemActivityResp>({
    queryKey: ['system-activity', logParams],
    queryFn: () => saasAdminApi.getSystemActivity(logParams).then((r) => r.data as SystemActivityResp),
    enabled: isPlatformAdmin,
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
  // Any filter change resets to the first page.
  const onFilter = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setLogPage(1); };
  const logTotal = syslog?.total ?? 0;
  const logPages = Math.max(1, Math.ceil(logTotal / LOG_LIMIT));

  const secMutation = useMutation({
    mutationFn: (d: { ssoEnabled?: boolean; mfaRequired?: boolean }) => orgsApi.updateSecurity(d),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }),
  });

  const inviteMutation = useMutation({
    mutationFn: () => usersApi.invite({ email: inviteEmail, name: inviteName, role: inviteRole }),
    onSuccess: () => { setInviteEmail(''); setInviteName(''); qc.invalidateQueries({ queryKey: ['users'] }); },
  });

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'USER' | 'ORG_ADMIN' }) => usersApi.changeRole(id, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => usersApi.remove(id),
    onSuccess: () => {
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ['users'] });
      router.push('/users');
    },
  });

  const removeSadminMutation = useMutation({
    mutationFn: (id: string) => saasAdminApi.removeSadmin(id),
    onSuccess: () => {
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ['sadmin-list'] });
      router.push('/users');
    },
  });

  const userColumns = [
    { key: 'name',  header: 'Name', render: (row: User) => <span className="font-medium text-slate-900">{row.name}</span> },
    { key: 'email', header: 'Email', render: (row: User) => <span className="text-slate-500">{row.email}</span> },
    {
      key: 'role', header: 'Role',
      render: (row: User) => {
        const cfg = roleConfig[row.role] ?? { label: row.role, cls: 'text-slate-600 bg-slate-100' };
        return (
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold ${cfg.cls}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-current" />
            {cfg.label}
          </span>
        );
      },
    },
    {
      key: 'mfaEnabled', header: 'MFA',
      render: (row: User) => row.mfaEnabled
        ? <span className="text-emerald-600 text-sm font-semibold">✓</span>
        : <span className="text-slate-400 text-sm">—</span>,
    },
    {
      key: 'actions', header: '',
      render: (row: User) => {
        if (row.role === 'ADMINISTRATOR') return <span className="text-xs text-slate-400">Protected</span>;
        const nextRole = row.role === 'USER' ? 'ORG_ADMIN' : 'USER';
        return (
          <div className="flex gap-1.5 justify-end">
            <GlowButton variant="ghost" className="py-1 px-2.5 text-xs"
              onClick={() => roleMutation.mutate({ id: row.id, role: nextRole })}
              disabled={roleMutation.isPending}>
              {nextRole === 'ORG_ADMIN' ? 'Promote' : 'Demote'}
            </GlowButton>
            <GlowButton variant="danger" className="py-1 px-2.5 text-xs"
              onClick={() => setDeleteTarget({ id: row.id, name: row.name, email: row.email, type: 'user' })} disabled={removeMutation.isPending}>
              Remove
            </GlowButton>
          </div>
        );
      },
    },
  ];

  const userCount  = users?.users.length ?? 0;
  const adminCount = users?.users.filter((u) => u.role === 'ORG_ADMIN').length ?? 0;
  const mfaCount   = users?.users.filter((u) => u.mfaEnabled).length ?? 0;

  return (
    <RoleGuard allowedRoles={['ORG_ADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[1200px] mx-auto space-y-8">

            {/* Header */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
              <p className="text-sm text-slate-500 mb-1">Identity</p>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Users</h1>
              {org && (
                <p className="mt-1 text-sm text-slate-500">
                  Manage team members in <span className="font-semibold text-slate-700">{org.name}</span>
                </p>
              )}
            </motion.div>

            {/* Summary tiles */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.04 }}>
              <div className="grid grid-cols-3 gap-4">
                <SummaryTile label="Total Members"   value={userCount}  tone="brand" />
                <SummaryTile label="Org Admins"      value={adminCount} tone="violet" />
                <SummaryTile label="MFA Enabled"     value={mfaCount}   tone="emerald" />
              </div>
            </motion.div>

            {/* Security Settings */}
            {org && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.07 }}>
                <h2 className="text-base font-semibold text-slate-900 mb-4">Security Settings</h2>
                <div className="card px-5">
                  <div className="divide-y divide-slate-100">
                    <Toggle label="SSO Enabled"  description="Allow sign-in via Single Sign-On"  enabled={org.ssoEnabled}  onChange={(v) => secMutation.mutate({ ssoEnabled: v })}  disabled={secMutation.isPending} />
                    <Toggle label="MFA Required" description="Require MFA for all team members" enabled={org.mfaRequired} onChange={(v) => secMutation.mutate({ mfaRequired: v })} disabled={secMutation.isPending} />
                  </div>
                </div>
              </motion.div>
            )}

            {/* Invite */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.1 }}>
              <h2 className="text-base font-semibold text-slate-900 mb-4">Invite Member</h2>
              <div className="card p-5">
                <div className="flex gap-3 flex-wrap items-end">
                  <div className="flex-1 min-w-44">
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Email</label>
                    <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="colleague@company.com" className="input" />
                  </div>
                  <div className="flex-1 min-w-36">
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Full Name</label>
                    <input value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Jane Smith" className="input" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Role</label>
                    <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)} className="input">
                      <option value="USER">User</option>
                      <option value="ORG_ADMIN">Org Admin</option>
                    </select>
                  </div>
                  <GlowButton onClick={() => inviteMutation.mutate()} disabled={!inviteEmail || !inviteName || inviteMutation.isPending} loading={inviteMutation.isPending}>
                    Send Invite
                  </GlowButton>
                </div>
                {inviteMutation.isSuccess && (
                  <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                    Invitation sent
                  </p>
                )}
              </div>
            </motion.div>

            {/* Team */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.13 }}>
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-base font-semibold text-slate-900">Team Members</h2>
                <span className="text-xs text-slate-400">{userCount} {userCount === 1 ? 'member' : 'members'}</span>
              </div>
              <div className="card overflow-hidden">
                <DataTable
                  columns={userColumns as unknown as Parameters<typeof DataTable>[0]['columns']}
                  data={(users?.users ?? []) as unknown as Record<string, unknown>[]}
                  loading={usersLoading}
                  emptyMessage="No team members yet."
                />
              </div>
            </motion.div>

            {/* ─── Platform admins (Sadmin) — platform admins only, live ──────── */}
            {isPlatformAdmin && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.16 }} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Sadmin Activity */}
                <div>
                  <h2 className="text-base font-semibold text-slate-900 mb-4">Sadmin Activity</h2>
                  <div className="card overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Recent actions · live</span>
                      <span className="text-xs text-slate-400">{activity?.length ?? 0} entries</span>
                    </div>
                    <div className="overflow-y-auto max-h-[420px]">
                      {activityLoading ? (
                        <div className="p-4 space-y-3">{Array.from({ length: 5 }).map((_, i) => <ShimmerRow key={i} />)}</div>
                      ) : !activity?.length ? (
                        <p className="px-5 py-10 text-center text-sm text-slate-400">No activity yet. Sadmin login/logout events will appear here.</p>
                      ) : (
                        <ul className="divide-y divide-slate-50">
                          {activity.map((entry) => {
                            const cfg = ACTION_LABEL[entry.action] ?? { label: entry.action, cls: 'text-slate-600 bg-slate-100', icon: '•' };
                            return (
                              <li key={entry.id} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50 transition-colors">
                                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs flex-shrink-0 font-bold ${cfg.cls}`}>{cfg.icon}</div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-baseline justify-between gap-2">
                                    <p className="text-sm font-semibold text-slate-900 truncate">{entry.performedBy.name}</p>
                                    <span className="text-[11px] text-slate-400 tabular-nums flex-shrink-0">{timeAgo(entry.createdAt)}</span>
                                  </div>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold ${cfg.cls}`}>{cfg.label}</span>
                                    <span className="text-xs text-slate-400 truncate">{entry.performedBy.email}</span>
                                  </div>
                                  <span className={`inline-flex items-center mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${entry.performedBy.role === 'ADMINISTRATOR' ? 'text-rose-700 bg-rose-50' : 'text-brand-700 bg-brand-50'}`}>{entry.performedBy.role}</span>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>

                {/* Sadmins listing */}
                <div>
                  <h2 className="text-base font-semibold text-slate-900 mb-4">Sadmins</h2>
                  <div className="card overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">All platform admins</span>
                      <span className="text-xs text-slate-400">{sadmins?.length ?? 0} total</span>
                    </div>
                    <div className="overflow-y-auto max-h-[420px]">
                      {sadminsLoading ? (
                        <div className="p-4 space-y-3">{Array.from({ length: 4 }).map((_, i) => <ShimmerRow key={i} />)}</div>
                      ) : !sadmins?.length ? (
                        <p className="px-5 py-10 text-center text-sm text-slate-400">No Sadmins found.</p>
                      ) : (
                        <ul className="divide-y divide-slate-50">
                          {sadmins.map((s) => {
                            const lastLogin = s.lastLoginAt ? timeAgo(s.lastLoginAt) : 'Never';
                            const isOnline = s.lastLoginAt && (Date.now() - new Date(s.lastLoginAt).getTime()) < 30 * 60 * 1000;
                            return (
                              <li key={s.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors">
                                <div className="relative flex-shrink-0">
                                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-sm font-bold text-white">{s.name.charAt(0)}</div>
                                  {isOnline && <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 rounded-full border-2 border-white" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-baseline gap-2">
                                    <p className="text-sm font-semibold text-slate-900 truncate">{s.name}</p>
                                    {!s.mfaEnabled && <span title="MFA disabled" className="text-amber-500 text-xs flex-shrink-0">⚠</span>}
                                  </div>
                                  <p className="text-xs text-slate-400 truncate">{s.email}</p>
                                </div>
                                <div className="text-right flex-shrink-0">
                                  <p className="text-xs font-mono text-slate-500">{lastLogin}</p>
                                  <p className="text-[10px] text-slate-400">{s.customer.name}</p>
                                  {user?.id !== s.id && (
                                    <button
                                      className="text-[10px] text-red-600 font-semibold hover:text-red-700 mt-1 cursor-pointer"
                                      onClick={() => setDeleteTarget({ id: s.id, name: s.name, email: s.email, type: 'sadmin' })}
                                      disabled={removeSadminMutation.isPending}
                                    >
                                      Remove
                                    </button>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* ─── System-wide activity log (Administrator audit console) ──────── */}
            {isPlatformAdmin && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.19 }}>
                <div className="flex items-baseline justify-between mb-4">
                  <h2 className="text-base font-semibold text-slate-900">System Activity Log</h2>
                  <span className="text-xs text-slate-400">{logTotal} {logTotal === 1 ? 'event' : 'events'}</span>
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
                                  <div className="font-medium text-slate-900">{e.performedBy?.name ?? '—'}</div>
                                  <div className="text-xs text-slate-400">{e.performedBy?.email ?? ''}</div>
                                </td>
                                <td className="px-4 py-3">
                                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${roleBadgeCls[e.performedBy?.role] ?? 'text-slate-600 bg-slate-100'}`}>{e.performedBy?.role ?? '—'}</span>
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

      {/* Confirmation Modal */}
      <AnimatePresence>
        {deleteTarget && (
          <ConfirmDeleteModal
            userName={deleteTarget.name}
            userEmail={deleteTarget.email}
            isPending={deleteTarget.type === 'user' ? removeMutation.isPending : removeSadminMutation.isPending}
            onConfirm={() => {
              if (deleteTarget.type === 'user') {
                removeMutation.mutate(deleteTarget.id);
              } else {
                removeSadminMutation.mutate(deleteTarget.id);
              }
            }}
            onCancel={() => setDeleteTarget(null)}
          />
        )}
      </AnimatePresence>
    </RoleGuard>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number | string; tone: 'emerald' | 'brand' | 'violet' }) {
  const dot = { emerald: 'bg-emerald-500', brand: 'bg-brand', violet: 'bg-violet-500' }[tone];
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">{label}</p>
        <span className={`w-2 h-2 rounded-full ${dot}`} />
      </div>
      <p className="font-mono text-2xl font-bold text-slate-900 tabular-nums leading-none">{value}</p>
    </div>
  );
}
