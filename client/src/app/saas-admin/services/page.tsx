'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { saasAdminApi } from '@/lib/api';
import type { CatalogMain } from '@/lib/schemas';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import GlowButton from '@/components/ui/GlowButton';

type Status = 'ACTIVE' | 'EXPIRING' | 'EXPIRED';

interface AdminCustomerService {
  id: string;
  serviceName: string;
  monthlyPrice: number;
  purchaseDate: string;
  endDate: string;
  status: Status;
  customer: { id: string; name: string; plan: string; industry: string | null };
}

const statusConfig: Record<Status, { cls: string; dot: string; label: string }> = {
  ACTIVE:   { cls: 'text-emerald-700 bg-emerald-50', dot: 'bg-emerald-500', label: 'Active' },
  EXPIRING: { cls: 'text-amber-700 bg-amber-50',     dot: 'bg-amber-500',   label: 'Expiring' },
  EXPIRED:  { cls: 'text-red-700 bg-red-50',         dot: 'bg-red-500',     label: 'Expired' },
};

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000);
}

export default function SaasServicesPage() {
  const [tab, setTab] = useState<'subscriptions' | 'catalog'>('subscriptions');

  return (
    <RoleGuard allowedRoles={['SADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[1200px] mx-auto space-y-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
              <p className="text-sm text-slate-500 mb-1">Platform</p>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Services</h1>
              <p className="mt-1 text-sm text-slate-500">Manage the service catalog and every customer&apos;s purchased services, renewals, and expiries.</p>
            </motion.div>

            <div className="flex gap-2 border-b border-slate-200">
              <TabButton active={tab === 'subscriptions'} onClick={() => setTab('subscriptions')}>Customer Services</TabButton>
              <TabButton active={tab === 'catalog'} onClick={() => setTab('catalog')}>Catalog</TabButton>
            </div>

            {tab === 'subscriptions' ? <SubscriptionsTab /> : <CatalogTab />}
          </div>
        </main>
      </div>
    </RoleGuard>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 transition-colors cursor-pointer ${
        active ? 'border-brand text-brand' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
      {children}
    </button>
  );
}

// ─── Customer services (expiry management) ──────────────────────────────────
function SubscriptionsTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status | 'ALL'>('ALL');

  const { data, isLoading } = useQuery<{ services: AdminCustomerService[]; total: number }>({
    queryKey: ['admin-services', status],
    queryFn: () => saasAdminApi.listServices(status === 'ALL' ? {} : { status }).then((r) => r.data as { services: AdminCustomerService[]; total: number }),
    staleTime: 15_000,
  });

  const renewMutation = useMutation({
    mutationFn: (id: string) => saasAdminApi.renewService(id, { months: 12 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-services'] }),
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => saasAdminApi.removeService(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-services'] }),
  });

  const services = data?.services ?? [];

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(['ALL', 'ACTIVE', 'EXPIRING', 'EXPIRED'] as const).map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-colors cursor-pointer ${
              status === s ? 'bg-brand text-white border-brand' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}>
            {s === 'ALL' ? 'All' : statusConfig[s].label}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <p className="px-5 py-8 text-center text-sm text-slate-400">Loading…</p>
        ) : services.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">No services in this filter.</p>
        ) : (
          <table className="min-w-full">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Customer</th>
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Service</th>
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</th>
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Ends</th>
                <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Monthly</th>
                <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Actions</th>
              </tr>
            </thead>
            <tbody>
              {services.map((s) => {
                const cfg = statusConfig[s.status];
                const days = daysUntil(s.endDate);
                const dayColor = days < 0 ? 'text-red-600' : days < 30 ? 'text-amber-600' : 'text-slate-500';
                return (
                  <tr key={s.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-5 py-3.5">
                      <Link href={`/saas-admin/orgs/${s.customer.id}`} className="text-sm font-medium text-slate-900 hover:text-brand">{s.customer.name}</Link>
                      <p className="text-[11px] text-slate-400">{s.customer.industry ?? s.customer.plan}</p>
                    </td>
                    <td className="px-5 py-3.5 text-sm text-slate-700">{s.serviceName}</td>
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold ${cfg.cls}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />{cfg.label}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`text-xs font-mono tabular-nums font-semibold ${dayColor}`}>{days < 0 ? `${Math.abs(days)}d ago` : `in ${days}d`}</span>
                      <p className="text-[11px] text-slate-400">{new Date(s.endDate).toLocaleDateString()}</p>
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono tabular-nums text-sm font-semibold text-slate-900">${s.monthlyPrice.toLocaleString()}</td>
                    <td className="px-5 py-3.5 text-right whitespace-nowrap">
                      <GlowButton variant="secondary" className="py-1 px-2.5 text-xs mr-2"
                        onClick={() => renewMutation.mutate(s.id)} disabled={renewMutation.isPending}>Renew +12mo</GlowButton>
                      <button type="button" onClick={() => removeMutation.mutate(s.id)} disabled={removeMutation.isPending}
                        className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-50 cursor-pointer">Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Service catalog management ─────────────────────────────────────────────
function CatalogTab() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['catalog'] });

  const { data, isLoading } = useQuery<{ catalog: CatalogMain[] }>({
    queryKey: ['catalog'],
    queryFn: () => saasAdminApi.listCatalog().then((r) => r.data as { catalog: CatalogMain[] }),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => saasAdminApi.createCatalog(payload),
    onSuccess: invalidate,
  });
  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => saasAdminApi.updateCatalog(id, { active }),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => saasAdminApi.deleteCatalog(id),
    onSuccess: invalidate,
  });

  const [mainName, setMainName] = useState('');
  const [mainPrice, setMainPrice] = useState('');

  const catalog = data?.catalog ?? [];

  return (
    <div className="space-y-4">
      {/* Add main service */}
      <div className="card p-4 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">New main service</label>
          <input value={mainName} onChange={(e) => setMainName(e.target.value)} placeholder="e.g. Managed XDR" className="input" />
        </div>
        <div className="w-32">
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">$/mo</label>
          <input type="number" min={0} value={mainPrice} onChange={(e) => setMainPrice(e.target.value)} placeholder="0" className="input" />
        </div>
        <GlowButton className="py-2 px-4 text-sm" disabled={!mainName || createMutation.isPending}
          onClick={() => { createMutation.mutate({ name: mainName, monthlyPrice: Number(mainPrice) || 0 }); setMainName(''); setMainPrice(''); }}>
          Add main service
        </GlowButton>
      </div>

      {isLoading ? (
        <p className="px-5 py-8 text-center text-sm text-slate-400">Loading catalog…</p>
      ) : (
        <div className="space-y-4">
          {catalog.map((main) => (
            <MainServiceCard key={main.id} main={main}
              onToggle={(active) => toggleMutation.mutate({ id: main.id, active })}
              onDelete={() => deleteMutation.mutate(main.id)}
              onAddSub={(name, price) => createMutation.mutate({ name, parentId: main.id, monthlyPrice: price })}
              onToggleSub={(id, active) => toggleMutation.mutate({ id, active })}
              onDeleteSub={(id) => deleteMutation.mutate(id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function MainServiceCard({ main, onToggle, onDelete, onAddSub, onToggleSub, onDeleteSub }: {
  main: CatalogMain;
  onToggle: (active: boolean) => void;
  onDelete: () => void;
  onAddSub: (name: string, price: number) => void;
  onToggleSub: (id: string, active: boolean) => void;
  onDeleteSub: (id: string) => void;
}) {
  const [subName, setSubName] = useState('');
  const [subPrice, setSubPrice] = useState('');
  const inUse = (main._count?.purchases ?? 0) > 0;

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-slate-900">{main.name}</h3>
            <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${main.active ? 'text-emerald-700 bg-emerald-50' : 'text-slate-500 bg-slate-100'}`}>{main.active ? 'Active' : 'Inactive'}</span>
            <span className="text-xs text-slate-400 font-mono">${main.monthlyPrice.toLocaleString()}/mo</span>
          </div>
          {main.description && <p className="text-xs text-slate-500 mt-0.5">{main.description}</p>}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <button onClick={() => onToggle(!main.active)} className="text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer">{main.active ? 'Deactivate' : 'Activate'}</button>
          <button onClick={onDelete} disabled={inUse} title={inUse ? 'Has customer purchases' : 'Delete'}
            className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">Delete</button>
        </div>
      </div>

      {/* Sub-services */}
      <div className="pl-4 border-l-2 border-slate-100 space-y-1.5">
        {main.children.length === 0 && <p className="text-xs text-slate-400">No sub-services yet.</p>}
        {main.children.map((sub) => (
          <div key={sub.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-slate-700">{sub.name} <span className="text-xs text-slate-400 font-mono">${sub.monthlyPrice.toLocaleString()}/mo</span>{!sub.active && <span className="ml-2 text-[10px] text-slate-400 uppercase">inactive</span>}</span>
            <span className="flex items-center gap-3 flex-shrink-0">
              <button onClick={() => onToggleSub(sub.id, !sub.active)} className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer">{sub.active ? 'Deactivate' : 'Activate'}</button>
              <button onClick={() => onDeleteSub(sub.id)} disabled={(sub._count?.purchases ?? 0) > 0}
                className="text-xs text-red-600 hover:text-red-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">Delete</button>
            </span>
          </div>
        ))}
      </div>

      {/* Add sub-service */}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <input value={subName} onChange={(e) => setSubName(e.target.value)} placeholder="New sub-service" className="input flex-1 min-w-[160px] !py-1.5 text-sm" />
        <input type="number" min={0} value={subPrice} onChange={(e) => setSubPrice(e.target.value)} placeholder="$/mo" className="input w-24 !py-1.5 text-sm" />
        <button type="button" disabled={!subName}
          onClick={() => { onAddSub(subName, Number(subPrice) || 0); setSubName(''); setSubPrice(''); }}
          className="px-3 py-1.5 text-xs font-semibold text-brand border border-brand/30 rounded-lg hover:bg-brand/5 disabled:opacity-40 cursor-pointer">
          Add sub
        </button>
      </div>
    </div>
  );
}
