'use client';

import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { orgsApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import { ShimmerCard } from '@/components/ui/Shimmer';
import { useAuth } from '@/contexts/AuthContext';
import type { Customer, OrganizationService } from '@/lib/schemas';

// ─── Status config (light theme) ────────────────────────────────────────────
const statusConfig: Record<string, { cls: string; dot: string; label: string }> = {
  ACTIVE:    { cls: 'text-emerald-700 bg-emerald-50', dot: 'bg-emerald-500', label: 'Active' },
  EXPIRING:  { cls: 'text-amber-700 bg-amber-50',     dot: 'bg-amber-500',   label: 'Expiring Soon' },
  EXPIRED:   { cls: 'text-red-700 bg-red-50',         dot: 'bg-red-500',     label: 'Expired' },
  SUSPENDED: { cls: 'text-slate-600 bg-slate-100',    dot: 'bg-slate-400',   label: 'Suspended' },
};

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000);
}

function ServiceCard({ svc }: { svc: OrganizationService }) {
  const cfg = statusConfig[svc.status] ?? statusConfig['ACTIVE']!;
  const days = daysUntil(svc.renewsAt);
  const renewalLabel = days < 0 ? `Expired ${Math.abs(days)}d ago` : days === 0 ? 'Renews today' : `Renews in ${days}d`;
  const renewalColor = days < 0 ? 'text-red-600' : days < 30 ? 'text-amber-600' : 'text-slate-500';
  const isDimmed = svc.status === 'EXPIRED' || svc.status === 'SUSPENDED' || !svc.enabled;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className={`card p-5 ${isDimmed ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 leading-tight">{svc.name}</p>
          {svc.description && <p className="text-xs text-slate-500 mt-1 line-clamp-2">{svc.description}</p>}
        </div>
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold flex-shrink-0 ${cfg.cls}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
          {cfg.label}
        </span>
      </div>
      <div className="flex items-center justify-between pt-3 border-t border-slate-100">
        <span className={`text-xs font-mono tabular-nums font-semibold ${renewalColor}`}>{renewalLabel}</span>
        <span className="text-xs font-mono tabular-nums text-slate-500">${svc.monthlyPrice.toLocaleString()}/mo</span>
      </div>
      {!svc.enabled && (
        <p className="mt-2 text-[11px] font-medium text-red-600">⚠ Disabled by platform admin</p>
      )}
    </motion.div>
  );
}

export default function UserDashboard() {
  const { user } = useAuth();

  const { data: org } = useQuery<Customer>({
    queryKey: ['org'],
    queryFn: () => orgsApi.getMe().then((r) => r.data as Customer),
    staleTime: 60_000,
  });

  const { data: servicesData, isLoading: servicesLoading } = useQuery<{ services: OrganizationService[]; monthlyTotal: number }>({
    queryKey: ['my-services'],
    queryFn: () => orgsApi.getServices().then((r) => r.data as { services: OrganizationService[]; monthlyTotal: number }),
    staleTime: 30_000,
  });

  const hour = new Date().getHours();
  const timeLabel = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

  const services = servicesData?.services ?? [];
  const activeCount   = services.filter((s) => s.status === 'ACTIVE' && s.enabled).length;
  const expiringCount = services.filter((s) => s.status === 'EXPIRING').length;
  const expiredCount  = services.filter((s) => s.status === 'EXPIRED' || s.status === 'SUSPENDED').length;

  return (
    <RoleGuard allowedRoles={['USER', 'ORG_ADMIN', 'SADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[1200px] mx-auto space-y-8">

            {/* Greeting */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
              <p className="text-sm text-slate-500 mb-1">Good {timeLabel},</p>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">{user?.name}</h1>
              {org && (
                <p className="mt-1 text-sm text-slate-500">
                  Member of <span className="font-semibold text-slate-700">{org.name}</span>
                </p>
              )}
            </motion.div>

            {/* Org overview strip */}
            {org && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.04 }} className="card p-5 flex items-center gap-6 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-brand-50 border border-brand-100 flex items-center justify-center">
                    <svg className="w-5 h-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M3 3h12m-.75 4.5H21" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{org.name}</p>
                    <p className="text-xs text-slate-500">{org.plan} Plan</p>
                  </div>
                </div>
                <div className="h-8 w-px bg-slate-200" />
                <div className="flex items-center gap-6 text-sm">
                  <div><span className="text-slate-400">SSO</span> <span className={`ml-1 font-semibold ${org.ssoEnabled ? 'text-emerald-600' : 'text-slate-400'}`}>{org.ssoEnabled ? 'Enabled' : 'Off'}</span></div>
                  <div><span className="text-slate-400">MFA</span> <span className={`ml-1 font-semibold ${org.mfaRequired ? 'text-emerald-600' : 'text-slate-400'}`}>{org.mfaRequired ? 'Required' : 'Optional'}</span></div>
                </div>
              </motion.div>
            )}

            {/* Service summary stats */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.07 }}>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatTile label="Active Services" value={activeCount}  tone="emerald" />
                <StatTile label="Expiring Soon"   value={expiringCount} tone="amber" />
                <StatTile label="Expired"         value={expiredCount}  tone="red" />
                <StatTile label="Monthly Cost"    value={`$${(servicesData?.monthlyTotal ?? 0).toLocaleString()}`} tone="brand" />
              </div>
            </motion.div>

            {/* Subscribed services */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.1 }}>
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-base font-semibold text-slate-900">Your Cybersecurity Services</h2>
                <span className="text-xs text-slate-400">{services.length} subscriptions</span>
              </div>
              {servicesLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {Array.from({ length: 6 }).map((_, i) => <ShimmerCard key={i} />)}
                </div>
              ) : services.length === 0 ? (
                <div className="card p-8 text-center text-sm text-slate-500">
                  No services subscribed yet. Contact your organization admin to get started.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {services.map((svc) => <ServiceCard key={svc.id} svc={svc} />)}
                </div>
              )}
            </motion.div>

          </div>
        </main>
      </div>
    </RoleGuard>
  );
}

function StatTile({ label, value, tone }: { label: string; value: number | string; tone: 'emerald' | 'amber' | 'red' | 'brand' }) {
  const dot = { emerald: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', brand: 'bg-brand' }[tone];
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">{label}</p>
        <span className={`w-2 h-2 rounded-full ${dot}`} />
      </div>
      <p className="font-mono text-[2rem] font-bold text-slate-900 tabular-nums leading-none">{value}</p>
    </div>
  );
}
