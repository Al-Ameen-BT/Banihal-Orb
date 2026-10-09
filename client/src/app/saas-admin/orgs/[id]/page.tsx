'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { saasAdminApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import GlowButton from '@/components/ui/GlowButton';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { notify } from '@/lib/toast-bus';
import { mfaStatus } from '@/lib/display';
import { Shimmer } from '@/components/ui/Shimmer';

// ─── Types ──────────────────────────────────────────────────────────────────
interface OrgUser {
  id: string; name: string; email: string;
  role: 'USER' | 'ORG_ADMIN' | 'ADMINISTRATOR';
  mfaEnabled: boolean; lastLoginAt: string | null; createdAt: string;
}
interface OrgService {
  id: string; name: string; description: string | null;
  status: 'ACTIVE' | 'EXPIRING' | 'EXPIRED';
  monthlyPrice: number; purchaseDate: string; endDate: string; notes: string | null;
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
    orgCode: string | null;
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
  USER:          { cls: 'text-slate-600 bg-slate-100',   label: 'User' },
  ORG_ADMIN:     { cls: 'text-violet-700 bg-violet-50',  label: 'Org Admin' },
  ADMINISTRATOR: { cls: 'text-rose-700 bg-rose-50',      label: 'Administrator' },
};
const planConfig: Record<string, string> = {
  FREE:       'text-slate-600 bg-slate-100',
  PRO:        'text-cyan-700 bg-cyan-50',
  ENTERPRISE: 'text-violet-700 bg-violet-50',
};

interface CatalogItem {
  id: string; name: string; description: string | null;
  category: string | null; basePrice: number; enabled: boolean;
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000);
}

// ─── Catalog Picker Modal ───────────────────────────────────────────────────
function CatalogPickerModal({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [endDate, setEndDate] = useState('');
  const [price, setPrice] = useState('');
  const [provisioned, setProvisioned] = useState<{ rawKey?: string; hint?: string } | null>(null);

  const { data: catalog = [], isLoading } = useQuery<CatalogItem[]>({
    queryKey: ['catalog'],
    queryFn: () => saasAdminApi.listCatalog().then((r) => r.data as CatalogItem[]),
    staleTime: 60_000,
  });

  const enabledItems = catalog.filter((i) => i.enabled);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return enabledItems;
    return enabledItems.filter((i) => i.name.toLowerCase().includes(q) || (i.category ?? '').toLowerCase().includes(q));
  }, [enabledItems, search]);

  const assignMutation = useMutation({
    mutationFn: () => saasAdminApi.assignService(orgId, {
      name: selected!.name,
      description: selected!.description ?? undefined,
      monthlyPrice: Number(price) || selected!.basePrice,
      endDate,
      catalogServiceId: selected!.id,
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['org-detail'] });
      const p = (res.data as { provisioned?: { rawKey?: string; hint?: string } }).provisioned;
      if (p?.rawKey) {
        // One-time provisioning key — the org admin copies it from their Squid page;
        // we surface it here so staff can hand it off immediately.
        setProvisioned({ rawKey: p.rawKey, hint: p.hint });
      } else {
        onClose();
      }
    },
  });

  function handleSelect(item: CatalogItem) {
    setSelected(item);
    setPrice(String(item.basePrice));
  }

  const canAssign = selected && endDate;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18 }}
        className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl flex flex-col max-h-[85vh]"
      >
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Add from Service Catalog</h2>
            <p className="text-xs text-slate-400 mt-0.5">{enabledItems.length} services available</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors cursor-pointer" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-4 border-b border-slate-100 flex-shrink-0">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search catalog…" className="input pl-9 py-2 text-sm" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          {isLoading ? (
            <div className="space-y-2">{[...Array(4)].map((_, i) => <Shimmer key={i} className="h-16 rounded-lg" />)}</div>
          ) : filtered.length === 0 ? (
            <p className="text-center text-sm text-slate-500 py-8">No catalog services found{search ? ` for "${search}"` : ''}.</p>
          ) : (
            <div className="space-y-2">
              {filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelect(item)}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition-all cursor-pointer ${
                    selected?.id === item.id
                      ? 'border-brand bg-brand-50 ring-1 ring-brand'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-sm font-semibold text-slate-900">{item.name}</p>
                        {item.category && (
                          <span className="text-[11px] font-medium text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                            {item.category}
                          </span>
                        )}
                      </div>
                      {item.description && <p className="text-xs text-slate-400 truncate">{item.description}</p>}
                    </div>
                    <p className="font-mono text-sm font-bold text-slate-700 flex-shrink-0 tabular-nums">
                      ₹{item.basePrice.toLocaleString()}/mo
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {provisioned ? (
          <div className="px-6 py-4 border-t border-slate-100 flex-shrink-0 bg-slate-50/60 rounded-b-2xl space-y-3">
            <div>
              <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
                Provisioned — one-time agent registration key
              </p>
              <div className="rounded-lg bg-slate-900 text-slate-100 font-mono text-base px-4 py-3 flex items-center gap-3 break-all">
                <span className="flex-1">{provisioned.rawKey}</span>
                <button type="button" onClick={() => navigator.clipboard?.writeText(provisioned.rawKey ?? '')} className="text-brand-200 hover:text-white text-sm cursor-pointer flex-shrink-0">
                  Copy
                </button>
              </div>
            </div>
            <p className="text-[11px] text-slate-500">
              This key is shown <strong>once</strong> — hand it to the org admin (hint: <span className="font-mono">{provisioned.hint}</span>) before closing. They enter it when installing the Squid agent.
            </p>
            <div className="flex items-center gap-3">
              <GlowButton variant="ghost" onClick={onClose}>Done</GlowButton>
            </div>
          </div>
        ) : selected && (
          <div className="px-6 py-4 border-t border-slate-100 flex-shrink-0 bg-slate-50/60 rounded-b-2xl">
            <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-3">Configure assignment for <span className="text-brand">{selected.name}</span></p>
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex-1 min-w-[140px]">
                <label className="block text-xs font-medium text-slate-600 mb-1">₹/month override</label>
                <input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} placeholder={String(selected.basePrice)} className="input py-1.5 text-sm" />
              </div>
              <div className="flex-1 min-w-[140px]">
                <label className="block text-xs font-medium text-slate-600 mb-1">End date <span className="text-red-500">*</span></label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="input py-1.5 text-sm" />
              </div>
              <GlowButton
                disabled={!canAssign || assignMutation.isPending}
                loading={assignMutation.isPending}
                onClick={() => assignMutation.mutate()}
              >
                Assign Service
              </GlowButton>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

// ─── Delete Organization (2-step confirmation) ───────────────────────────────

function DeleteOrgModal({ org, onClose, onDeleted }: { org: OrgDetail['org']; onClose: () => void; onDeleted: () => void }) {
  const [step, setStep] = useState(0);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () => saasAdminApi.deleteOrg(org.id, { confirm: org.name }),
    onSuccess: () => {
      notify('Organization deleted — ticketing history retained for compliance', 'success');
      onDeleted();
    },
    // 400 codes come back with a plain `error` message; anything else (network,
    // 5xx mid-flight) is a generic refusal from the interceptor, not this modal's.
    onError: (e: unknown) => {
      const data = (e as { response?: { data?: { error?: string } } })?.response?.data;
      setError(data?.error ?? 'The organization could not be deleted. Reload the page and try again.');
    },
  });

  const continueBlocked = !org.suspended;
  const canConfirm = confirmText === org.name;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18 }}
        className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[85vh]"
      >
        <div className="px-6 py-5 border-b border-slate-100 flex items-start gap-4 flex-shrink-0">
          <div className="w-11 h-11 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-slate-900">Delete Org</h2>
            <p className="text-xs text-slate-400 mt-0.5">Step {step + 1} of 2 · {org.name} · irreversible</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors cursor-pointer" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 flex-1 overflow-y-auto min-h-0">
          {continueBlocked && (
            <div className="bg-amber-50 border border-amber-100 rounded-lg px-3.5 py-2.5 text-sm text-amber-800 flex items-start gap-2">
              <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9.303 3.376c-.866 1.5.217 3.374 1.948 3.374H4.749c-1.731 0-2.814-1.874-1.948-3.374L10.052 3.378c.866-1.5 3.032-1.5 3.898 0l6.353 11.998Z" />
              </svg>
              <span>This organization is still <b>active</b>. Suspend it first — only suspended organizations can be deleted.</span>
            </div>
          )}

          {step === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">This cannot be undone:</p>
              <ul className="text-sm text-slate-700 space-y-1.5 list-disc pl-4 pr-1">
                <li>The organization, its {org._count.users} user(s), chat history, services and requests are permanently deleted.</li>
                <li>Ticketing history is <span className="font-medium">retained</span> in both stores — tickets are compliance records and are never deleted.</li>
              </ul>
              <p className="text-[11px] text-slate-400 pt-1">{org._count.users} user(s) · {org.plan} plan</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-slate-50 border border-slate-100 rounded-lg px-4 py-3">
                <p className="text-sm font-medium text-slate-700">Deleting the organization</p>
                <p className="text-xs text-slate-500 mt-1">
                  {org.name} and its {org._count.users} user(s), chat history and non-ticketing data will be deleted. Tickets stay in both stores.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Type <span className="font-semibold text-red-600">{org.name}</span> to confirm
                </label>
                <input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={org.name}
                  className="input font-mono text-sm"
                  autoFocus
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          )}
        </div>

        <div className="px-6 py-4 bg-slate-50/80 border-t border-slate-100 flex items-center justify-end gap-3 flex-shrink-0">
          <GlowButton variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </GlowButton>
          {step === 0 ? (
            <GlowButton onClick={() => setStep(1)} disabled={continueBlocked}>
              Continue
            </GlowButton>
          ) : (
            <>
              <GlowButton variant="ghost" onClick={() => { setStep(0); setError(''); }} disabled={mutation.isPending}>
                Back
              </GlowButton>
              <GlowButton
                variant="danger"
                disabled={!canConfirm || mutation.isPending}
                loading={mutation.isPending}
                onClick={() => mutation.mutate()}
              >
                Delete organization forever
              </GlowButton>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ─── Editable Admin Card ────────────────────────────────────────────────────
function AdminCard({ admin, onSaved, orgMfaRequired }: { admin: OrgUser | null; onSaved: () => void; orgMfaRequired: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState(admin?.name ?? '');
  const [email, setEmail] = useState(admin?.email ?? '');
  // Effective, so an enforcing org shows the switch on and locked rather
  // than off-and-editable while login already forces MFA.
  const [mfa, setMfa] = useState(orgMfaRequired || (admin?.mfaEnabled ?? false));
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
            {/* Was labelled "MFA Enforced". It writes the per-user opt-in flag,
                not org enforcement — two different switches. */}
            <p className="text-sm font-medium text-slate-900">Two-factor authentication</p>
            <p className="text-xs text-slate-500 mt-0.5">
              {orgMfaRequired ? 'Required org-wide — cannot be turned off here.' : 'This admin’s own setting'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => { if (!orgMfaRequired) setMfa(!mfa); }}
            disabled={orgMfaRequired}
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
  const [confirmDelete, setConfirmDelete] = useState(false);

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
        {(user.role === 'ADMINISTRATOR') ? (
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
              onClick={() => setConfirmDelete(true)}
              disabled={removeMutation.isPending}>
              Remove
            </GlowButton>
          </div>
        )}
      </td>

      {/* Confirmation Modal */}
      <AnimatePresence>
        {confirmDelete && (
          <td style={{ position: 'fixed', inset: 0, zIndex: 50 }} className="flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 bg-black/30 backdrop-blur-sm"
              onClick={() => setConfirmDelete(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.18 }}
              className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden"
              style={{ margin: 'auto' }}
            >
              <div className="px-6 pt-6 pb-4 flex items-start gap-4">
                <div className="w-11 h-11 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-slate-900">Remove User</h3>
                  <p className="mt-1.5 text-sm text-slate-500 leading-relaxed">
                    Are you sure you want to remove <span className="font-semibold text-slate-700">{user.name}</span>?
                    This action cannot be undone.
                  </p>
                  <p className="mt-1 text-xs text-slate-400 font-mono">{user.email}</p>
                </div>
              </div>
              <div className="px-6 py-4 bg-slate-50/80 border-t border-slate-100 flex items-center justify-end gap-3">
                <GlowButton variant="ghost" onClick={() => setConfirmDelete(false)} disabled={removeMutation.isPending}>
                  Cancel
                </GlowButton>
                <GlowButton variant="danger" onClick={() => removeMutation.mutate()} disabled={removeMutation.isPending} loading={removeMutation.isPending}>
                  Yes, Remove
                </GlowButton>
              </div>
            </motion.div>
          </td>
        )}
      </AnimatePresence>
    </tr>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────
export default function OrgDetailPage() {
  const params = useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useAuth();
  const orgId = params?.['id'] as string;
  const [deleteOpen, setDeleteOpen] = useState(false);

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

  const serviceRenewMutation = useMutation({
    mutationFn: (id: string) => saasAdminApi.renewService(id, { months: 12 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-detail'] }),
  });
  const serviceRemoveMutation = useMutation({
    mutationFn: (id: string) => saasAdminApi.removeService(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-detail'] }),
  });

  // Add-a-service form (manual entry)
  const [svcName, setSvcName] = useState('');
  const [svcPrice, setSvcPrice] = useState('');
  const [svcEndDate, setSvcEndDate] = useState('');
  const [showCatalogPicker, setShowCatalogPicker] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const assignMutation = useMutation({
    mutationFn: () => saasAdminApi.assignService(orgId, { name: svcName.trim(), monthlyPrice: Number(svcPrice) || 0, endDate: svcEndDate }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['org-detail'] }); setSvcName(''); setSvcPrice(''); setSvcEndDate(''); setShowManualForm(false); },
  });

  if (isLoading || !data) {
    return (
      <RoleGuard allowedRoles={['ADMINISTRATOR']} permission="orgs.manage">
        <div className="flex h-screen overflow-hidden bg-canvas">
          <Sidebar />
          <main className="flex-1 overflow-y-auto">
            <div className="p-6 sm:p-8 max-w-[1600px] mx-auto space-y-6">
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
      <RoleGuard allowedRoles={['ADMINISTRATOR']} permission="orgs.manage">
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
    <RoleGuard allowedRoles={['ADMINISTRATOR']} permission="orgs.manage">
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-6 sm:p-8 max-w-[1600px] mx-auto space-y-6">

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
                <div className="flex items-center gap-2.5">
                  <GlowButton variant={org.suspended ? 'primary' : 'danger'}
                    onClick={async () => {
                      const ok = await confirm(org.suspended
                        ? { title: 'Restore organization', message: <>Restore access for <b>{org.name}</b>?</>, confirmText: 'Restore' }
                        : { title: 'Suspend organization', message: <><b>{org.name}</b> will be suspended and members will lose access.</>, confirmText: 'Suspend', variant: 'danger' });
                      if (ok) suspendMutation.mutate();
                    }}
                    disabled={suspendMutation.isPending} loading={suspendMutation.isPending}>
                    {org.suspended ? 'Restore Access' : 'Suspend Org'}
                  </GlowButton>
                  {can('orgs.delete') && (
                    <GlowButton variant="danger" onClick={() => setDeleteOpen(true)}>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                      Delete
                    </GlowButton>
                  )}
                </div>
              </div>
            </motion.div>

            {/* KPI strip */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.04 }}>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
                <StatCard label="Monthly Revenue" value={`₹${monthlyRevenue.toLocaleString()}`} tone="emerald" />
                <StatCard label="Annual Contract" value={`₹${org.contractValue.toLocaleString()}`} tone="violet" />
                <StatCard label="Services" value={org._count.services} tone="brand" />
                <StatCard label="Users" value={org._count.users} tone="amber" />
                <StatCard label="Health Score" value={org.healthScore} tone={org.healthScore >= 90 ? 'emerald' : org.healthScore >= 75 ? 'amber' : 'red'} />
              </div>
            </motion.div>

            {/* Two-col: Admin card + Org metadata */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.07 }} className="lg:col-span-2">
                <h2 className="text-base font-semibold text-slate-900 mb-4">Organization Admin</h2>
                <AdminCard admin={admin} orgMfaRequired={org.mfaRequired} onSaved={() => { /* react-query already invalidated */ }} />
              </motion.div>

              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.1 }}>
                <h2 className="text-base font-semibold text-slate-900 mb-4">Security Posture</h2>
                <div className="card p-5 space-y-4">
                  {/* Shown as two independent rows, an enforcing org whose admin
                      hadn't opted in read "MFA Enforced: Enabled / Admin has MFA:
                      Off" — a gap that does not exist, because login uses
                      `mfaEnabled || mfaRequired`. Qualify the second by the first. */}
                  <SecurityRow label="MFA enforced org-wide" enabled={org.mfaRequired} />
                  <SecurityRow
                    label={org.mfaRequired ? 'Admin signs in with MFA' : 'Admin opted in to MFA'}
                    enabled={mfaStatus({ mfaEnabled: admin?.mfaEnabled ?? false, customer: { mfaRequired: org.mfaRequired } }).on}
                  />
                  <div className="pt-3 border-t border-slate-100 space-y-1.5 text-sm">
                    <div className="flex justify-between"><span className="text-slate-500">Credit Limit</span><span className="font-mono tabular-nums font-semibold text-slate-900">{org.creditLimit.toLocaleString()}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Open Requests</span><span className="font-mono tabular-nums font-semibold text-slate-900">{org._count.requests}</span></div>
                  </div>
                  <OrgCodeRow orgId={orgId} current={org.orgCode} />
                </div>
              </motion.div>
            </div>

            {/* Services */}
            <motion.div id="services" className="scroll-mt-8" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.13 }}>
              <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                <h2 className="text-base font-semibold text-slate-900">Purchased Services</h2>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-400 tabular-nums">₹{monthlyRevenue.toLocaleString()}/mo  ·  {org.services.length} subscriptions</span>
                  <GlowButton variant="secondary" className="py-1.5 px-3 text-xs" onClick={() => { setShowCatalogPicker(true); setShowManualForm(false); }}>
                    <svg className="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
                    </svg>
                    From Catalog
                  </GlowButton>
                  <GlowButton className="py-1.5 px-3 text-xs" onClick={() => { setShowManualForm((v) => !v); setShowCatalogPicker(false); }}>
                    <svg className="w-3.5 h-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                    Add Manually
                  </GlowButton>
                </div>
              </div>

              {/* Manual add form */}
              <AnimatePresence>
                {showManualForm && (
                  <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }}>
                    <div className="card p-4 mb-4 flex flex-wrap items-end gap-3 border-brand/30 bg-brand-50/20">
                      <div className="flex-1 min-w-[200px]">
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Service name</label>
                        <input value={svcName} onChange={(e) => setSvcName(e.target.value)} placeholder="e.g. SIEM" className="input" />
                      </div>
                      <div className="w-32">
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">₹ / month</label>
                        <input type="number" min={0} value={svcPrice} onChange={(e) => setSvcPrice(e.target.value)} placeholder="0" className="input" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">End date</label>
                        <input type="date" value={svcEndDate} onChange={(e) => setSvcEndDate(e.target.value)} className="input" />
                      </div>
                      <GlowButton className="py-2 px-4 text-sm"
                        disabled={!svcName.trim() || !svcEndDate || assignMutation.isPending}
                        onClick={() => assignMutation.mutate()}>
                        {assignMutation.isPending ? 'Adding…' : 'Add service'}
                      </GlowButton>
                      <GlowButton variant="ghost" className="py-2 px-3 text-sm" onClick={() => setShowManualForm(false)}>Cancel</GlowButton>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="card overflow-hidden">
                {org.services.length === 0 ? (
                  <p className="px-5 py-6 text-sm text-slate-500">No services subscribed.</p>
                ) : (
                  <table className="min-w-full">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Service</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Ends</th>
                        <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Monthly</th>
                        <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {org.services.map((svc) => {
                        const cfg = serviceStatusConfig[svc.status] ?? serviceStatusConfig['ACTIVE']!;
                        const days = daysUntil(svc.endDate);
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
                              <p className="text-[11px] text-slate-400 mt-0.5">{new Date(svc.endDate).toLocaleDateString()}</p>
                            </td>
                            <td className="px-5 py-3.5 text-right font-mono tabular-nums text-sm font-semibold text-slate-900">
                              ₹{svc.monthlyPrice.toLocaleString()}
                            </td>
                            <td className="px-5 py-3.5 text-right whitespace-nowrap">
                              <GlowButton variant="secondary" className="py-1 px-2.5 text-xs mr-2"
                                onClick={() => serviceRenewMutation.mutate(svc.id)} disabled={serviceRenewMutation.isPending}>
                                Renew +12mo
                              </GlowButton>
                              <button type="button"
                                onClick={() => serviceRemoveMutation.mutate(svc.id)} disabled={serviceRemoveMutation.isPending}
                                className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-50 cursor-pointer">
                                Remove
                              </button>
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

      {/* Catalog picker modal */}
      <AnimatePresence>
        {showCatalogPicker && (
          <CatalogPickerModal orgId={orgId} onClose={() => setShowCatalogPicker(false)} />
        )}
      </AnimatePresence>

      {/* Delete organization (2-step confirmation) */}
      <AnimatePresence>
        {deleteOpen && (
          <DeleteOrgModal
            org={org}
            onClose={() => setDeleteOpen(false)}
            onDeleted={() => {
              setDeleteOpen(false);
              void qc.invalidateQueries({ queryKey: ['org-detail'] });
              void qc.invalidateQueries({ queryKey: ['saas-orgs-overview'] });
              void qc.invalidateQueries({ queryKey: ['saas-metrics'] });
              router.push('/saas-admin');
            }}
          />
        )}
      </AnimatePresence>
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

// Editable ticket org code (embedded in ticket numbers when the platform format
// includes it). ADMINISTRATOR-only page, so editing here is admin-only.
function OrgCodeRow({ orgId, current }: { orgId: string; current: string | null }) {
  const qc = useQueryClient();
  const [code, setCode] = useState(current ?? '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { setCode(current ?? ''); }, [current]);

  const mut = useMutation({
    mutationFn: () => saasAdminApi.updateOrg(orgId, { orgCode: code.trim() }),
    onSuccess: () => { setError(''); setSaved(true); qc.invalidateQueries({ queryKey: ['org-detail'] }); setTimeout(() => setSaved(false), 2000); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to save'),
  });

  const dirty = code.trim().length > 0 && code.trim().toUpperCase() !== (current ?? '').toUpperCase();

  return (
    <div className="pt-3 border-t border-slate-100">
      <label className="block text-sm text-slate-700 mb-1.5">Ticket org code</label>
      <div className="flex items-center gap-2">
        <input value={code} maxLength={8} onChange={(e) => setCode(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())}
          placeholder="e.g. DVB" className="input !py-1.5 text-sm font-mono" />
        <GlowButton className="py-1.5 px-3 text-xs" onClick={() => mut.mutate()} disabled={!dirty || mut.isPending} loading={mut.isPending}>Save</GlowButton>
      </div>
      <p className="text-[11px] text-slate-400 mt-1">Used in ticket numbers when the format includes the org code (e.g. TKT-{code || 'DVB'}-001).</p>
      {error && <p className="text-[11px] text-red-600 mt-1">{error}</p>}
      {saved && <p className="text-[11px] text-emerald-600 mt-1">Saved</p>}
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
