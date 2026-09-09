'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { saasAdminApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar, { icons } from '@/components/ui/Sidebar';
import { PageHeader } from '@/components/ui/PageHeader';
import GlowButton from '@/components/ui/GlowButton';
import { Shimmer } from '@/components/ui/Shimmer';

interface CatalogItem {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  basePrice: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const CATEGORIES = ['Security', 'Monitoring', 'Communication', 'Analytics', 'Compliance', 'Infrastructure', 'Consulting', 'Other'];

function CategoryBadge({ category }: { category: string | null }) {
  const colors: Record<string, string> = {
    Security:       'text-rose-700 bg-rose-50 border-rose-100',
    Monitoring:     'text-blue-700 bg-blue-50 border-blue-100',
    Communication:  'text-violet-700 bg-violet-50 border-violet-100',
    Analytics:      'text-amber-700 bg-amber-50 border-amber-100',
    Compliance:     'text-emerald-700 bg-emerald-50 border-emerald-100',
    Infrastructure: 'text-cyan-700 bg-cyan-50 border-cyan-100',
    Consulting:     'text-indigo-700 bg-indigo-50 border-indigo-100',
    Other:          'text-slate-600 bg-slate-50 border-slate-200',
  };
  const cls = colors[category ?? ''] ?? colors['Other']!;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border ${cls}`}>
      {category ?? 'Uncategorized'}
    </span>
  );
}

// ─── Add / Edit drawer ───────────────────────────────────────────────────────
function CatalogDrawer({
  item,
  onClose,
}: {
  item: CatalogItem | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!item;

  const [name, setName] = useState(item?.name ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [category, setCategory] = useState(item?.category ?? '');
  const [basePrice, setBasePrice] = useState(String(item?.basePrice ?? 0));
  const [enabled, setEnabled] = useState(item?.enabled ?? true);
  const [error, setError] = useState('');

  const createMutation = useMutation({
    mutationFn: () => saasAdminApi.createCatalogItem({ name: name.trim(), description: description.trim() || undefined, category: category || undefined, basePrice: Number(basePrice) || 0, enabled }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['catalog'] }); onClose(); },
    onError: () => setError('Failed to create service. Please try again.'),
  });

  const updateMutation = useMutation({
    mutationFn: () => saasAdminApi.updateCatalogItem(item!.id, { name: name.trim(), description: description.trim() || undefined, category: category || undefined, basePrice: Number(basePrice) || 0, enabled }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['catalog'] }); onClose(); },
    onError: () => setError('Failed to update service. Please try again.'),
  });

  const pending = createMutation.isPending || updateMutation.isPending;

  function submit() {
    if (!name.trim()) { setError('Service name is required.'); return; }
    setError('');
    if (isEdit) updateMutation.mutate();
    else createMutation.mutate();
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <motion.aside
        initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        className="relative ml-auto w-full max-w-md h-full bg-white shadow-2xl flex flex-col"
      >
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">{isEdit ? 'Edit Catalog Service' : 'Add Catalog Service'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors cursor-pointer" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Service Name <span className="text-red-500">*</span></label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SIEM Platform" className="input" />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Brief description of what this service provides…" className="input resize-none" />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="input">
              <option value="">— Select category —</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Base Price (₹/month)</label>
            <input type="number" min={0} value={basePrice} onChange={(e) => setBasePrice(e.target.value)} placeholder="0" className="input" />
            <p className="text-xs text-slate-400 mt-1">Default price when assigning to an org. Can be overridden per-org.</p>
          </div>

          <div className="flex items-center justify-between pt-1">
            <div>
              <p className="text-sm font-medium text-slate-900">Enabled</p>
              <p className="text-xs text-slate-500 mt-0.5">Disabled services won&apos;t appear in the catalog picker.</p>
            </div>
            <button
              type="button"
              onClick={() => setEnabled(!enabled)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${enabled ? 'bg-brand' : 'bg-slate-200'}`}
              aria-pressed={enabled}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-[22px]' : 'translate-x-[4px]'}`} />
            </button>
          </div>

          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-2.5">{error}</p>}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex items-center gap-3">
          <GlowButton onClick={submit} disabled={pending} loading={pending}>
            {isEdit ? 'Save Changes' : 'Add to Catalog'}
          </GlowButton>
          <GlowButton variant="ghost" onClick={onClose} disabled={pending}>Cancel</GlowButton>
        </div>
      </motion.aside>
    </div>
  );
}

// ─── Delete Confirmation Modal ───────────────────────────────────────────────
function ConfirmDeleteModal({
  item,
  onClose,
  onConfirm,
  isPending,
}: {
  item: CatalogItem | null;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  if (!item) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={!isPending ? onClose : undefined} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden"
      >
        <div className="p-6">
          <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h3 className="text-lg font-bold text-slate-900 mb-2">Delete Service</h3>
          <p className="text-sm text-slate-500">
            Are you sure you want to delete <span className="font-semibold text-slate-700">{item.name}</span>? This action cannot be undone and will remove the service from the catalog.
          </p>
        </div>
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
          <GlowButton variant="ghost" onClick={onClose} disabled={isPending}>Cancel</GlowButton>
          <GlowButton variant="danger" onClick={onConfirm} disabled={isPending} loading={isPending}>Delete</GlowButton>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────
export default function CatalogPage() {
  const qc = useQueryClient();
  const [drawerItem, setDrawerItem] = useState<CatalogItem | 'new' | null>(null);
  const [itemToDelete, setItemToDelete] = useState<CatalogItem | null>(null);
  const [filterCategory, setFilterCategory] = useState('ALL');
  const [search, setSearch] = useState('');

  const { data: items = [], isLoading } = useQuery<CatalogItem[]>({
    queryKey: ['catalog'],
    queryFn: () => saasAdminApi.listCatalog().then((r) => r.data as CatalogItem[]),
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => saasAdminApi.deleteCatalogItem(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['catalog'] });
      setItemToDelete(null);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => saasAdminApi.updateCatalogItem(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['catalog'] }),
  });

  const allCategories = Array.from(new Set(items.map((i) => i.category).filter(Boolean))) as string[];

  const filtered = items.filter((item) => {
    const matchesCategory = filterCategory === 'ALL' || item.category === filterCategory;
    const q = search.trim().toLowerCase();
    const matchesSearch = !q || item.name.toLowerCase().includes(q) || (item.description ?? '').toLowerCase().includes(q) || (item.category ?? '').toLowerCase().includes(q);
    return matchesCategory && matchesSearch;
  });

  const enabledCount = items.filter((i) => i.enabled).length;

  return (
    <RoleGuard allowedRoles={['ADMINISTRATOR']} permission="catalog.manage">
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-6 sm:p-8 max-w-[1600px] mx-auto space-y-6">

            {/* Header */}
            <PageHeader eyebrow="Platform" title="Service Catalog" icon={icons.catalog}
              subtitle={`Master list of platform services — ${enabledCount} of ${items.length} enabled.`}
              actions={
                <GlowButton onClick={() => setDrawerItem('new')}>
                  <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.5v15m7.5-7.5h-15" /></svg>
                  Add Service
                </GlowButton>
              } />

            {/* Summary tiles */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.04 }}>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <SummaryTile label="Total Services" value={items.length} tone="brand" />
                <SummaryTile label="Enabled" value={enabledCount} tone="emerald" />
                <SummaryTile label="Disabled" value={items.length - enabledCount} tone="red" />
                <SummaryTile label="Categories" value={allCategories.length} tone="violet" />
              </div>
            </motion.div>

            {/* Filters */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.07 }}
              className="flex items-center gap-3 flex-wrap">
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => setFilterCategory('ALL')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-colors cursor-pointer ${filterCategory === 'ALL' ? 'bg-brand text-white border-brand' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}>
                  All
                </button>
                {allCategories.map((c) => (
                  <button key={c} onClick={() => setFilterCategory(c)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-colors cursor-pointer ${filterCategory === c ? 'bg-brand text-white border-brand' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}>
                    {c}
                  </button>
                ))}
              </div>
              <div className="relative max-w-xs flex-1 min-w-[180px]">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search services…" className="input pl-9 py-1.5 text-sm" />
              </div>
            </motion.div>

            {/* Catalog grid */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.1 }}>
              {isLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {[...Array(6)].map((_, i) => <Shimmer key={i} className="h-44 rounded-xl" />)}
                </div>
              ) : filtered.length === 0 ? (
                <div className="card p-12 text-center">
                  <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
                    <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-slate-700 mb-1">{search ? `No services match "${search}"` : 'No services in this category'}</p>
                  <p className="text-xs text-slate-400 mb-4">Add services to the catalog so they can be assigned to organizations.</p>
                  <GlowButton onClick={() => setDrawerItem('new')}>Add First Service</GlowButton>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filtered.map((item) => (
                    <CatalogCard
                      key={item.id}
                      item={item}
                      onEdit={() => setDrawerItem(item)}
                      onToggle={() => toggleMutation.mutate({ id: item.id, enabled: !item.enabled })}
                      onDelete={() => setItemToDelete(item)}
                      isToggling={toggleMutation.isPending && (toggleMutation.variables as { id: string })?.id === item.id}
                    />
                  ))}
                </div>
              )}
            </motion.div>

          </div>
        </main>
      </div>

      {/* Drawer */}
      <AnimatePresence>
        {drawerItem !== null && (
          <CatalogDrawer
            item={drawerItem === 'new' ? null : drawerItem}
            onClose={() => setDrawerItem(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {itemToDelete !== null && (
          <ConfirmDeleteModal
            item={itemToDelete}
            onClose={() => setItemToDelete(null)}
            onConfirm={() => deleteMutation.mutate(itemToDelete.id)}
            isPending={deleteMutation.isPending}
          />
        )}
      </AnimatePresence>
    </RoleGuard>
  );
}

// ─── Catalog card ────────────────────────────────────────────────────────────
function CatalogCard({
  item, onEdit, onToggle, onDelete, isToggling,
}: {
  item: CatalogItem;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  isToggling: boolean;
}) {
  return (
    <div className={`card p-5 flex flex-col gap-3 transition-opacity ${item.enabled ? '' : 'opacity-60'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {item.category && <CategoryBadge category={item.category} />}
            {!item.enabled && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold text-slate-500 bg-slate-100 border border-slate-200">
                Disabled
              </span>
            )}
          </div>
          <p className="text-sm font-semibold text-slate-900 leading-snug truncate">{item.name}</p>
        </div>
        <p className="font-mono text-base font-bold text-slate-900 tabular-nums flex-shrink-0">
          ₹{item.basePrice.toLocaleString()}<span className="text-xs font-normal text-slate-400">/mo</span>
        </p>
      </div>

      {item.description && (
        <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{item.description}</p>
      )}

      <div className="flex items-center gap-2 pt-1 border-t border-slate-100 mt-auto">
        <GlowButton variant="ghost" className="py-1 px-2.5 text-xs" onClick={onEdit}>Edit</GlowButton>
        <button
          type="button"
          onClick={onToggle}
          disabled={isToggling}
          className="py-1 px-2.5 text-xs font-semibold rounded-lg border border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-colors cursor-pointer disabled:opacity-50"
        >
          {item.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto text-xs font-semibold text-red-600 hover:text-red-700 transition-colors cursor-pointer"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number | string; tone: 'brand' | 'emerald' | 'red' | 'violet' }) {
  const dot = { brand: 'bg-brand', emerald: 'bg-emerald-500', red: 'bg-red-500', violet: 'bg-violet-500' }[tone];
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
