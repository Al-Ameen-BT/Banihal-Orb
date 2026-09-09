'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { adSecretsApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar, { icons } from '@/components/ui/Sidebar';
import { PageHeader } from '@/components/ui/PageHeader';
import GlowButton from '@/components/ui/GlowButton';
import { Shimmer } from '@/components/ui/Shimmer';
import type { AdCredentialDelivery } from '@/lib/schemas';

const STATUS_CFG: Record<string, { cls: string; label: string }> = {
  DELIVERED: { cls: 'text-emerald-700 bg-emerald-50 border-emerald-100', label: 'Ready to view' },
  VIEWED:    { cls: 'text-slate-600 bg-slate-100 border-slate-200',        label: 'Viewed' },
  EXPIRED:   { cls: 'text-red-700 bg-red-50 border-red-100',               label: 'Expired' },
  PENDING:   { cls: 'text-amber-700 bg-amber-50 border-amber-100',         label: 'Pending' },
};

function timeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `${h}h left`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m left`;
}

// One-time reveal modal — shows the password once, then it's gone.
function RevealModal({ delivery, onClose }: { delivery: AdCredentialDelivery; onClose: () => void }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState('');
  const revealMut = useMutation({
    mutationFn: () => adSecretsApi.reveal(delivery.id),
    onSuccess: (r) => { setPassword((r.data as { password: string }).password); void qc.invalidateQueries({ queryKey: ['ad-secrets'] }); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not reveal the credential.'),
  });

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="relative bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="p-6 space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Temporary password</p>
            <p className="text-sm text-slate-500 mt-0.5">Ticket <span className="font-mono font-semibold text-slate-700">{delivery.ticketNumber}</span> · {delivery.targetEmail}</p>
          </div>

          {!password ? (
            <>
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-3.5 py-2.5 text-sm text-amber-800">
                This can only be shown <strong>once</strong>. Reveal it only when you&apos;re ready to copy it — it&apos;s erased after viewing.
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex items-center gap-3">
                <GlowButton onClick={() => revealMut.mutate()} disabled={revealMut.isPending} loading={revealMut.isPending}>Reveal password</GlowButton>
                <GlowButton variant="ghost" onClick={onClose}>Cancel</GlowButton>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-lg bg-slate-900 text-slate-100 font-mono text-lg px-4 py-3 flex items-center gap-3 break-all">
                <span className="flex-1">{password}</span>
                <button type="button" onClick={() => navigator.clipboard?.writeText(password)} className="text-brand-200 hover:text-white text-sm cursor-pointer flex-shrink-0">Copy</button>
              </div>
              <p className="text-xs text-slate-400">Copy it now — this credential has been erased and cannot be shown again.</p>
              <GlowButton onClick={onClose} className="w-full">Done</GlowButton>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

export default function CredentialsPage() {
  const [revealing, setRevealing] = useState<AdCredentialDelivery | null>(null);
  const { data, isLoading } = useQuery<AdCredentialDelivery[]>({
    queryKey: ['ad-secrets'],
    queryFn: () => adSecretsApi.list().then((r) => (r.data as { deliveries: AdCredentialDelivery[] }).deliveries),
    refetchInterval: 15_000,
  });
  const deliveries = data ?? [];

  return (
    <RoleGuard allowedRoles={['USER', 'ORG_ADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[820px] mx-auto space-y-6">
            <PageHeader eyebrow="Security" title="Secure Credentials" icon={icons.key}
              subtitle="Temporary passwords delivered by an AD bot for your account or a request you raised. Each can be revealed once, then it's erased." />

            {isLoading ? (
              <div className="space-y-3">{[...Array(2)].map((_, i) => <Shimmer key={i} className="h-20 rounded-xl" />)}</div>
            ) : deliveries.length === 0 ? (
              <div className="card p-12 text-center">
                <p className="text-sm font-medium text-slate-700 mb-1">No credentials waiting</p>
                <p className="text-xs text-slate-400">When an AD bot delivers a temporary password for you, it appears here.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {deliveries.map((d) => {
                  const cfg = STATUS_CFG[d.status] ?? STATUS_CFG['PENDING']!;
                  return (
                    <div key={d.id} className="card p-4 flex items-center gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border ${cfg.cls}`}>{cfg.label}</span>
                          <span className="font-mono text-xs font-bold text-slate-400">{d.ticketNumber}</span>
                          {d.role === 'requester' && <span className="text-[10px] text-slate-400">(you requested this)</span>}
                        </div>
                        <p className="text-sm font-medium text-slate-800 mt-1 truncate">{d.targetEmail}</p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          {d.status === 'DELIVERED' ? timeLeft(d.expiresAt) : d.alreadyViewed ? 'you viewed this' : 'no longer available'}
                        </p>
                      </div>
                      <GlowButton className="py-1.5 px-4 text-sm flex-shrink-0" disabled={!d.canReveal} onClick={() => setRevealing(d)}>
                        {d.canReveal ? 'Reveal' : d.alreadyViewed ? 'Viewed' : 'Unavailable'}
                      </GlowButton>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
      <AnimatePresence>{revealing && <RevealModal delivery={revealing} onClose={() => setRevealing(null)} />}</AnimatePresence>
    </RoleGuard>
  );
}
