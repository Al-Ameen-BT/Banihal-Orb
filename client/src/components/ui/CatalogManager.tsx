'use client';

import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { saasAdminApi } from '@/lib/api';
import type { CatalogMain, CatalogService } from '@/lib/schemas';
import GlowButton from '@/components/ui/GlowButton';

/**
 * Self-contained "Service Catalog" control: a button that opens a modal with the
 * full catalog editor (main services → sub-services, prices, activate/delete).
 * Drop <CatalogManager /> anywhere a SAAS_ADMIN can reach.
 */
export default function CatalogManager({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <GlowButton variant="secondary" onClick={() => setOpen(true)} className={className}>
        Service Catalog
      </GlowButton>
      <CatalogModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function CatalogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['catalog'] });
  const [search, setSearch] = useState('');
  const [mainName, setMainName] = useState('');
  const [mainDesc, setMainDesc] = useState('');
  const [mainPrice, setMainPrice] = useState('');

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const { data, isLoading } = useQuery<{ catalog: CatalogMain[] }>({
    queryKey: ['catalog'],
    queryFn: () => saasAdminApi.listCatalog().then((r) => r.data as { catalog: CatalogMain[] }),
    enabled: open,
    staleTime: 30_000,
  });

  const createMutation = useMutation({ mutationFn: (p: Record<string, unknown>) => saasAdminApi.createCatalog(p), onSuccess: invalidate });
  const toggleMutation = useMutation({ mutationFn: ({ id, active }: { id: string; active: boolean }) => saasAdminApi.updateCatalog(id, { active }), onSuccess: invalidate });
  const deleteMutation = useMutation({ mutationFn: (id: string) => saasAdminApi.deleteCatalog(id), onSuccess: invalidate });

  const catalog = data?.catalog ?? [];
  const stats = useMemo(() => {
    const subs = catalog.reduce((n, m) => n + m.children.length, 0);
    const mrr = catalog.reduce((sum, m) => sum + (m.active ? m.monthlyPrice : 0), 0);
    return { mains: catalog.length, subs, mrr };
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
    createMutation.mutate({ name: mainName.trim(), description: mainDesc.trim() || undefined, monthlyPrice: Number(mainPrice) || 0 });
    setMainName(''); setMainDesc(''); setMainPrice('');
  }

  const busy = createMutation.isPending || toggleMutation.isPending || deleteMutation.isPending;

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8">
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />

          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: 10 }}
            transition={{ duration: 0.18 }}
            className="relative w-full max-w-3xl max-h-[88vh] flex flex-col bg-white rounded-2xl shadow-2xl overflow-hidden">

            {/* Header */}
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-100 flex-shrink-0">
              <div>
                <h2 className="text-lg font-bold tracking-tight text-slate-900">Service Catalog</h2>
                <p className="text-xs text-slate-500">{stats.mains} main · {stats.subs} sub-services · ₹{stats.mrr.toLocaleString()}/mo catalog value</p>
              </div>
              <button onClick={onClose} aria-label="Close"
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors cursor-pointer">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4 bg-slate-50/40">
              {/* Add main service */}
              <div className="card p-4 bg-white">
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">New main service</label>
                    <input value={mainName} onChange={(e) => setMainName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addMain(); }} placeholder="e.g. Managed XDR" className="input" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">₹ / month</label>
                    <input type="number" min={0} value={mainPrice} onChange={(e) => setMainPrice(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addMain(); }} placeholder="0" className="input" />
                  </div>
                  <div className="sm:col-span-2">
                    <input value={mainDesc} onChange={(e) => setMainDesc(e.target.value)} placeholder="Description (optional)" className="input text-sm" />
                  </div>
                </div>
                <div className="mt-3">
                  <GlowButton onClick={addMain} disabled={!mainName.trim() || createMutation.isPending} loading={createMutation.isPending} className="text-sm py-2">
                    Add main service
                  </GlowButton>
                </div>
              </div>

              {/* Search */}
              <div className="relative">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search services…" className="input pl-9 py-2 text-sm bg-white" />
              </div>

              {/* List */}
              {isLoading ? (
                <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-16 rounded-xl bg-white animate-pulse" />)}</div>
              ) : filtered.length === 0 ? (
                <div className="py-12 text-center text-sm text-slate-500">{search ? `No services match “${search}”.` : 'No services yet — add your first main service.'}</div>
              ) : (
                <div className="space-y-3">
                  {filtered.map((main) => (
                    <CatalogCard key={main.id} main={main}
                      onToggle={(active) => toggleMutation.mutate({ id: main.id, active })}
                      onDelete={() => deleteMutation.mutate(main.id)}
                      onAddSub={(name, price) => createMutation.mutate({ name, parentId: main.id, monthlyPrice: price })}
                      onToggleSub={(id, active) => toggleMutation.mutate({ id, active })}
                      onDeleteSub={(id) => deleteMutation.mutate(id)}
                      busy={busy} />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
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
  const [openCard, setOpenCard] = useState(false);
  const [subName, setSubName] = useState('');
  const [subPrice, setSubPrice] = useState('');
  const inUse = (main._count?.purchases ?? 0) > 0;

  function addSub() {
    if (!subName.trim()) return;
    onAddSub(subName.trim(), Number(subPrice) || 0);
    setSubName(''); setSubPrice('');
  }

  return (
    <div className={`rounded-xl border border-slate-200 bg-white overflow-hidden ${main.active ? '' : 'opacity-75'}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button onClick={() => setOpenCard((v) => !v)} className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer">
          <span className={`flex-shrink-0 w-1.5 h-8 rounded-full ${main.active ? 'bg-brand' : 'bg-slate-300'}`} />
          <svg className={`w-4 h-4 text-slate-400 transition-transform flex-shrink-0 ${openCard ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
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
            <p className="text-[11px] text-slate-400">{main.children.length} sub{main.children.length === 1 ? '' : 's'}</p>
          </div>
          <button onClick={() => onToggle(!main.active)} disabled={busy} className="text-xs font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-50 cursor-pointer">{main.active ? 'Deactivate' : 'Activate'}</button>
          <button onClick={onDelete} disabled={inUse || busy} title={inUse ? 'Has customer purchases — cannot delete' : 'Delete'}
            className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">Delete</button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {openCard && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
            <div className="px-4 pb-4 pt-1 border-t border-slate-100 bg-slate-50/50">
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
              <div className="flex flex-wrap items-center gap-2">
                <input value={subName} onChange={(e) => setSubName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addSub(); }} placeholder="New sub-service name" className="input flex-1 min-w-[180px] !py-1.5 text-sm bg-white" />
                <input type="number" min={0} value={subPrice} onChange={(e) => setSubPrice(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addSub(); }} placeholder="₹/mo" className="input w-28 !py-1.5 text-sm bg-white" />
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
