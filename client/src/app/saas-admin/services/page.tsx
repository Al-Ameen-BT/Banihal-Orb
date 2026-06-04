'use client';

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { saasAdminApi } from '@/lib/api';
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

export default function CustomerServicesPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status | 'ALL'>('ALL');
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery<{ services: AdminCustomerService[]; total: number }>({
    queryKey: ['admin-services', status],
    queryFn: () => saasAdminApi.listServices(status === 'ALL' ? {} : { status }).then((r) => r.data as { services: AdminCustomerService[]; total: number }),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const renewMutation = useMutation({
    mutationFn: (id: string) => saasAdminApi.renewService(id, { months: 12 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-services'] }),
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => saasAdminApi.removeService(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-services'] }),
  });

  const allServices = data?.services ?? [];
  const services = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allServices;
    return allServices.filter((s) => s.customer.name.toLowerCase().includes(q) || s.serviceName.toLowerCase().includes(q));
  }, [allServices, search]);

  return (
    <RoleGuard allowedRoles={['SADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[1100px] mx-auto space-y-6">

            {/* Header */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}
              className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <p className="text-sm text-slate-500 mb-1">Platform</p>
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Customer Services</h1>
                <p className="mt-1 text-sm text-slate-500">Every customer&apos;s purchased services — manage renewals and expiries.</p>
              </div>
              <Link href="/saas-admin/catalog" className="flex-shrink-0">
                <GlowButton variant="secondary">Manage Catalog →</GlowButton>
              </Link>
            </motion.div>

            {/* Filters + search */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.04 }}
              className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex gap-2">
                {(['ALL', 'ACTIVE', 'EXPIRING', 'EXPIRED'] as const).map((s) => (
                  <button key={s} onClick={() => setStatus(s)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-colors cursor-pointer ${
                      status === s ? 'bg-brand text-white border-brand' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}>
                    {s === 'ALL' ? 'All' : statusConfig[s].label}
                  </button>
                ))}
              </div>
              <div className="relative max-w-xs flex-1 min-w-[180px]">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customer or service…" className="input pl-9 py-1.5 text-sm" />
              </div>
            </motion.div>

            {/* Table */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.07 }}>
              <div className="card overflow-hidden">
                {isLoading ? (
                  <p className="px-5 py-10 text-center text-sm text-slate-400">Loading…</p>
                ) : services.length === 0 ? (
                  <p className="px-5 py-10 text-center text-sm text-slate-500">{search ? `No services match “${search}”.` : 'No services in this filter.'}</p>
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
                            <td className="px-5 py-3.5 text-right font-mono tabular-nums text-sm font-semibold text-slate-900">₹{s.monthlyPrice.toLocaleString()}</td>
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
            </motion.div>

          </div>
        </main>
      </div>
    </RoleGuard>
  );
}
