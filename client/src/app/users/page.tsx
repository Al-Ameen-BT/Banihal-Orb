'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { usersApi, orgsApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import DataTable from '@/components/ui/DataTable';
import GlowButton from '@/components/ui/GlowButton';
import Toggle from '@/components/ui/Toggle';
import type { User, Organization } from '@/lib/schemas';

const roleConfig: Record<string, { label: string; cls: string }> = {
  USER:       { label: 'User',        cls: 'text-slate-600 bg-slate-100' },
  ORG_ADMIN:  { label: 'Org Admin',   cls: 'text-violet-700 bg-violet-50' },
  SAAS_ADMIN: { label: 'Super Admin', cls: 'text-brand-700 bg-brand-50' },
};

export default function UsersPage() {
  const qc = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName,  setInviteName]  = useState('');
  const [inviteRole,  setInviteRole]  = useState<'USER' | 'ORG_ADMIN'>('USER');

  const { data: users, isLoading: usersLoading } = useQuery<{ users: User[] }>({
    queryKey: ['users'],
    queryFn: () => usersApi.list().then((r) => r.data as { users: User[] }),
    staleTime: 30_000,
  });

  const { data: org } = useQuery<Organization>({
    queryKey: ['org'],
    queryFn: () => orgsApi.getMe().then((r) => r.data as Organization),
    staleTime: 60_000,
  });

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
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
        if (row.role === 'SAAS_ADMIN') return <span className="text-xs text-slate-400">Protected</span>;
        const nextRole = row.role === 'USER' ? 'ORG_ADMIN' : 'USER';
        return (
          <div className="flex gap-1.5 justify-end">
            <GlowButton variant="ghost" className="py-1 px-2.5 text-xs"
              onClick={() => roleMutation.mutate({ id: row.id, role: nextRole })}
              disabled={roleMutation.isPending}>
              {nextRole === 'ORG_ADMIN' ? 'Promote' : 'Demote'}
            </GlowButton>
            <GlowButton variant="danger" className="py-1 px-2.5 text-xs"
              onClick={() => removeMutation.mutate(row.id)} disabled={removeMutation.isPending}>
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
    <RoleGuard allowedRoles={['ORG_ADMIN', 'SAAS_ADMIN']}>
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

          </div>
        </main>
      </div>
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
