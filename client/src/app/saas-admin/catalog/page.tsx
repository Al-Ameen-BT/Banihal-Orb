'use client';

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { saasAdminApi } from '@/lib/api';
import type { CatalogMain, CatalogService } from '@/lib/schemas';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import GlowButton from '@/components/ui/GlowButton';

export default function CatalogPage() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['catalog'] });
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [mainName, setMainName] = useState('');
  const [mainDesc, setMainDesc] = useState('');
  const [mainPrice, setMainPrice] = useState('');

  const { data, isLoading } = useQuery<{ catalog: CatalogMain[] }>({
    queryKey: ['catalog'],
    queryFn: () => saasAdminApi.listCatalog().then((r) => r.data as { catalog: CatalogMain[] }),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (p: Record<string, unknown>) => saasAdminApi.createCatalog(p),
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

  const catalog = data?.catalog ?? [];

  const stats = useMemo(() => {
    const subs = catalog.reduce((n, m) => n + m.children.length, 0);
    const activeMains = catalog.filter((m) => m.active).length;
    const mrr = catalog.reduce((sum, m) => sum + (m.active ? m.monthlyPrice : 0), 0);
    return { mains: catalog.length, subs, activeMains, mrr };
  }, [catalog]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((m) =>
      m.name.toLowerCase().includes(q) ||
      (m.description ?? '').toLowerCase().includes(q) ||
      m.children.some((c) => c.name.toLowerCase().includes(q)),
    );
  }, [catalog, search]);

  function addMain() {
    if (!mainName.trim()) return;
    createMutation.mutate({
      name: mainName.trim(),
      description: mainDesc.trim() || undefined,
      monthlyPrice: Number(mainPrice) || 0,
    });
    setMainName(''); setMainDesc(''); setMainPrice(''); setShowAdd(false);
  }

  return (
    <RoleGuard allowedRoles={['SADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[1080px] mx-auto space-y-6">

            {/* Header */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}
              className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <p className="text-sm text-slate-500 mb-1">Platform</p>
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Service Catalog</h1>
                <p className="mt-1 text-sm text-slate-500">Define the main services and sub-services customers can subscribe to.</p>
              </div>
              <GlowButton onClick={() => setShowAdd((v) => !v)} className="flex-shrink-0">
                {showAdd ? 'Close' : '+ New main service'}
              </GlowButton>
            </motion.div>

            {/* Stats */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.04 }}
              className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatTile label="Main Services" value={stats.mains} tone="brand" />
              <StatTile label="Sub-Services"  value={stats.subs} tone="violet" />
              <StatTile label="Active"         value={stats.activeMains} tone="emerald" />
              <StatTile label="Catalog MRR"    value={`₹${stats.mrr.toLocaleString()}`} tone="amber" />
            </motion.div>

            {/* Add main service (collapsible) */}
            <AnimatePresence>
              {showAdd && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }} className="overflow-hidden">
                  <div className="card p-5">
                    <h2 className="text-sm font-semibold text-slate-900 mb-4">New main service</h2>
                    <div className="grid grid-cols-1 md:grid-cols-[1fr_140px] gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Name</label>
                        <input autoFocus value={mainName} onChange={(e) => setMainName(e.target.value)} placeholder="e.g. Managed XDR" className="input" />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">₹ / month</label>
                        <input type="number" min={0} value={mainPrice} onChange={(e) => setMainPrice(e.target.value)} placeholder="0" className="input" />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Description <span className="text-slate-300 normal-case">(optional)</span></label>
                        <input value={mainDesc} onChange={(e) => setMainDesc(e.target.value)} placeholder="Short summary of what this service covers" className="input" />
                      </div>
                    </div>
                    <div className="flex gap-2 mt-4">
                      <GlowButton onClick={addMain} disabled={!mainName.trim() || createMutation.isPending} loading={createMutation.isPending}>
                        Add service
                      </GlowButton>
                      <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm font-medium text-slate-500 hover:text-slate-800 cursor-pointer">Cancel</button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Search */}
            <div className="relative max-w-sm">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search services…" className="input pl-9 py-2 text-sm" />
            </div>

            {/* Catalog list */}
            {isLoading ? (
              <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="card h-20 animate-pulse bg-slate-50" />)}</div>
            ) : filtered.length === 0 ? (
              <div className="card p-12 text-center">
                <p className="text-sm text-slate-500">{search ? `No services match “${search}”.` : 'No services yet — add your first main service.'}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((main) => (
                  <CatalogCard key={main.id} main={main}
                    onToggle={(active) => toggleMutation.mutate({ id: main.id, active })}
                    onDelete={() => deleteMutation.mutate(main.id)}
                    onAddSub={(name, price) => createMutation.mutate({ name, parentId: main.id, monthlyPrice: price })}
                    onToggleSub={(id, active) => toggleMutation.mutate({ id, active })}
                    onDeleteSub={(id) => deleteMutation.mutate(id)}
                    busy={createMutation.isPending || toggleMutation.isPending || deleteMutation.isPending} />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </RoleGuard>
  );
}

function StatTile({ label, value, tone }: { label: string; value: number | string; tone: 'brand' | 'violet' | 'emerald' | 'amber' }) {
  const dot = { brand: 'bg-brand', violet: 'bg-violet-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500' }[tone];
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

function CatalogCard({ main, onToggle, onDelete, onAddSub, onToggleSub, onDeleteSub, busy }: {
  main: CatalogMain;
  onToggle: (active: boolean) => void;
  onDelete: () => void;
  onAddSub: (name: string, price: number) => void;
  onToggleSub: (id: string, active: boolean) => void;
  onDeleteSub: (id: string) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [subName, setSubName] = useState('');
  const [subPrice, setSubPrice] = useState('');
  const inUse = (main._count?.purchases ?? 0) > 0;

  function addSub() {
    if (!subName.trim()) return;
    onAddSub(subName.trim(), Number(subPrice) || 0);
    setSubName(''); setSubPrice('');
  }

  return (
    <div className={`card overflow-hidden transition-shadow ${main.active ? '' : 'opacity-75'}`}>
      {/* Header row */}
      <div className="flex items-center gap-3 px-5 py-4">
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer">
          <span className={`flex-shrink-0 w-1.5 h-9 rounded-full ${main.active ? 'bg-brand' : 'bg-slate-300'}`} />
          <svg className={`w-4 h-4 text-slate-400 transition-transform flex-shrink-0 ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-900 truncate">{main.name}</h3>
              <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${main.active ? 'text-emerald-700 bg-emerald-50' : 'text-slate-500 bg-slate-100'}`}>{main.active ? 'Active' : 'Inactive'}</span>
            </div>
            {main.description && <p className="text-xs text-slate-500 mt-0.5 truncate">{main.description}</p>}
          </div>
        </button>

        <div className="flex items-center gap-4 flex-shrink-0">
          <div className="text-right hidden sm:block">
            <p className="font-mono text-sm font-semibold text-slate-900 tabular-nums">₹{main.monthlyPrice.toLocaleString()}<span className="text-xs text-slate-400">/mo</span></p>
            <p className="text-[11px] text-slate-400">{main.children.length} sub-service{main.children.length === 1 ? '' : 's'}</p>
          </div>
          <button onClick={() => onToggle(!main.active)} disabled={busy}
            className="text-xs font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-50 cursor-pointer">
            {main.active ? 'Deactivate' : 'Activate'}
          </button>
          <button onClick={onDelete} disabled={inUse || busy} title={inUse ? 'Has customer purchases — cannot delete' : 'Delete'}
            className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
            Delete
          </button>
        </div>
      </div>

      {/* Expandable sub-services */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
            <div className="px-5 pb-5 pt-1 border-t border-slate-100 bg-slate-50/40">
              {main.children.length === 0 ? (
                <p className="text-xs text-slate-400 py-3">No sub-services yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100 mb-3">
                  {main.children.map((sub: CatalogService) => (
                    <li key={sub.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-1 h-1 rounded-full bg-slate-300 flex-shrink-0" />
                        <span className={`text-sm truncate ${sub.active ? 'text-slate-700' : 'text-slate-400 line-through'}`}>{sub.name}</span>
                        <span className="text-xs text-slate-400 font-mono flex-shrink-0">₹{sub.monthlyPrice.toLocaleString()}/mo</span>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <button onClick={() => onToggleSub(sub.id, !sub.active)} disabled={busy} className="text-xs text-slate-500 hover:text-slate-800 disabled:opacity-50 cursor-pointer">{sub.active ? 'Deactivate' : 'Activate'}</button>
                        <button onClick={() => onDeleteSub(sub.id)} disabled={(sub._count?.purchases ?? 0) > 0 || busy}
                          className="text-xs text-red-600 hover:text-red-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">Delete</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {/* Add sub-service */}
              <div className="flex flex-wrap items-center gap-2">
                <input value={subName} onChange={(e) => setSubName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addSub(); }}
                  placeholder="New sub-service name" className="input flex-1 min-w-[180px] !py-1.5 text-sm bg-white" />
                <input type="number" min={0} value={subPrice} onChange={(e) => setSubPrice(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addSub(); }}
                  placeholder="₹/mo" className="input w-28 !py-1.5 text-sm bg-white" />
                <button type="button" onClick={addSub} disabled={!subName.trim() || busy}
                  className="px-3 py-1.5 text-xs font-semibold text-brand border border-brand/30 rounded-lg hover:bg-brand/5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                  Add sub-service
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
