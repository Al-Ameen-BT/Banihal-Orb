'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { usersApi, orgsApi, saasAdminApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { roleBadgeFor } from '@/lib/display';
// The app's only segmented control. It lives under app/ticketing/ by accident of
// history, not coupling — a plain generic export the ticketing pages also use.
import { Segmented } from '../ticketing/shared';
import { notify } from '@/lib/toast-bus';
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
interface PlatformUser {
  id: string; name: string; email: string; role: string;
  mfaEnabled: boolean; lastLoginAt: string | null; createdAt: string;
  platformRole?: { id: string; key: string; name: string } | null;
  customer: { id: string; name: string; slug: string; domain?: string | null; plan?: string | null };
}
interface PlatformRole { id: string; key: string; name: string; description: string | null; system: boolean; permissions: string[] }
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
  const { user, can } = useAuth();
  const isPlatformAdmin = user?.role === 'ADMINISTRATOR';
  // Each panel keys off the permission that gates its endpoint, not off "is
  // staff" — every ADMINISTRATOR satisfies that, Intern included.
  const canAudit = can('platform_audit.view');
  const canManageUsers = can('users.manage');
  const canInviteStaff = can('staff.invite');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName,  setInviteName]  = useState('');
  const [inviteRole,  setInviteRole]  = useState<'USER' | 'ORG_ADMIN'>('USER');

  // Platform-staff invitation (the only path that assigns HR Admin / Employee /
  // Intern — before it existed every staff account was Administration).
  const [staffEmail, setStaffEmail] = useState('');
  const [staffName, setStaffName] = useState('');
  const [staffRoleId, setStaffRoleId] = useState('');

  // Confirmation modal state
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; email: string; type: 'user' | 'sadmin' } | null>(null);

  // Directory state. Two axes, not one: WHOSE people (client organizations vs the
  // provider's own staff) and, within clients, which role. The old single tab
  // mixed the two, so "All Users" sat beside "Platform Admins" as if they were
  // alternatives on the same list — and it filtered to role === 'USER', meaning
  // the tab claiming to show everyone showed the fewest people.
  const [audience, setAudience] = useState<'CLIENTS' | 'PLATFORM'>('CLIENTS');
  const [clientRole, setClientRole] = useState<'ALL' | 'ORG_ADMIN' | 'USER'>('ALL');

  const { data: users, isLoading: usersLoading } = useQuery<{ users: User[] }>({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then((r) => r.data as { users: User[] }),
    staleTime: 30_000,
    // ORG_ADMIN always; platform staff only with users.manage, which is what the
    // route now requires of them.
    enabled: !isPlatformAdmin || canManageUsers,
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
    enabled: canAudit,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  const { data: sadmins, isLoading: sadminsLoading } = useQuery<PlatformUser[]>({
    queryKey: ['sadmin-list'],
    queryFn: () => saasAdminApi.listSadmins().then((r) => (r.data as { sadmins: PlatformUser[] }).sadmins),
    enabled: canAudit,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const { data: platformRoles } = useQuery<PlatformRole[]>({
    queryKey: ['platform-roles'],
    queryFn: () => saasAdminApi.listPlatformRoles().then((r) => (r.data as { roles: PlatformRole[] }).roles),
    enabled: can('roles.manage'),
    staleTime: 300_000,
  });

  const { data: allUsers, isLoading: allUsersLoading } = useQuery<PlatformUser[]>({
    queryKey: ['all-users'],
    queryFn: () => saasAdminApi.listAllUsers().then((r) => (r.data as { users: PlatformUser[] }).users),
    enabled: canManageUsers,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const secMutation = useMutation({
    mutationFn: (d: { mfaRequired?: boolean }) => orgsApi.updateSecurity(d),
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

  const inviteStaffMutation = useMutation({
    mutationFn: () => saasAdminApi.inviteStaff({ email: staffEmail, name: staffName, platformRoleId: staffRoleId }),
    onSuccess: () => {
      setStaffEmail(''); setStaffName('');
      void qc.invalidateQueries({ queryKey: ['sadmin-list'] });
    },
  });

  const assignRoleMutation = useMutation({
    mutationFn: ({ id, platformRoleId }: { id: string; platformRoleId: string }) =>
      saasAdminApi.updateSadmin(id, { platformRoleId }),
    // A role change signs the target out so the new permissions apply at once —
    // but only if they were signed in. Report which actually happened, so the
    // administrator knows whether they just interrupted someone mid-work.
    onSuccess: (res) => {
      const d = res.data as { name?: string; sessionEnded?: boolean };
      const who = d.name ?? 'They';
      notify(d.sessionEnded
        ? `Role updated — ${who} was signed out and must sign in again.`
        : `Role updated — applies the next time ${who} signs in.`, 'success');
      void qc.invalidateQueries({ queryKey: ['sadmin-list'] });
    },
    onError: (err) => notify((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not update the role.', 'error'),
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

  // Org-scoped: the signed-in user's OWN organization.
  const userCount  = users?.users.length ?? 0;
  const adminCount = users?.users.filter((u) => u.role === 'ORG_ADMIN').length ?? 0;
  const mfaCount   = users?.users.filter((u) => u.mfaEnabled).length ?? 0;

  // Platform-wide, for the ADMINISTRATOR view. The two sources are disjoint:
  // listAllOrgUsers excludes ADMINISTRATOR, listSadmins returns only them — so
  // the total is a plain sum with nothing double-counted.
  //
  // null (not 0) when the caller lacks the permission that enables the query.
  // An Employee holds neither key, and a confident "0 users" would be a lie.
  const staffCount    = canAudit ? sadmins?.length ?? 0 : null;
  const orgAdminCount = canManageUsers ? (allUsers ?? []).filter((u) => u.role === 'ORG_ADMIN').length : null;
  const orgUserCount  = canManageUsers ? (allUsers ?? []).filter((u) => u.role === 'USER').length : null;
  const totalCount    = staffCount !== null && canManageUsers ? staffCount + (allUsers?.length ?? 0) : null;
  const shown = (v: number | null) => (v === null ? '—' : v);

  // ─── Directory ─────────────────────────────────────────────────────────────
  // Offer only the audiences whose data this viewer can actually load: `sadmins`
  // needs platform_audit.view and `allUsers` needs users.manage. Rendering both
  // regardless gave an Employee two tabs that were permanently, silently empty.
  const audienceOptions = [
    ...(canManageUsers ? [{ value: 'CLIENTS' as const, label: 'Clients' }] : []),
    ...(canAudit ? [{ value: 'PLATFORM' as const, label: 'Platform' }] : []),
  ];
  // Fall back to whichever they hold, so the default 'CLIENTS' never strands a
  // viewer on a tab that is not offered.
  const activeAudience = audienceOptions.some((o) => o.value === audience)
    ? audience
    : audienceOptions[0]?.value ?? 'CLIENTS';

  // ONE expression for both the rows and the header count — they used to be
  // written separately and could disagree.
  const directory = activeAudience === 'PLATFORM'
    ? sadmins ?? []
    : (allUsers ?? []).filter((u) => clientRole === 'ALL' || u.role === clientRole);
  const directoryLoading = activeAudience === 'PLATFORM' ? sadminsLoading : allUsersLoading;

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
              {/* The platform view counts every organization, so naming only the
                  provider's own org here would misdescribe the tiles below it. */}
              {isPlatformAdmin ? (
                <p className="mt-1 text-sm text-slate-500">Every account on the platform — provider staff and client organizations</p>
              ) : org && (
                <p className="mt-1 text-sm text-slate-500">
                  Manage team members in <span className="font-semibold text-slate-700">{org.name}</span>
                </p>
              )}
            </motion.div>

            {/* Summary tiles. Platform staff get PLATFORM-WIDE counts — the
                org-scoped set below would have shown them only their own
                provider organization, which reads as the whole platform. */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.04 }}>
              {isPlatformAdmin ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <SummaryTile label="Platform Staff" value={shown(staffCount)}    tone="brand"   hint="Provider-side accounts" />
                  <SummaryTile label="Org Admins"     value={shown(orgAdminCount)} tone="violet"  hint="Across every client org" />
                  <SummaryTile label="Org Users"      value={shown(orgUserCount)}  tone="emerald" hint="Across every client org" />
                  <SummaryTile label="Total Users"    value={shown(totalCount)}    tone="amber"   hint="Everyone on the platform" />
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-4">
                  <SummaryTile label="Total Members"   value={userCount}  tone="brand" />
                  <SummaryTile label="Org Admins"      value={adminCount} tone="violet" />
                  <SummaryTile label="MFA Enabled"     value={mfaCount}   tone="emerald" />
                </div>
              )}
            </motion.div>

            {/* Security Settings */}
            {org && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.07 }}>
                <h2 className="text-base font-semibold text-slate-900 mb-4">Security Settings</h2>
                <div className="card px-5">
                  <div className="divide-y divide-slate-100">
                    <Toggle label="MFA Required" description="Require MFA for all team members" enabled={org.mfaRequired} onChange={(v) => secMutation.mutate({ mfaRequired: v })} disabled={secMutation.isPending} />
                  </div>
                </div>
              </motion.div>
            )}

            {/* Invite — ORG_ADMIN only. This form adds someone to the CALLER'S
                organization (POST /users/invite is tenant-scoped), so on the
                platform side it read as "invite a platform user" while actually
                creating an account inside the provider's own org. Platform staff
                are invited through "Invite Platform Staff" below instead. */}
            {!isPlatformAdmin && (
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
                {inviteMutation.isSuccess && (() => {
                  // Report what actually happened. This used to say "Invitation
                  // sent" unconditionally while no email was ever sent and the
                  // temporary password was discarded — the account could never
                  // be signed in to.
                  const d = inviteMutation.data?.data as { delivered: boolean; tempPassword?: string; message: string };
                  return (
                    <p className={`mt-3 flex items-center gap-1.5 text-sm font-medium ${d.delivered ? 'text-emerald-600' : 'text-amber-600'}`}>
                      <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                      <span>{d.message}{d.tempPassword && <span className="ml-2 font-mono select-all">{d.tempPassword}</span>}</span>
                    </p>
                  );
                })()}
              </div>
            </motion.div>
            )}

            {/* Team Members - For Org Admins */}
            {!isPlatformAdmin && (
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
            )}

            {/* ─── Platform admins: Unified Directory + Activity ──────── */}
            {isPlatformAdmin && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.16 }} className="space-y-6">
                
                {/* Platform staff invitation */}
                {canInviteStaff && (
                  <div>
                    <h2 className="text-base font-semibold text-slate-900 mb-4">Invite Platform Staff</h2>
                    <div className="card p-5 space-y-3">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <input value={staffEmail} onChange={(e) => setStaffEmail(e.target.value)}
                          placeholder="colleague@provider-domain.com" className="input" />
                        <input value={staffName} onChange={(e) => setStaffName(e.target.value)}
                          placeholder="Jane Smith" className="input" />
                        <select value={staffRoleId} onChange={(e) => setStaffRoleId(e.target.value)} className="input">
                          <option value="">Select a platform role…</option>
                          {(platformRoles ?? []).map((r) => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                      </div>
                      <p className="text-xs text-slate-400">
                        Staff must use a provider-domain address (ADMIN_DOMAINS) — anything else cannot sign in.
                        You can only assign a role whose permissions you hold yourself.
                      </p>
                      <div className="flex items-center gap-3">
                        <GlowButton
                          onClick={() => inviteStaffMutation.mutate()}
                          disabled={!staffEmail || !staffName || !staffRoleId || inviteStaffMutation.isPending}
                          loading={inviteStaffMutation.isPending}
                        >
                          Send invitation
                        </GlowButton>
                        {inviteStaffMutation.isSuccess && (() => {
                          const d = inviteStaffMutation.data?.data as { delivered: boolean; tempPassword?: string; message: string };
                          return (
                            <p className={`text-sm font-medium ${d.delivered ? 'text-emerald-600' : 'text-amber-600'}`}>
                              {d.message}
                              {/* Shown only when the email did NOT go out, so a broken
                                  SMTP host degrades to a manual handover instead of an
                                  account nobody can sign in to. */}
                              {d.tempPassword && <span className="ml-2 font-mono select-all">{d.tempPassword}</span>}
                            </p>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                )}

                {/* User Roles */}
                <div>
                  <h2 className="text-base font-semibold text-slate-900">User Roles</h2>
                  <p className="text-sm text-slate-500 mb-4">Who holds which role — across your client organizations and your own staff.</p>
                  <div className="card overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-3 flex-wrap">
                        {/* One option means no choice: don't render a toggle a
                            viewer cannot move. */}
                        {audienceOptions.length > 1 && (
                          <Segmented value={activeAudience} onChange={setAudience} options={audienceOptions} layoutId="usersAudience" />
                        )}
                        {activeAudience === 'CLIENTS' && (
                          <Segmented
                            value={clientRole}
                            onChange={setClientRole}
                            size="sm"
                            layoutId="usersClientRole"
                            options={[
                              { value: 'ALL', label: 'Everyone' },
                              { value: 'ORG_ADMIN', label: 'Org Admins' },
                              { value: 'USER', label: 'Users' },
                            ]}
                          />
                        )}
                      </div>
                      <span className="text-xs text-slate-400 tabular-nums">
                        {directory.length} {directory.length === 1 ? 'person' : 'people'}
                      </span>
                    </div>

                    <div className="overflow-y-auto max-h-[500px]">
                      {directoryLoading ? (
                        <div className="p-4 space-y-3">{Array.from({ length: 4 }).map((_, i) => <ShimmerRow key={i} />)}</div>
                      ) : directory.length === 0 ? (
                        /* Sibling of the list, not a child of it — a <p> inside a
                           <ul> is invalid, and the message now names the audience
                           instead of the generic "this category". */
                        <p className="px-5 py-10 text-center text-sm text-slate-400">
                          {activeAudience === 'PLATFORM'
                            ? 'No platform staff yet. Invite someone above.'
                            : clientRole === 'ALL'
                              ? 'No client users yet.'
                              : `No ${clientRole === 'ORG_ADMIN' ? 'org admins' : 'users'} in any client organization yet.`}
                        </p>
                      ) : (
                        <ul className="divide-y divide-slate-50">
                          {directory.map((u) => {
                            const lastLogin = u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never';
                            const isOnline = u.lastLoginAt && (Date.now() - new Date(u.lastLoginAt).getTime()) < 30 * 60 * 1000;
                            return (
                              <li key={u.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors">
                                <div className="relative flex-shrink-0">
                                  <div className={`w-9 h-9 rounded-full bg-gradient-to-br ${u.role === 'ADMINISTRATOR' ? 'from-brand-400 to-brand-600' : u.role === 'ORG_ADMIN' ? 'from-violet-400 to-violet-600' : 'from-slate-300 to-slate-400'} flex items-center justify-center text-sm font-bold text-white`}>
                                    {u.name.charAt(0)}
                                  </div>
                                  {isOnline && <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 rounded-full border-2 border-white" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-baseline gap-2">
                                    <p className="text-sm font-semibold text-slate-900 truncate">{u.name}</p>
                                    {!u.mfaEnabled && <span title="MFA disabled" className="text-amber-500 text-xs flex-shrink-0">⚠</span>}
                                  </div>
                                  <p className="text-xs text-slate-400 truncate">{u.email}</p>
                                </div>
                                {/* Actions. The role control used to be a 10px
                                    unlabelled <select> stacked under the org
                                    name — it read as metadata, not as the
                                    permission-granting control it is. */}
                                <div className="flex items-center gap-4 flex-shrink-0">
                                  <div className="text-right hidden sm:block">
                                    <p className="text-xs font-mono text-slate-500">{lastLogin}</p>
                                    <p className="text-[11px] text-slate-400 truncate max-w-[140px]" title={u.customer.name}>{u.customer.name}</p>
                                  </div>

                                  {/* Client rows carry no controls, so reserving
                                      the staff column's width left every one of
                                      them ending in dead space. Show the role
                                      instead and let the row close up. */}
                                  {u.role !== 'ADMINISTRATOR' && (() => {
                                    const cfg = roleConfig[u.role] ?? { label: u.role, cls: 'text-slate-600 bg-slate-100' };
                                    return (
                                      <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${cfg.cls}`}>
                                        <span className="w-1.5 h-1.5 rounded-full bg-current" />
                                        {cfg.label}
                                      </span>
                                    );
                                  })()}

                                  {u.role === 'ADMINISTRATOR' && (
                                    <div className="w-[170px]">
                                      <label
                                        htmlFor={`role-${u.id}`}
                                        className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400 mb-1"
                                      >
                                        Platform role
                                      </label>
                                      {canManageUsers && platformRoles ? (
                                        <div className="relative">
                                          <select
                                            id={`role-${u.id}`}
                                            className="w-full appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pl-2.5 pr-7 text-xs font-medium text-slate-800 cursor-pointer transition-colors hover:border-slate-300 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60 disabled:cursor-wait"
                                            value={u.platformRole?.id ?? ''}
                                            disabled={assignRoleMutation.isPending}
                                            onChange={(e) => assignRoleMutation.mutate({ id: u.id, platformRoleId: e.target.value })}
                                          >
                                            {platformRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                                          </select>
                                          {/* appearance-none removes the native arrow, so draw one back */}
                                          <svg className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                                          </svg>
                                        </div>
                                      ) : (
                                        // Read-only: still shows WHICH role, so the
                                        // column reads the same for every viewer.
                                        <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${roleBadgeFor(u.platformRole).cls}`}>
                                          <span className="w-1.5 h-1.5 rounded-full bg-current" />
                                          {u.platformRole ? roleBadgeFor(u.platformRole).label : '—'}
                                        </span>
                                      )}
                                    </div>
                                  )}

                                  {user?.id !== u.id && u.role === 'ADMINISTRATOR' && canManageUsers && (
                                    <button
                                      className="rounded-lg border border-transparent p-1.5 text-slate-400 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-red-300 disabled:opacity-50 cursor-pointer"
                                      title={`Remove ${u.name}`}
                                      aria-label={`Remove ${u.name}`}
                                      onClick={() => setDeleteTarget({ id: u.id, name: u.name, email: u.email, type: 'sadmin' })}
                                      disabled={removeSadminMutation.isPending}
                                    >
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                                      </svg>
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

                {/* Sadmin Activity */}
                <div>
                  <h2 className="text-base font-semibold text-slate-900 mb-4">Sadmin Activity</h2>
                  <div className="card overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Recent actions · live</span>
                      <span className="text-xs text-slate-400">{activity?.length ?? 0} entries</span>
                    </div>
                    <div className="overflow-y-auto max-h-[300px]">
                      {activityLoading ? (
                        <div className="p-4 space-y-3">{Array.from({ length: 3 }).map((_, i) => <ShimmerRow key={i} />)}</div>
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

function SummaryTile({ label, value, tone, hint }: {
  label: string; value: number | string; tone: 'emerald' | 'brand' | 'violet' | 'amber'; hint?: string;
}) {
  const dot = { emerald: 'bg-emerald-500', brand: 'bg-brand', violet: 'bg-violet-500', amber: 'bg-amber-500' }[tone];
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">{label}</p>
        <span className={`w-2 h-2 rounded-full ${dot}`} />
      </div>
      <p className="font-mono text-2xl font-bold text-slate-900 tabular-nums leading-none">{value}</p>
      {/* Says WHICH population the number counts — four tiles of bare digits
          side by side are otherwise indistinguishable from one another. */}
      {hint && <p className="mt-1.5 text-[11px] text-slate-400 leading-tight">{hint}</p>}
    </div>
  );
}
