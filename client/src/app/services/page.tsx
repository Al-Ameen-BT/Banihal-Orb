'use client';

import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { orgsApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import type { Customer, OrganizationService } from '@/lib/schemas';

const statusConfig: Record<string, { cls: string; dot: string; label: string }> = {
  ACTIVE:    { cls: 'text-emerald-700 bg-emerald-50', dot: 'bg-emerald-500', label: 'Active' },
  EXPIRING:  { cls: 'text-amber-700 bg-amber-50',     dot: 'bg-amber-500',   label: 'Expiring' },
  EXPIRED:   { cls: 'text-red-700 bg-red-50',         dot: 'bg-red-500',     label: 'Expired' },
  SUSPENDED: { cls: 'text-slate-600 bg-slate-100',    dot: 'bg-slate-400',   label: 'Suspended' },
};

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000);
}

export default function ServicesPage() {
  const { data: org } = useQuery<Customer>({
    queryKey: ['org'],
    queryFn: () => orgsApi.getMe().then((r) => r.data as Customer),
    staleTime: 60_000,
  });

  const { data: servicesData, isLoading } = useQuery<{ services: OrganizationService[]; monthlyTotal: number }>({
    queryKey: ['my-services'],
    queryFn: () => orgsApi.getServices().then((r) => r.data as { services: OrganizationService[]; monthlyTotal: number }),
    staleTime: 30_000,
  });

  const services = servicesData?.services ?? [];
  const monthlyTotal = servicesData?.monthlyTotal ?? 0;
  const activeCount   = services.filter((s) => s.status === 'ACTIVE' && s.enabled).length;
  const expiringCount = services.filter((s) => s.status === 'EXPIRING').length;
  const issuesCount   = services.filter((s) => s.status === 'EXPIRED' || s.status === 'SUSPENDED' || !s.enabled).length;

  return (
    <RoleGuard allowedRoles={['ORG_ADMIN', 'SADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[1200px] mx-auto space-y-8">

            {/* Header */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
              <p className="text-sm text-slate-500 mb-1">Subscriptions</p>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Services</h1>
              {org && (
                <p className="mt-1 text-sm text-slate-500">
                  Active subscriptions for <span className="font-semibold text-slate-700">{org.name}</span>
                </p>
              )}
            </motion.div>

            {/* Summary tiles */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.04 }}>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <SummaryTile label="Active"        value={activeCount}   tone="emerald" />
                <SummaryTile label="Expiring Soon" value={expiringCount} tone="amber" />
                <SummaryTile label="Action Needed" value={issuesCount}   tone="red" />
                <SummaryTile label="Monthly Cost"  value={`$${monthlyTotal.toLocaleString()}`} tone="brand" />
              </div>
            </motion.div>

            {/* Services table */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.1 }}>
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-base font-semibold text-slate-900">Subscribed Services</h2>
                <span className="text-xs text-slate-400 tabular-nums">${monthlyTotal.toLocaleString()}/mo · {services.length} services</span>
              </div>

              <div className="card overflow-hidden">
                {isLoading ? (
                  <div className="p-8 text-center text-sm text-slate-400">Loading subscriptions…</div>
                ) : services.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-500">
                    No services subscribed yet. Contact the platform team to get started.
                  </div>
                ) : (
                  <table className="min-w-full">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Service</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</th>
                        <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Renews</th>
                        <th className="px-5 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Monthly</th>
                      </tr>
                    </thead>
                    <tbody>
                      {services.map((svc) => {
                        const cfg = statusConfig[svc.status] ?? statusConfig['ACTIVE']!;
                        const days = daysUntil(svc.renewsAt);
                        const dayColor = days < 0 ? 'text-red-600' : days < 30 ? 'text-amber-600' : 'text-slate-500';
                        return (
                          <tr key={svc.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                            <td className="px-5 py-3.5">
                              <p className="text-sm font-medium text-slate-900 leading-tight">{svc.name}</p>
                              {svc.description && <p className="text-xs text-slate-500 mt-0.5 max-w-md truncate">{svc.description}</p>}
                            </td>
                            <td className="px-5 py-3.5">
                              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold ${cfg.cls}`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                                {cfg.label}
                              </span>
                              {!svc.enabled && <span className="ml-2 text-[11px] font-semibold text-red-600">DISABLED</span>}
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
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              <p className="mt-3 text-xs text-slate-400">
                Service enable/disable and renewal management is handled by your platform team. Open a ticket to request changes.
              </p>
            </motion.div>

          </div>
        </main>
      </div>
    </RoleGuard>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number | string; tone: 'emerald' | 'amber' | 'red' | 'brand' }) {
  const dot = { emerald: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', brand: 'bg-brand' }[tone];
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
