'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { externalApiKeysApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar, { icons } from '@/components/ui/Sidebar';
import { PageHeader } from '@/components/ui/PageHeader';
import GlowButton from '@/components/ui/GlowButton';
import { Shimmer } from '@/components/ui/Shimmer';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import type {
  ExternalAdminBundle,
  ExternalApiKey,
  ExternalIssuedKey,
  ExternalWebhook,
  ExternalIssuedWebhook,
} from '@/lib/schemas';

const SCOPE_LABELS: Record<string, { label: string; desc: string }> = {
  'tickets.view':   { label: 'Read tickets',       desc: 'List and view tickets via the External API' },
  'tickets.write':  { label: 'Create & update',     desc: 'Create, update, comment and approve flows' },
  'api_keys.manage':{ label: 'Manage own API keys', desc: 'Rotate / revoke this key via the API itself' },
};
const STORE_LABELS: Record<string, string> = {
  'default': 'Default store (customer tickets)',
  'admin':   'Admin store (cross-tenant platform)',
};
const EVENT_LABELS: Record<string, string> = {
  'ticket.created':        'Ticket created',
  'ticket.status_changed': 'Status changed',
  'ticket.comment_added':  'Comment added',
};

function SecretPanel({ secret, hint, copied, onCopy, onDone, doneText }: {
  secret: string; hint: string; copied: boolean; onCopy: () => void;
  onDone: () => void; doneText: string;
}) {
  return (
    <div className="rounded-xl bg-slate-900 p-4">
      <p className="text-xs font-semibold text-slate-400 mb-2">Secret — shown <span className="text-amber-400">once</span>, store it now</p>
      <div className="rounded-lg bg-black/30 text-emerald-300 font-mono text-xs px-3 py-2 break-all flex items-center gap-2">
        <span className="flex-1">{secret}</span>
        <button type="button" onClick={onCopy} className="text-slate-300 hover:text-white cursor-pointer flex-shrink-0">{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="text-[11px] text-slate-500 mt-2">We never store the full secret — if lost, {hint} becomes unusable and you&apos;ll need to rotate the key.</p>
      <GlowButton variant="secondary" className="mt-3 py-1.5 px-4 text-sm w-full" onClick={onDone}>{doneText}</GlowButton>
    </div>
  );
}

// ─── New key drawer ──────────────────────────────────────────────────────────
function NewKeyDrawer({ customers, onClose }: { customers: ExternalAdminBundle['customers']; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['tickets.view', 'tickets.write']);
  const [store, setStore] = useState<'default' | 'admin'>('default');
  const [customerIds, setCustomerIds] = useState<string[]>([]);
  const [expires, setExpires] = useState('');
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<ExternalIssuedKey | null>(null);
  const [copied, setCopied] = useState(false);

  const createMut = useMutation({
    mutationFn: () => externalApiKeysApi.create({
      name: name.trim(), scopes, ticketStore: store,
      customerIds: scopes.includes('tickets.view') ? customerIds : [],
      expiresAt: expires ? new Date(expires).toISOString() : null,
    }),
    onSuccess: (r) => { setIssued(r.data as ExternalIssuedKey); setCopied(false); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to create the key.'),
  });
  const toggle = (set: string[], v: string) => set.includes(v) ? set.filter((s) => s !== v) : [...set, v];

  if (issued) {
    return (
      <DrawerShell title="API key created" onClose={onClose}>
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <SecretPanel secret={issued.secret} hint={issued.secretHint} copied={copied}
            onCopy={() => { navigator.clipboard?.writeText(issued.secret); setCopied(true); }}
            onDone={onClose} doneText="I&apos;ve saved it" />
          <div className="space-y-1.5 text-xs text-slate-500">
            <p className="flex items-center justify-between"><span className="text-slate-400">Client ID</span><span className="font-mono text-slate-700">{issued.clientId}</span></p>
            <p className="flex items-center justify-between"><span className="text-slate-400">Scopes</span><span>{issued.scopes.map((s) => SCOPE_LABELS[s]?.label ?? s).join(', ')}</span></p>
            <p className="flex items-center justify-between"><span className="text-slate-400">Store</span><span>{STORE_LABELS[issued.ticketStore]}</span></p>
          </div>
        </div>
      </DrawerShell>
    );
  }

  return (
    <DrawerShell title="New API key" onClose={onClose}>
      <div className="flex-1 overflow-y-auto p-6 space-y-5">
        <Field label="Key name" required>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CRM weather-migration sync" className="input" />
        </Field>
        <Field label="Scopes" required>
          <div className="space-y-2">
            {Object.entries(SCOPE_LABELS).map(([k, v]) => (
              <label key={k} className={`flex items-start gap-2.5 rounded-lg ring-1 px-3 py-2.5 cursor-pointer ${scopes.includes(k) ? 'ring-brand/50 bg-brand-50/40' : 'ring-slate-200 hover:ring-slate-300'}`}>
                <input type="checkbox" checked={scopes.includes(k)} onChange={(e) => setScopes(e.target.checked ? [...scopes, k] : scopes.filter((s) => s !== k))} className="mt-0.5 w-4 h-4 rounded border-slate-300 text-brand" />
                <div className="min-w-0"><p className="text-sm font-medium text-slate-800">{v.label}</p><p className="text-[11px] text-slate-400">{v.desc}</p></div>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Ticket store">
          <div className="grid gap-1.5">
            {(['default', 'admin'] as const).map((s) => (
              <label key={s} className="flex items-center gap-2.5 rounded-lg ring-1 px-3 py-2.5 cursor-pointer" onClick={() => setStore(s)}>
                <input type="radio" checked={store === s} onChange={() => setStore(s)} className="w-4 h-4 text-brand" />
                <span className="text-sm text-slate-700">{STORE_LABELS[s]}</span>
              </label>
            ))}
          </div>
        </Field>
        {scopes.includes('tickets.view') && (
          <Field label="Restrict to organizations">
            <div className="max-h-36 overflow-y-auto rounded-lg ring-1 ring-slate-200 divide-y divide-slate-100">
              {customers.map((c) => (
                <label key={c.id} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-slate-50">
                  <input type="checkbox" checked={customerIds.includes(c.id)} onChange={() => setCustomerIds((p) => toggle(p, c.id))} className="w-4 h-4 rounded border-slate-300 text-brand" />
                  <span className="text-sm text-slate-700">{c.name}</span>
                </label>
              ))}
              {customers.length === 0 && <p className="px-3 py-2 text-sm text-slate-400">No organizations yet.</p>}
            </div>
            <p className="text-[11px] text-slate-400 mt-1">Leave empty to allow all organizations.</p>
          </Field>
        )}
        <Field label="Expiry (optional)">
          <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} className="input" />
          <p className="text-[11px] text-slate-400 mt-1">Leave blank for a key that never expires.</p>
        </Field>
        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-2.5">{error}</p>}
      </div>
      <div className="px-6 py-4 border-t border-slate-100 flex items-center gap-3">
        <GlowButton onClick={() => { if (!name.trim() || scopes.length === 0) { setError('Name and at least one scope are required.'); return; } setError(''); createMut.mutate(); }} disabled={createMut.isPending} loading={createMut.isPending}>Create API key</GlowButton>
        <GlowButton variant="ghost" onClick={onClose} disabled={createMut.isPending}>Cancel</GlowButton>
      </div>
    </DrawerShell>
  );
}

// ─── Manage key drawer (details + webhooks) ─────────────────────────────────
function ManageKeyDrawer({ selected, onClose }: { selected: ExternalApiKey; onClose: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [showHooks, setShowHooks] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState<string[]>(['ticket.created']);
  const [hookError, setHookError] = useState('');
  const [issuedHook, setIssuedHook] = useState<ExternalIssuedWebhook | null>(null);
  const [copied, setCopied] = useState(false);

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['external-api-keys'] }); };

  const { data: webhooks = [], isLoading: hooksLoading } = useQuery<ExternalWebhook[]>({
    queryKey: ['external-api-keys', selected.clientId, 'webhooks'],
    queryFn: () => externalApiKeysApi.listWebhooks(selected.clientId).then((r) => (r.data as { webhooks: ExternalWebhook[] }).webhooks),
    enabled: showHooks,
  });

  const revokeMut = useMutation({
    mutationFn: () => externalApiKeysApi.revoke(selected.clientId),
    onSuccess: () => { invalidate(); onClose(); },
    onError: (e: unknown) => alert((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to revoke the key.'),
  });

  const hookMut = useMutation({
    mutationFn: () => externalApiKeysApi.createWebhook(selected.clientId, { url: webhookUrl.trim(), events: hookEvents }),
    onSuccess: (r) => { setIssuedHook(r.data as ExternalIssuedWebhook); setCopied(false); setWebhookUrl(''); setHookEvents(['ticket.created']); invalidate(); },
    onError: (e: unknown) => setHookError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to register the webhook.'),
  });
  const removeHookMut = useMutation({
    mutationFn: (id: string) => externalApiKeysApi.removeWebhook(id),
    onSuccess: invalidate,
  });

  return (
    <DrawerShell title={selected.name} onClose={onClose} wide>
      <div className="px-6 py-4 border-b border-slate-100">
        <div className="flex items-center gap-4 flex-wrap">
          <span className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border ${selected.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
            {selected.enabled ? 'Active' : 'Revoked'}
          </span>
          <span className="text-xs text-slate-400 truncate">{selected.scopes.map((s) => SCOPE_LABELS[s]?.label ?? s).join(' · ')}</span>
        </div>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 mt-4 text-xs">
          <div><dt className="text-slate-400">Client ID</dt><dd className="font-mono text-slate-700 mt-0.5 break-all">{selected.clientId}</dd></div>
          <div><dt className="text-slate-400">Created</dt><dd className="text-slate-700 mt-0.5">{new Date(selected.createdAt).toLocaleString()}</dd></div>
          {selected.expiresAt && <div><dt className="text-slate-400">Expires</dt><dd className="text-slate-700 mt-0.5">{new Date(selected.expiresAt).toLocaleString()}</dd></div>}
          <div><dt className="text-slate-400">Last used</dt><dd className="text-slate-700 mt-0.5">{selected.lastUsedAt ? new Date(selected.lastUsedAt).toLocaleString() : 'Never'}</dd></div>
          <div><dt className="text-slate-400">Store</dt><dd className="text-slate-700 mt-0.5">{STORE_LABELS[selected.ticketStore]}</dd></div>
        </dl>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-900">Webhook subscriptions</p>
            <p className="text-xs text-slate-400 mt-0.5">Where the External API posts events for this key.</p>
          </div>
          <button type="button" onClick={() => setShowHooks((s) => !s)} className="text-xs font-semibold text-brand hover:text-brand-700 cursor-pointer">
            {showHooks ? 'Hide' : '+ Add webhook'}
          </button>
        </div>

        {showHooks && (
          issuedHook ? (
            <SecretPanel secret={issuedHook.secret} hint={issuedHook.secretHint} copied={copied}
              onCopy={() => { navigator.clipboard?.writeText(issuedHook.secret); setCopied(true); }}
              onDone={() => setIssuedHook(null)} doneText="Done" />
          ) : (
            <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200/70 p-4 space-y-3">
              <Field label="URL"><input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://hooks.your-sync.example.com/tickets" className="input font-mono text-xs" /></Field>
              <Field label="Events">
                <div className="grid grid-cols-1 gap-1.5">
                  {Object.entries(EVENT_LABELS).map(([ev, label]) => (
                    <label key={ev} className="flex items-center gap-2.5 cursor-pointer">
                      <input type="checkbox" checked={hookEvents.includes(ev)} onChange={() => setHookEvents((p) => p.includes(ev) ? p.filter((e) => e !== ev) : [...p, ev])} className="w-4 h-4 rounded border-slate-300 text-brand" />
                      <span className="text-sm text-slate-700">{label}</span>
                    </label>
                  ))}
                </div>
              </Field>
              {hookError && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-2.5">{hookError}</p>}
              <div className="flex items-center gap-2">
                <GlowButton className="py-1.5 px-4 text-sm" onClick={() => { if (!webhookUrl.trim() || hookEvents.length === 0) { setHookError('URL and at least one event are required.'); return; } setHookError(''); hookMut.mutate(); }} disabled={hookMut.isPending} loading={hookMut.isPending}>Register webhook</GlowButton>
                <GlowButton variant="ghost" className="py-1.5 px-4 text-sm" onClick={() => setShowHooks(false)}>Cancel</GlowButton>
              </div>
            </div>
          )
        )}

        {showHooks && (
          hooksLoading ? <div className="space-y-1.5">{[...Array(2)].map((_, i) => <Shimmer key={i} className="h-12 rounded-lg" />)}</div> :
          <div className="space-y-1.5">
            {webhooks.length === 0 && <p className="text-sm text-slate-400">No webhooks yet.</p>}
            {webhooks.map((w) => (
              <div key={w.id} className="flex items-center gap-3 rounded-lg ring-1 ring-slate-200 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-800 truncate">{w.url}</p>
                  <p className="text-[11px] text-slate-400 truncate">{w.events.map((e) => EVENT_LABELS[e] ?? e).join(' · ')} · sig <span className="font-mono">{w.secretHint}</span></p>
                </div>
                <button type="button" onClick={async () => { if (await confirm({ title: 'Remove webhook', message: <>Stop delivering events to <span className="font-mono text-xs">{w.url}</span>?</>, confirmText: 'Remove', variant: 'danger' })) removeHookMut.mutate(w.id); }}
                  className="text-xs font-semibold text-red-600 hover:text-red-700 cursor-pointer flex-shrink-0">Remove</button>
              </div>
            ))}
          </div>
        )}

        <div className="pt-3 border-t border-slate-100">
          <button type="button" onClick={async () => {
            if (await confirm({ title: 'Revoke API key', message: <>Revoking &ldquo;{selected.name}&rdquo; immediately cuts off every integration using its token. This cannot be undone.</>, confirmText: 'Revoke key', variant: 'danger' })) revokeMut.mutate();
          }} disabled={!selected.enabled || revokeMut.isPending}
            className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
            {revokeMut.isPending ? 'Revoking…' : 'Revoke key'}
          </button>
        </div>
      </div>
    </DrawerShell>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────────────────
function DrawerShell({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <motion.aside initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        className={`relative ml-auto w-full ${wide ? 'max-w-3xl' : 'max-w-md'} h-full bg-white shadow-2xl flex flex-col`}>
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900 truncate">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 cursor-pointer" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        {children}
      </motion.aside>
    </div>
  );
}
function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-700 mb-1.5">{label}{required && <span className="text-red-500"> *</span>}</span>
      {children}
    </label>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function ApiKeysPage() {
  const [adding, setAdding] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);

  const { data: bundle, isLoading } = useQuery<ExternalAdminBundle>({
    queryKey: ['external-api-keys'],
    queryFn: () => externalApiKeysApi.list().then((r) => r.data as ExternalAdminBundle),
  });
  const keys = bundle?.keys ?? [];
  const customers = bundle?.customers ?? [];
  const active = keys.filter((k) => k.enabled).length;
  const manage = manageId ? keys.find((k) => k.id === manageId) : null;

  return (
    <RoleGuard allowedRoles={['ADMINISTRATOR']} permission="external_api.view">
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-6 sm:p-8 max-w-[1600px] mx-auto space-y-6">
            <PageHeader eyebrow="Platform" title="External API" icon={icons.key}
              subtitle={`Machine API keys for the external ticketing surface. Integrations authenticate with these keys and optionally subscribe to delivery webhooks — ${active} of ${keys.length} active.`}
              actions={
                <GlowButton onClick={() => setAdding(true)}>
                  <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.5v15m7.5-7.5h-15" /></svg>
                  New API Key
                </GlowButton>
              } />

            {isLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{[...Array(3)].map((_, i) => <Shimmer key={i} className="h-40 rounded-xl" />)}</div>
            ) : keys.length === 0 ? (
              <div className="card p-12 text-center">
                <p className="text-sm font-medium text-slate-700 mb-1">No API keys yet</p>
                <p className="text-xs text-slate-400 mb-4">Create a key so an external integration can reach the External ticketing API.</p>
                <GlowButton onClick={() => setAdding(true)}>Create First Key</GlowButton>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {keys.map((k) => (
                  <button key={k.id} type="button" onClick={() => setManageId(k.id)}
                    className={`card p-5 text-left flex flex-col gap-3 hover:shadow-card-hover hover:-translate-y-0.5 transition-all cursor-pointer ${k.enabled ? '' : 'opacity-60'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-900 leading-snug truncate">{k.name}</p>
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide ${k.enabled ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>{k.enabled ? 'Active' : 'Revoked'}</span>
                    </div>
                    <p className="text-[11px] font-mono text-slate-400 break-all">{k.clientId}</p>
                    <div className="flex items-center gap-3 text-[11px] text-slate-400 mt-auto pt-2 border-t border-slate-100">
                      <span>{k.scopes.length} scope{k.scopes.length === 1 ? '' : 's'}</span>
                      <span>· {k.webhookCount} webhook{k.webhookCount === 1 ? '' : 's'}</span>
                      {k.expiresAt && <span className="ml-auto">exp {new Date(k.expiresAt).toLocaleDateString()}</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

      <AnimatePresence>{adding && <NewKeyDrawer customers={customers} onClose={() => setAdding(false)} />}</AnimatePresence>
      <AnimatePresence>{manage && <ManageKeyDrawer selected={manage} onClose={() => setManageId(null)} />}</AnimatePresence>
    </RoleGuard>
  );
}