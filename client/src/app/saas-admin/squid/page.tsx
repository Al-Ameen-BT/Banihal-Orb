'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { squidAdminApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar, { icons } from '@/components/ui/Sidebar';
import { PageHeader } from '@/components/ui/PageHeader';
import GlowButton from '@/components/ui/GlowButton';
import { Shimmer } from '@/components/ui/Shimmer';
import { notify } from '@/lib/toast-bus';

interface ProxyRow {
  id: string;
  customerId: string;
  name: string;
  customer?: { name: string } | null;
  status: string;
  lastSeenAt: string | null;
  revision: number;
  appliedSeq: number;
  locked: boolean;
  createdAt: string;
  _count?: { branches: number };
}

interface Detail extends ProxyRow {
  description: string | null;
  transport: string;
  lastError: string | null;
  registrationHint: string | null;
  customer: { id: string; name: string } | null;
  customerService: { id: string; name: string; endDate: string } | null;
  branches: { id: string; name: string; mode: string; sources: string[] }[];
}

const STATUS_CFG: Record<string, { cls: string; label: string }> = {
  PENDING:       { cls: 'text-amber-700 bg-amber-50 border-amber-100', label: 'Awaiting agent' },
  CONNECTED:     { cls: 'text-emerald-700 bg-emerald-50 border-emerald-100', label: 'Agent connected' },
  DISABLED:      { cls: 'text-slate-600 bg-slate-100 border-slate-200', label: 'Disabled' },
  ERROR:         { cls: 'text-red-700 bg-red-50 border-red-100', label: 'Agent error' },
  UNPROVISIONED: { cls: 'text-slate-500 bg-slate-50 border-slate-200', label: 'No agent yet' },
  BLOCKED:       { cls: 'text-red-700 bg-red-50 border-red-100', label: 'Blocked' },
};

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export default function SquidAdminPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<ProxyRow | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  const { data, isLoading } = useQuery<{ proxies: ProxyRow[] }>({
    queryKey: ['squid-admin', status, search],
    queryFn: () => squidAdminApi.list({ status: status || undefined, search: search || undefined }).then((r) => r.data as { proxies: ProxyRow[] }),
    refetchInterval: 15_000,
  });
  const proxies = data?.proxies ?? [];

  const { data: detail } = useQuery<Detail>({
    queryKey: ['squid-admin-detail', open?.id],
    queryFn: () => squidAdminApi.get(open!.id).then((r) => r.data as Detail),
    enabled: !!open,
    refetchInterval: 8000,
  });

  const act = useMutation({
    mutationFn: ({ action }: { action: 'lock' | 'enable' | 'rotate' }) => {
      if (action === 'lock') return squidAdminApi.lock(open!.id);
      if (action === 'enable') return squidAdminApi.enable(open!.id);
      return squidAdminApi.rotateKey(open!.id);
    },
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: ['squid-admin'] });
      qc.invalidateQueries({ queryKey: ['squid-admin-detail', open?.id] });
      if (vars.action === 'rotate') setNewKey((res.data as { raw: string }).raw);
      else notify(vars.action === 'lock' ? 'Proxy locked — agents will be rejected' : 'Proxy enabled — agents can reconnect', 'success');
    },
    onError: (e: unknown) => setActionError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Action failed.'),
  });

  const row = open;

  return (
    <RoleGuard allowedRoles={['ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-6 sm:p-8 max-w-[1100px] mx-auto space-y-6">
            <PageHeader eyebrow="Platform" title="Squid Proxies" icon={icons.squid}
              subtitle="Cross-tenant view of every customer's outbound proxy. Read-only unless you hold squid.manage; edits are audited and password-protected staff actions." />

            <div className="flex items-center gap-3 flex-wrap">
              <select value={status} onChange={(e) => setStatus(e.target.value)} className="input py-2 text-sm w-auto">
                <option value="">All statuses</option>
                <option value="PENDING">Awaiting agent</option>
                <option value="CONNECTED">Agent connected</option>
                <option value="UNPROVISIONED">No agent yet</option>
                <option value="DISABLED">Disabled</option>
                <option value="ERROR">Agent error</option>
                <option value="BLOCKED">Blocked</option>
              </select>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by proxy name or org…"
                className="input py-2 text-sm flex-1 min-w-[220px]"
              />
            </div>

            {isLoading ? (
              <div className="space-y-3">{[...Array(3)].map((_, i) => <Shimmer key={i} className="h-20 rounded-xl" />)}</div>
            ) : proxies.length === 0 ? (
              <div className="card p-12 text-center">
                <p className="text-sm font-medium text-slate-700 mb-1">No proxies match</p>
                <p className="text-xs text-slate-400">Customers provision a squid proxy when a catalog service of kind SQUID_PROXY is assigned.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {proxies.map((p) => {
                  const cfg = STATUS_CFG[p.status] ?? STATUS_CFG['UNPROVISIONED']!;
                  return (
                    <button key={p.id} type="button" onClick={() => setOpen(p)} className="w-full text-left card p-4 flex items-center gap-4 hover:border-brand-200 transition-colors cursor-pointer">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-slate-900">{p.name}</p>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border ${cfg.cls}`}>{cfg.label}</span>
                          {p.locked && <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border text-red-700 bg-red-50 border-red-100">Locked</span>}
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5 truncate">
                          {p.customer?.name ?? `org ${p.customerId.slice(0, 8)}`}{p._count ? ` · ${p._count.branches} branches` : ''}
                        </p>
                        <p className="text-[11px] text-slate-400 mt-1">last seen {ago(p.lastSeenAt)} · rev {p.revision} / {p.appliedSeq} applied</p>
                      </div>
                      <p className="font-mono text-[10px] text-slate-400 flex-shrink-0">{p.customerId.slice(0, 8)}…</p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>

      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => { setOpen(null); setNewKey(null); setActionError(''); }} />
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="relative bg-white rounded-2xl shadow-xl w-full max-w-xl flex flex-col max-h-[86vh]">
              <div className="px-6 py-4 border-b border-slate-100 flex items-start justify-between flex-shrink-0">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-base font-semibold text-slate-900">{row?.name ?? 'Proxy'}</h2>
                    {row && (() => { const c = STATUS_CFG[row.status] ?? STATUS_CFG['UNPROVISIONED']!; return (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border ${c.cls}`}>{c.label}</span>
                    ); })()}
                    {row?.locked && <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border text-red-700 bg-red-50 border-red-100">Locked</span>}
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {detail?.customerService
                      ? `Provisioned via ${detail.customerService.name} — expires ${new Date(detail.customerService.endDate).toLocaleDateString()}`
                      : (detail?.description ?? 'Self-managed / trial')}
                    {detail?.customer?.name ? ` · ${detail.customer.name}` : ''}
                  </p>
                </div>
                <button onClick={() => { setOpen(null); setNewKey(null); setActionError(''); }} className="text-slate-400 hover:text-slate-600 transition-colors cursor-pointer ml-4 flex-shrink-0" aria-label="Close">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-4 text-sm">
                {!detail ? (
                  <p className="text-slate-400">Loading…</p>
                ) : (
                  <>
                    <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4 grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <p className="text-slate-400 uppercase tracking-wider font-semibold mb-0.5">Revision</p>
                        <p className="font-mono text-slate-800">{detail.revision}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 uppercase tracking-wider font-semibold mb-0.5">Applied seq</p>
                        <p className="font-mono text-slate-800">{detail.appliedSeq}{detail.appliedSeq >= detail.revision && detail.revision > 0 ? ' (current ✓)' : ''}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 uppercase tracking-wider font-semibold mb-0.5">Last seen</p>
                        <p className="text-slate-800">{ago(detail.lastSeenAt)}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 uppercase tracking-wider font-semibold mb-0.5">Key hint</p>
                        <p className="font-mono text-slate-800">{detail.registrationHint ?? '—'}</p>
                      </div>
                    </div>

                    {detail.lastError && (
                      <div className="rounded-lg bg-red-50 border border-red-100 px-3.5 py-2.5 text-xs text-red-700 font-mono break-all">{detail.lastError}</div>
                    )}

                    <div>
                      <p className="text-slate-400 uppercase tracking-wider font-semibold mb-1.5 text-xs">Branches ({detail.branches.length})</p>
                      {detail.branches.length === 0 ? (
                        <p className="text-slate-400 text-xs">No branches — the agent is pulling an empty config.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {detail.branches.map((b) => (
                            <div key={b.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 text-xs">
                              <span className="font-medium text-slate-700">{b.name}</span>
                              <span className="text-slate-400">
                                <span className={b.mode === 'EXCLUSIVE' ? 'text-red-600 font-semibold' : ''}>{b.mode}</span>
                                {' · '}{b.sources.length} sources
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {actionError && <p className="text-sm text-red-600">{actionError}</p>}
                  </>
                )}
              </div>

              <div className="px-6 py-4 border-t border-slate-100 flex items-center gap-3 flex-shrink-0 flex-wrap">
                {newKey && (
                  <div className="w-full rounded-lg bg-slate-900 text-slate-100 font-mono text-sm px-4 py-3 flex items-center gap-3 break-all mb-1">
                    <span className="flex-1">{newKey}</span>
                    <button type="button" onClick={() => navigator.clipboard?.writeText(newKey)} className="text-brand-200 hover:text-white text-sm cursor-pointer flex-shrink-0">Copy</button>
                  </div>
                )}
                {!detail?.locked && (
                  <GlowButton variant="danger" onClick={() => act.mutate({ action: 'lock' })} disabled={act.isPending} loading={act.isPending}>Lock proxy</GlowButton>
                )}
                {detail?.locked && (
                  <GlowButton variant="primary" onClick={() => act.mutate({ action: 'enable' })} disabled={act.isPending} loading={act.isPending}>Enable proxy</GlowButton>
                )}
                <GlowButton variant="secondary" onClick={() => act.mutate({ action: 'rotate' })} disabled={act.isPending} loading={act.isPending}>{newKey ? 'Rotate again' : 'Rotate agent key'}</GlowButton>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </RoleGuard>
  );
}