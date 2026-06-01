'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { saasAdminApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import GlowButton from '@/components/ui/GlowButton';
import Toggle from '@/components/ui/Toggle';
import { Shimmer } from '@/components/ui/Shimmer';

// ─── Types ──────────────────────────────────────────────────────────────────
interface OrgUser {
  id: string; name: string; email: string;
  role: 'USER' | 'ORG_ADMIN' | 'SAAS_ADMIN';
  mfaEnabled: boolean; lastLoginAt: string | null; createdAt: string;
}
interface OrgService {
  id: string; name: string; description: string | null;
  status: 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'SUSPENDED'; enabled: boolean;
  monthlyPrice: number; purchasedAt: string; renewsAt: string; lastBilledAt: string | null;
}
interface OpenRequest {
  id: string; type: string; subject: string; status: string; priority: string;
  service: string | null; assignedTo: string | null; createdAt: string;
}
interface OrgDetail {
  org: {
    id: string; name: string; slug: string; plan: string; industry: string | null;
    contractValue: number; healthScore: number; csm: string | null;
    suspended: boolean; ssoEnabled: boolean; mfaRequired: boolean; creditLimit: number;
    createdAt: string;
    _count: { users: number; services: number; requests: number };
    users: OrgUser[];
    services: OrgService[];
    requests: OpenRequest[];
  };
  admin: OrgUser | null;
  monthlyRevenue: number;
}

// ─── Config maps (light) ────────────────────────────────────────────────────
const serviceStatusConfig: Record<string, { cls: string; dot: string; label: string }> = {
  ACTIVE:    { cls: 'text-emerald-700 bg-emerald-50', dot: 'bg-emerald-500', label: 'Active' },
  EXPIRING:  { cls: 'text-amber-700 bg-amber-50',     dot: 'bg-amber-500',   label: 'Expiring' },
  EXPIRED:   { cls: 'text-red-700 bg-red-50',         dot: 'bg-red-500',     label: 'Expired' },
  SUSPENDED: { cls: 'text-slate-600 bg-slate-100',    dot: 'bg-slate-400',   label: 'Suspended' },
};
const priorityConfig: Record<string, { cls: string; dot: string; label: string }> = {
  CRITICAL: { cls: 'text-red-700 bg-red-50',      dot: 'bg-red-500',    label: 'Critical' },
  HIGH:     { cls: 'text-amber-700 bg-amber-50',  dot: 'bg-amber-500',  label: 'High' },
  MEDIUM:   { cls: 'text-cyan-700 bg-cyan-50',    dot: 'bg-cyan-500',   label: 'Medium' },
  LOW:      { cls: 'text-slate-600 bg-slate-100', dot: 'bg-slate-400',  label: 'Low' },
};
const roleConfig: Record<string, { cls: string; label: string }> = {
  USER:       { cls: 'text-slate-600 bg-slate-100',    label: 'User' },
  ORG_ADMIN:  { cls: 'text-violet-700 bg-violet-50',   label: 'Org Admin' },
  SAAS_ADMIN: { cls: 'text-brand-700 bg-brand-50',     label: 'Super Admin' },
};
const planConfig: Record<string, string> = {
  FREE:       'text-slate-600 bg-slate-100',
  PRO:        'text-cyan-700 bg-cyan-50',
  ENTERPRISE: 'text-violet-700 bg-violet-50',
};

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000);
}

// ─── Editable Admin Card ────────────────────────────────────────────────────
function AdminCard({ admin, onSaved }: { admin: OrgUser | null; onSaved: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(admin?.name ?? '');
  const [email, setEmail] = useState(admin?.email ?? '');
  const [mfa, setMfa] = useState(admin?.mfaEnabled ?? false);
  const [tempPw, setTempPw] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (admin) {
      setName(admin.name);
      setEmail(admin.email);
      setMfa(admin.mfaEnabled);
    }
  }, [admin]);

  const updateMutation = useMutation({
    mutationFn: () => saasAdminApi.updateUser(admin!.id, { name, email, mfaEnabled: mfa }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-detail'] });
      qc.invalidateQueries({ queryKey: ['saas-admins'] });
      setSaved(true);
      onSaved();
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const resetPwMutation = useMutation({
    mutationFn: () => saasAdminApi.resetUserPassword(admin!.id),
    onSuccess: (res) => setTempPw((res.data as { tempPassword: string }).tempPassword),
  });

  const impersonateMutation = useMutation({
    mutationFn: () => saasAdminApi.impersonate(admin!.id),
  });

  if (!admin) {
    return (
      <div className="card p-6">
        <p className="text-sm text-slate-500">No organization admin assigned yet.</p>
      </div>
    );
  }

  const dirty = name !== admin.name || email !== admin.email || mfa !== admin.mfaEnabled;

  return (
    <div className="card p-6">
      {/* Admin identity */}
      <div className="flex items-center gap-4 mb-6 pb-5 border-b border-slate-100">
        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-violet-400 to-violet-600 flex items-center justify-center text-base font-bold text-white">
          {admin.name.charAt(0)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold text-slate-900 leading-tight truncate">{admin.name}</p>
          <p className="text-sm text-slate-500 font-mono truncate">{admin.email}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold flex-shrink-0 ${roleConfig['ORG_ADMIN']!.cls}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          Org Admin
        </span>
      </div>

      {/* Editable form */}
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Full Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className="input font-mono text-xs" />
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 pt-4">
          <div>
            <p className="text-sm font-medium text-slate-900">MFA Enforced</p>
            <p className="text-xs text-slate-500 mt-0.5">Require multi-factor auth for this admin</p>
          </div>
          <button
            type="button"
            onClick={() => setMfa(!mfa)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer
              ${mfa ? 'bg-brand' : 'bg-slate-200'}`}
            aria-pressed={mfa}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${mfa ? 'translate-x-[22px]' : 'translate-x-[4px]'}`} />
          </button>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-3 border-t border-slate-100">
          <GlowButton onClick={() => updateMutation.mutate()} disabled={!dirty || updateMutation.isPending} loading={updateMutation.isPending}>
            Save Changes
          </GlowButton>
          <GlowButton variant="secondary" onClick={() => resetPwMutation.mutate()} disabled={resetPwMutation.isPending} loading={resetPwMutation.isPending}>
            Reset Password
          </GlowButton>
          <GlowButton variant="ghost" onClick={() => impersonateMutation.mutate()} disabled={impersonateMutation.isPending} loading={impersonateMutation.isPending}>
            Impersonate
          </GlowButton>
          <AnimatePresence>
            {saved && (
              <motion.span initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 ml-auto">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                Saved
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        {/* Tokens (impersonation / reset password) */}
        <AnimatePresence>
          {impersonateMutation.data && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="bg-amber-50 border border-amber-100 rounded-lg p-3.5">
              <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1.5">Impersonation Token · 5 min expiry</p>
              <code className="block text-[11px] font-mono text-slate-700 break-all leading-relaxed">
                {(impersonateMutation.data.data as { impersonationToken: string }).impersonationToken}
              </code>
            </motion.div>
          )}
          {tempPw && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="bg-red-50 border border-red-100 rounded-lg p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1.5">Temporary Password · Communicate Securely</p>
                  <code className="block text-sm font-mono text-slate-900 break-all leading-relaxed select-all">{tempPw}</code>
                  <p className="text-[11px] text-red-600 mt-1.5">All existing sessions have been revoked.</p>
                </div>
                <button onClick={() => setTempPw(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer">✕</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Editable User Row ──────────────────────────────────────────────────────
function UserRow({ user, isCurrentAdmin }: { user: OrgUser; isCurrentAdmin: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);

  const cfg = roleConfig[user.role] ?? roleConfig['USER']!;

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => saasAdminApi.updateUser(user.id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['org-detail'] }); setEditing(false); },
  });
  const removeMutation = useMutation({
    mutationFn: () => saasAdminApi.removeUser(user.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-detail'] }),
  });

  if (editing) {
    return (
      <tr className="border-b border-slate-100 bg-amber-50/30">
        <td className="px-5 py-3" colSpan={6}>
          <div className="flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-44">
              <label className="block text-xs font-semibold text-slate-500 mb-1">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="input text-sm py-1.5" />
            </div>
            <div className="flex-1 min-w-44">
              <label className="block text-xs font-semibold text-slate-500 mb-1">Email</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} className="input text-sm py-1.5 font-mono" />
            </div>
            <GlowButton className="py-1.5 px-3 text-xs"
              onClick={() => updateMutation.mutate({ name, email })}
              disabled={updateMutation.isPending} loading={updateMutation.isPending}>
              Save
            </GlowButton>
            <GlowButton variant="ghost" className="py-1.5 px-3 text-xs" onClick={() => { setEditing(false); setName(user.name); setEmail(user.email); }}>
              Cancel
            </GlowButton>
          </div>
        </td>
      </tr>
    );
  }

  const nextRole = user.role === 'USER' ? 'ORG_ADMIN' : user.role === 'ORG_ADMIN' ? 'USER' : null;

  return (
    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
      <td className="px-5 py-3.5">
        <p className="text-sm font-medium text-slate-900 leading-tight">{user.name}</p>
        <p className="text-xs text-slate-400 font-mono mt-0.5">{user.email}</p>
      </td>
      <td className="px-5 py-3.5">
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold ${cfg.cls}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          {cfg.label}
        </span>
        {isCurrentAdmin && <span className="ml-1.5 text-[10px] font-semibold text-slate-400">PRIMARY</span>}
      </td>
      <td className="px-5 py-3.5">
        {user.mfaEnabled ? <span className="text-emerald-600 text-sm font-semibold">✓</span> : <span className="text-slate-400 text-sm">—</span>}
      </td>
      <td className="px-5 py-3.5">
        <span className="text-xs font-mono tabular-nums text-slate-500">
          {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : 'Never'}
        </span>
      </td>
      <td className="px-5 py-3.5 text-xs font-mono tabular-nums text-slate-500">
        {new Date(user.createdAt).toLocaleDateString()}
      </td>
      <td className="px-5 py-3.5 text-right">
        {user.role === 'SAAS_ADMIN' ? (
          <span className="text-xs text-slate-400">Protected</span>
        ) : (
          <div className="flex gap-1.5 justify-end">
            <GlowButton variant="ghost" className="py-1 px-2 text-xs" onClick={() => setEditing(true)}>Edit</GlowButton>
            {nextRole && (
              <GlowButton variant="ghost" className="py-1 px-2 text-xs"
                onClick={() => updateMutation.mutate({ role: nextRole })} disabled={updateMutation.isPending}>
                {nextRole === 'ORG_ADMIN' ? 'Promote' : 'Demote'}
              </GlowButton>
            )}
            <GlowButton variant="danger" className="py-1 px-2 text-xs"
              onClick={() => { if (confirm(`Remove ${user.name}?`)) removeMutation.mutate(); }}
              disabled={removeMutation.isPending}>
              Remove
            </GlowButton>
          </div>
        )}
      </td>
    </tr>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────
export default function OrgDetailPage() {
  const params = useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const orgId = params?.['id'] as string;

  const { data, isLoading, error } = useQuery<OrgDetail>({
    queryKey: ['org-detail', orgId],
    queryFn: () => saasAdminApi.getOrgDetail(orgId).then((r) => r.data as OrgDetail),
    staleTime: 20_000,
    enabled: !!orgId,
  });

  const suspendMutation = useMutation({
    mutationFn: () => saasAdminApi.updateOrg(orgId, { suspended: !data?.org.suspended }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-detail'] }),
  });

  const serviceToggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      saasAdminApi.updateService(id, { enabled, status: enabled ? 'ACTIVE' : 'SUSPENDED' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-detail'] }),
  });
  const serviceRenewMutation = useMutation({
    mutationFn: (id: string) => saasAdminApi.renewService(id, { months: 12 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-detail'] }),
  });

  if (isLoading || !data) {
    return (
      <RoleGuard allowedRoles={['SAAS_ADMIN']}>
        <div className="flex h-screen overflow-hidden bg-canvas">
          <Sidebar />
          <main className="flex-1 overflow-y-auto">
            <div className="p-8 max-w-[1400px] mx-auto space-y-6">
              <Shimmer className="h-8 w-64" />
              <Shimmer className="h-32 w-full" />
              <Shimmer className="h-64 w-full" />
            </div>
          </main>
        </div>
      </RoleGuard>
    );
  }

  if (error || !data?.org) {
    return (
      <RoleGuard allowedRoles={['SAAS_ADMIN']}>
        <div className="flex h-screen overflow-hidden bg-canvas">
          <Sidebar />
          <main className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-slate-500 mb-3">Organization not found.</p>
              <GlowButton onClick={() => router.push('/saas-admin')}>← Back to Control Plane</GlowButton>
            </div>
          </main>
        </div>
      </RoleGuard>
    );
  }

  const { org, admin, monthlyRevenue } = data;
  const otherUsers = org.users.filter((u) => u.id !== admin?.id);

  return (
    <RoleGuard allowedRoles={['SAAS_ADMIN']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[1400px] mx-auto space-y-8">

            {/* Back + Header */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.22 }}>
              <Link href="/saas-admin" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900 transition-colors mb-4">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
                Control Plane
              </Link>

              <div className="flex items-start justify-between gap-6 flex-wrap">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-brand-50 border border-brand-100 flex items-center justify-center">
                    <svg className="w-6 h-6 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M3 3h12m-.75 4.5H21" />
                    </svg>
                  </div>
                  <div>
                    <div className="flex items-center gap-2.5 mb-1">
                      <h1 className="text-2xl font-bold tracking-tight text-slate-900">{org.name}</h1>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold ${planConfig[org.plan] ?? 'text-slate-600 bg-slate-100'}`}>{org.plan}</span>
                      {org.suspended && (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold text-red-700 bg-red-50">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                          Suspended
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-500">
                      {org.industry ?? '—'}  ·  Customer since {new Date(org.createdAt).toLocaleDateString()}  ·  CSM {org.csm ?? 'Unassigned'}
                    </p>
                  </div>
                </div>
                <GlowButton variant={org.suspended ? 'primary' : 'danger'}
                  onClick={() => { if (confirm(org.suspended ? `Restore ${org.name}?` : `Suspend ${org.name}? Members will lose access.`)) suspendMutation.mutate(); }}
                  disabled={suspendMutation.isPending} loading={suspendMutation.isPending}>
                  {org.suspended ? 'Restore Access' : 'Suspend Org'}
                </GlowButton>
              </div>
            </motion.div>

            {/* KPI strip */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.04 }}>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                <StatCard label="Monthly Revenue" value={`$${monthlyRevenue.toLocaleString()}`} tone="emerald" />
                <StatCard label="Annual Contract" value={`$${org.contractValue.toLocaleString()}`} tone="violet" />
                <StatCard label="Services" value={org._count.services} tone="brand" />
                <StatCard label="Users" value={org._count.users} tone="amber" />
                <StatCard label="Health Score" value={org.healthScore} tone={org.healthScore >= 90 ? 'emerald' : org.healthScore >= 75 ? 'amber' : 'red'} />
              </div>
            </motion.div>

            {/* Two-col: Admin card + Org metadata */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.07 }} className="lg:col-span-2">
                <h2 className="text-base font-semibold text-slate-900 mb-4">Organization Admin</h2>
                <AdminCard admin={admin} onSaved={() => { /* react-query already invalidated */ }} />
              </motion.div>

              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.1 }}>
                <h2 className="text-base font-semibold text-slate-900 mb-4">Security Posture</h2>
                <div className="card p-5 space-y-4">
                  <SecurityRow label="SSO Sign-In" enabled={org.ssoEnabled} />
                  <SecurityRow label="MFA Enforced" enabled={org.mfaRequired} />
                  <SecurityRow label="Admin has MFA" enabled={admin?.mfaEnabled ?? false} />
                  <div className="pt-3 border-t border-slate-100 space-y-1.5 text-sm">
                    <div className="flex justify-between"><span className="text-slate-500">Credit Limit</span><span className="font-mono tabular-nums font-semibold text-slate-900">{org.creditLimit.toLocaleString()}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Open Requests</span><span className="font-mono tabular-nums font-semibold text-slate-900">{org._count.requests}</span></div>
                  </div>
                </div>
              </motion.div>
            </div>

            {/* Services */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.13 }}>
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-base font-semibold text-slate-900">Purchased Services</h2>
                <span className="text-xs text-slate-400 tabular-nums">${monthlyRevenue.toLocaleString()}/mo  ·  {org.services.length} subscriptions</span>
              </div>
              <div className="card overflow-hidden">
                {org.services.length === 0 ? (
                  <p className="px-5 py-6 text-sm text-slate-500">No services subscribed.</p>
                ) : (
                  <table className="min-w-full">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Service</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Renews</th>
                        <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Monthly</th>
                        <th className="px-5 py-3 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-500">Enabled</th>
                        <th className="px-5 py-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {org.services.map((svc) => {
                        const cfg = serviceStatusConfig[svc.status] ?? serviceStatusConfig['ACTIVE']!;
                        const days = daysUntil(svc.renewsAt);
                        const dayColor = days < 0 ? 'text-red-600' : days < 30 ? 'text-amber-600' : 'text-slate-500';
                        return (
                          <tr key={svc.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                            <td className="px-5 py-3.5">
                              <p className="text-sm font-medium text-slate-900 leading-tight">{svc.name}</p>
                              {svc.description && <p className="text-xs text-slate-400 mt-0.5 max-w-[300px] truncate">{svc.description}</p>}
                            </td>
                            <td className="px-5 py-3.5">
                              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold ${cfg.cls}`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                                {cfg.label}
                              </span>
                            </td>
                            <td className="px-5 py-3.5">
                              <span className={`text-xs font-mono tabular-nums font-semibold ${dayColor}`}>
                                {days < 0 ? `${Math.abs(days)}d ago` : `in ${days}d`}
                              </span>
                              <p className="text-[11px] text-slate-400 mt-0.5">{new Date(svc.renewsAt).toLocaleDateString()}</p>
                            </td>
                            <td className="px-5 py-3.5 text-right font-mono tabular-nums text-sm font-semibold text-slate-900">
                              ${svc.monthlyPrice.toLocaleString()}
                            </td>
                            <td className="px-5 py-3.5 text-center">
                              <button type="button" disabled={serviceToggleMutation.isPending}
                                onClick={() => serviceToggleMutation.mutate({ id: svc.id, enabled: !svc.enabled })}
                                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${svc.enabled ? 'bg-brand' : 'bg-slate-300'}`}
                                aria-pressed={svc.enabled} aria-label={`Toggle ${svc.name}`}>
                                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${svc.enabled ? 'translate-x-[18px]' : 'translate-x-[2px]'}`} />
                              </button>
                            </td>
                            <td className="px-5 py-3.5 text-right">
                              <GlowButton variant="secondary" className="py-1 px-2.5 text-xs"
                                onClick={() => serviceRenewMutation.mutate(svc.id)} disabled={serviceRenewMutation.isPending}>
                                Renew +12mo
                              </GlowButton>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </motion.div>

            {/* Users */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.16 }}>
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-base font-semibold text-slate-900">Organization Users</h2>
                <span className="text-xs text-slate-400">{org.users.length} members</span>
              </div>
              <div className="card overflow-hidden">
                <table className="min-w-full">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">User</th>
                      <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Role</th>
                      <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">MFA</th>
                      <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Last Login</th>
                      <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Joined</th>
                      <th className="px-5 py-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {admin && <UserRow user={admin} isCurrentAdmin />}
                    {otherUsers.map((u) => <UserRow key={u.id} user={u} isCurrentAdmin={false} />)}
                    {org.users.length === 0 && (
                      <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-slate-500">No users in this organization yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </motion.div>

            {/* Open Requests */}
            {org.requests.length > 0 && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.19 }}>
                <h2 className="text-base font-semibold text-slate-900 mb-4">Open Service Requests</h2>
                <div className="card overflow-hidden divide-y divide-slate-100">
                  {org.requests.map((req) => {
                    const cfg = priorityConfig[req.priority] ?? priorityConfig['LOW']!;
                    return (
                      <div key={req.id} className="px-5 py-3.5 flex items-center gap-4 hover:bg-slate-50">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold ${cfg.cls} flex-shrink-0`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                          {cfg.label}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-slate-700 truncate">{req.subject}</p>
                          {req.service && <p className="text-xs text-cyan-600 font-medium">{req.service}</p>}
                        </div>
                        <span className="text-xs text-slate-400 font-mono tabular-nums flex-shrink-0">
                          {Math.floor((Date.now() - new Date(req.createdAt).getTime()) / 3_600_000)}h
                        </span>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}

          </div>
        </main>
      </div>
    </RoleGuard>
  );
}

// ─── Helper sub-components ──────────────────────────────────────────────────
function StatCard({ label, value, tone }: { label: string; value: number | string; tone: 'emerald' | 'amber' | 'red' | 'brand' | 'violet' }) {
  const dot = { emerald: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', brand: 'bg-brand', violet: 'bg-violet-500' }[tone];
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{label}</p>
        <span className={`w-2 h-2 rounded-full ${dot}`} />
      </div>
      <p className="font-mono text-xl font-bold text-slate-900 tabular-nums leading-none">{value}</p>
    </div>
  );
}

function SecurityRow({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-slate-700">{label}</span>
      {enabled
        ? <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Enabled</span>
        : <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400"><span className="w-1.5 h-1.5 rounded-full bg-slate-300" />Off</span>}
    </div>
  );
}
