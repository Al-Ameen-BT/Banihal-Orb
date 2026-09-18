'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { squidApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar, { icons } from '@/components/ui/Sidebar';
import { PageHeader } from '@/components/ui/PageHeader';
import GlowButton from '@/components/ui/GlowButton';
import { Shimmer } from '@/components/ui/Shimmer';
import { notify } from '@/lib/toast-bus';
import { useAuth } from '@/contexts/AuthContext';

interface ProxySummary {
  id: string;
  name: string;
  description: string | null;
  status: string;
  lastSeenAt: string | null;
  revision: number;
  appliedSeq: number;
  locked: boolean;
  createdAt: string;
  customerService: { id: string; name: string; endDate: string } | null;
  _count: { branches: number };
}

interface ChangeRequest {
  id: string;
  source: string;
  action: string;
  summary: string;
  createdAt: string;
}

interface SiteEntry { value: string; subdomain: boolean }
interface BranchView {
  id: string; name: string; description: string | null; mode: string;
  sources: string[]; whitelist: SiteEntry[]; blacklist: SiteEntry[];
}
interface ProxyDetail {
  id: string; name: string; description: string | null; transport: string;
  status: string; lastSeenAt: string | null; lastError: string | null;
  revision: number; appliedSeq: number; locked: boolean;
  registrationHint: string | null; safePorts: string[]; sslPorts: string[];
  fullAccess: { src: string; description?: string | null; until?: string | null }[];
  customerService: { id: string; name: string; endDate: string } | null;
  branches: BranchView[];
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

// Subscription status for a service-backed proxy: past/30-day windows get a
// badge so the dashboard shows the expiry state at a glance.
function expiryBadge(service: { endDate: string } | null): { cls: string; label: string } | null {
  if (!service) return null;
  const days = Math.ceil((new Date(service.endDate).getTime() - Date.now()) / 86400_000);
  if (days < 0) return { cls: 'text-red-700 bg-red-50 border-red-100', label: 'Expired · suspended' };
  if (days <= 30) return { cls: 'text-amber-700 bg-amber-50 border-amber-100', label: `Expires in ${days}d` };
  return null;
}

// ─── Create proxy ────────────────────────────────────────────────────────────
function CreateProxyModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const create = useMutation({
    mutationFn: () => squidApi.create({ name: name.trim(), description: description.trim() || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['squid-proxies'] }); notify('Proxy created — configure branches to push your first ACL bundle', 'success'); onClose(); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not create the proxy.'),
  });
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="relative bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="p-6 space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">New squid proxy</p>
            <p className="text-sm text-slate-500 mt-0.5">Give it a name that matches its deployment (e.g. <span className="font-mono text-slate-700">branch_office_mumbai</span>).</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Name <span className="text-red-500">*</span></label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="2-32 chars: letters, digits, _ or -" className="input" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Where is this proxy and what is it for?" className="input resize-none" />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex items-center gap-3">
            <GlowButton onClick={() => create.mutate()} disabled={!name.trim() || create.isPending} loading={create.isPending}>Create proxy</GlowButton>
            <GlowButton variant="ghost" onClick={onClose}>Cancel</GlowButton>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Rotate key ──────────────────────────────────────────────────────────────
function RotateKeyModal({ proxyId, onClose }: { proxyId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const rotate = useMutation({
    mutationFn: () => squidApi.rotateKey(proxyId),
    onSuccess: (r) => { setKey((r.data as { raw: string }).raw); qc.invalidateQueries({ queryKey: ['squid-proxy'] }); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not rotate the key.'),
  });
  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="relative bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="p-6 space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Rotate agent key</p>
            <p className="text-sm text-slate-500 mt-0.5">The old key stops working immediately. Reinstall the agent&apos;s <span className="font-mono text-xs">key</span> file with the new one.</p>
          </div>
          {!key ? (
            <>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex items-center gap-3">
                <GlowButton onClick={() => rotate.mutate()} loading={rotate.isPending} disabled={rotate.isPending}>Generate new key</GlowButton>
                <GlowButton variant="ghost" onClick={onClose}>Cancel</GlowButton>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-lg bg-slate-900 text-slate-100 font-mono text-base px-4 py-3 flex items-center gap-3 break-all">
                <span className="flex-1">{key}</span>
                <button type="button" onClick={() => navigator.clipboard?.writeText(key)} className="text-brand-200 hover:text-white text-sm cursor-pointer flex-shrink-0">Copy</button>
              </div>
              <p className="text-xs text-slate-400">Shown once. The agent must present it on every poll — update <span className="font-mono">/etc/squid-agent/key</span> now.</p>
              <GlowButton onClick={onClose} className="w-full">Done</GlowButton>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ─── Verify pasted registration token ────────────────────────────────────────
function VerifyTokenField({ proxyId }: { proxyId: string }) {
  const [token, setToken] = useState('');
  const [result, setResult] = useState<'valid' | 'invalid' | 'error' | null>(null);
  const verify = useMutation({
    mutationFn: () => squidApi.verifyToken(proxyId, token),
    onSuccess: (r) => setResult((r.data as { valid: boolean }).valid ? 'valid' : 'invalid'),
    onError: () => setResult('error'),
  });
  return (
    <div className="pt-2 border-t border-slate-200/70 space-y-2">
      <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Verify a pasted token</p>
      <div className="flex gap-2">
        <input
          type="text" value={token} onChange={(e) => { setToken(e.target.value); setResult(null); }}
          placeholder="Paste the registration token (pk_…)"
          className="input text-xs font-mono flex-1" disabled={verify.isPending}
        />
        <GlowButton variant="secondary" className="py-1.5 px-3 text-xs whitespace-nowrap" onClick={() => verify.mutate()} loading={verify.isPending} disabled={verify.isPending || !token.trim()}>Verify</GlowButton>
      </div>
      {result && (
        <p className={`text-sm ${result === 'valid' ? 'text-emerald-600' : 'text-red-600'}`}>
          {result === 'valid' ? 'Matches the registered key — the agent can authenticate with it.' : result === 'invalid' ? 'Does not match the registered key.' : 'Could not verify — try again.'}
        </p>
      )}
    </div>
  );
}

// ─── Branch lists editor ─────────────────────────────────────────────────────
const ENTRY_RE = /^\./;
function parseEntries(text: string): SiteEntry[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => ({
    value: l.replace(ENTRY_RE, ''),
    subdomain: ENTRY_RE.test(l),
  }));
}

function BranchEditor({ proxyId, branch, onDone }: { proxyId: string; branch: BranchView; onDone: () => void }) {
  const qc = useQueryClient();
  const [sources, setSources] = useState(branch.sources.join('\n'));
  const [wl, setWl] = useState(branch.whitelist.map((e) => (e.subdomain ? '.' : '') + e.value).join('\n'));
  const [bl, setBl] = useState(branch.blacklist.map((e) => (e.subdomain ? '.' : '') + e.value).join('\n'));
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => squidApi.setBranchLists(proxyId, branch.id, {
      sources: sources.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 100),
      whitelist: parseEntries(wl).slice(0, 2000),
      blacklist: parseEntries(bl).slice(0, 2000),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['squid-proxy'] }); notify('Lists saved — the agent will pull this on its next poll', 'success'); onDone(); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not save the lists.'),
  });
  return (
    <div className="space-y-3 mt-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
      <div>
        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Allowed source IPs / CIDRs</label>
        <textarea value={sources} onChange={(e) => setSources(e.target.value)} rows={2} placeholder={'One per line, e.g.\n203.0.113.0/24\n198.51.100.10'} className="input resize-none text-sm font-mono" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Whitelist (allowed sites)</label>
        <textarea value={wl} onChange={(e) => setWl(e.target.value)} rows={4} placeholder={'example.com\ngithub.com — prefix with a dot ( .example.com ) to include all subdomains'} className="input resize-none text-sm font-mono" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Blacklist (blocked sites)</label>
        <textarea value={bl} onChange={(e) => setBl(e.target.value)} rows={3} placeholder={'bad.example.com — always wins over a whitelist match'} className="input resize-none text-sm font-mono" />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <GlowButton onClick={() => save.mutate()} disabled={save.isPending} loading={save.isPending}>Save lists</GlowButton>
        <GlowButton variant="ghost" onClick={onDone}>Done</GlowButton>
      </div>
    </div>
  );
}

// ─── Detail modal ────────────────────────────────────────────────────────────
function ProxyDetailModal({ proxySummary, onClose }: { proxySummary: ProxySummary; onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canEdit = user?.role === 'ORG_ADMIN';
  const [tab, setTab] = useState<'branches' | 'ports' | 'history' | 'setup'>('branches');
  const [editingBranch, setEditingBranch] = useState<BranchView | null>(null);
  const [addBranch, setAddBranch] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [newBranchMode, setNewBranchMode] = useState<'ADDITIVE' | 'EXCLUSIVE'>('ADDITIVE');
  const [safe, setSafe] = useState('');
  const [ssl, setSsl] = useState('');
  const [fa, setFa] = useState<{ src: string; until?: string }[]>([{ src: '' }]);
  const [faLoaded, setFaLoaded] = useState(false);
  const [error, setError] = useState('');
  const [rotating, setRotating] = useState(false);

  const { data: detail, isLoading } = useQuery<ProxyDetail>({
    queryKey: ['squid-proxy', proxySummary.id],
    queryFn: () => squidApi.get(proxySummary.id).then((r) => r.data as ProxyDetail),
    refetchInterval: 8000,
  });

  const { data: pubkey } = useQuery<{ publicKey: string }>({
    queryKey: ['squid-bundle-key'],
    queryFn: () => squidApi.bundlePublicKey().then((r) => r.data as { publicKey: string }),
    staleTime: Infinity,
  });

  const { data: changes } = useQuery<{ changeRequests: ChangeRequest[] }>({
    queryKey: ['squid-change-requests', proxySummary.id],
    queryFn: () => squidApi.listChangeRequests(proxySummary.id).then((r) => r.data as { changeRequests: ChangeRequest[] }),
    refetchInterval: 15_000,
  });

  const addBranchMut = useMutation({
    mutationFn: () => squidApi.createBranch(proxySummary.id, { name: branchName.trim(), mode: newBranchMode }),
    onSuccess: () => { setAddBranch(false); setBranchName(''); qc.invalidateQueries({ queryKey: ['squid-proxy'] }); notify('Branch added — set its lists from the list below', 'success'); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not add the branch.'),
  });

  const delBranchMut = useMutation({
    mutationFn: (branchId: string) => squidApi.deleteBranch(proxySummary.id, branchId),
    onSuccess: () => { setEditingBranch(null); qc.invalidateQueries({ queryKey: ['squid-proxy'] }); notify('Branch deleted', 'success'); },
  });

  const savePorts = useMutation({
    mutationFn: () => squidApi.setPorts(proxySummary.id, {
      safePorts: safe.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 64),
      sslPorts: ssl.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 64),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['squid-proxy'] }); notify('Ports saved', 'success'); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not save the ports.'),
  });

  const saveFa = useMutation({
    mutationFn: () => squidApi.setFullAccess(proxySummary.id, { fullAccess: fa.filter((f) => f.src.trim()) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['squid-proxy'] }); notify('Full-access list saved', 'success'); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not save the full-access list.'),
  });

  if (isLoading) return null;
  if (!detail) return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md p-6 text-sm text-slate-500">
        Could not load proxy. <GlowButton variant="ghost" onClick={onClose}>Close</GlowButton>
      </div>
    </div>
  );

  const cfg = STATUS_CFG[detail.status] ?? STATUS_CFG['UNPROVISIONED']!;
  const applied = detail.appliedSeq >= detail.revision;
  // Hydrate the full-access editor from the DB once, so saving never wipes
  // entries you haven't touched.
  if (!faLoaded) { setFa(detail.fullAccess.map((f) => ({ src: f.src, until: f.until ?? undefined }))); setFaLoaded(true); }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl flex flex-col max-h-[86vh]">
        <div className="px-6 py-4 border-b border-slate-100 flex items-start justify-between flex-shrink-0">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold text-slate-900">{detail.name}</h2>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border ${cfg.cls}`}>{cfg.label}</span>
              {detail.locked && <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border text-red-700 bg-red-50 border-red-100">{detail.customerService && new Date(detail.customerService.endDate).getTime() < Date.now() ? 'Auto-suspended · expired' : 'Locked'}</span>}
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {detail.customerService
                ? `Provisioned via ${detail.customerService.name} — expires ${new Date(detail.customerService.endDate).toLocaleDateString()}`
                : detail.description || 'Self-managed proxy'}
              {' · '}revision {detail.revision} · applied {detail.appliedSeq} {applied ? '· agent current ✓' : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors cursor-pointer ml-4 flex-shrink-0" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-6 pt-3 flex items-center gap-1 border-b border-slate-100 flex-shrink-0">
          {([['branches', 'Branches'], ['ports', 'Ports & access'], ['history', 'Change log'], ['setup', 'Install & keys']] as const).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} className={`px-3 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors cursor-pointer ${tab === key ? 'border-brand text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'branches' && (
            <div className="space-y-3">
              {error && <p className="text-sm text-red-600">{error}</p>}
              {canEdit && (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-slate-500">Branches combine into the generated config. Each agent pulls one bundle.</p>
                  <GlowButton variant="secondary" className="py-1.5 px-3 text-xs" onClick={() => setAddBranch(!addBranch)}>{addBranch ? 'Cancel' : '+ Branch'}</GlowButton>
                </div>
              )}
              {addBranch && (
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 space-y-2">
                  <input value={branchName} onChange={(e) => setBranchName(e.target.value)} placeholder="Branch name (e.g. sales_team)" className="input text-sm" />
                  <select value={newBranchMode} onChange={(e) => setNewBranchMode(e.target.value as 'ADDITIVE' | 'EXCLUSIVE')} className="input text-sm">
                    <option value="ADDITIVE">Additive — combines with other branches</option>
                    <option value="EXCLUSIVE">Exclusive — applies alone, blocks everything else</option>
                  </select>
                  <GlowButton onClick={() => addBranchMut.mutate()} disabled={!branchName.trim() || addBranchMut.isPending} loading={addBranchMut.isPending} className="py-1.5 px-3 text-xs">Add branch</GlowButton>
                </div>
              )}
              {detail.branches.length === 0 ? (
                <div className="card p-8 text-center">
                  <p className="text-sm font-medium text-slate-700 mb-1">No branches yet</p>
                  <p className="text-xs text-slate-400">Add your first branch to start publishing ACL rules to this proxy.</p>
                </div>
              ) : detail.branches.map((b) => (
                <div key={b.id} className="card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-slate-800">{b.name}</p>
                        <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${b.mode === 'EXCLUSIVE' ? 'text-red-700 bg-red-50' : 'text-slate-500 bg-slate-100'}`}>{b.mode}</span>
                      </div>
                      {b.description && <p className="text-xs text-slate-400 mt-0.5">{b.description}</p>}
                      <p className="text-[11px] text-slate-400 mt-1">
                        {b.sources.length} source allows · {b.whitelist.length} whitelist · {b.blacklist.length} blacklist
                      </p>
                    </div>
                    {canEdit && (
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <GlowButton variant="secondary" className="py-1 px-2.5 text-xs" onClick={() => setEditingBranch(editingBranch?.id === b.id ? null : b)}>
                          {editingBranch?.id === b.id ? 'Close' : 'Edit lists'}
                        </GlowButton>
                        <GlowButton variant="danger" className="py-1 px-2.5 text-xs" onClick={() => delBranchMut.mutate(b.id)} disabled={delBranchMut.isPending}>Delete</GlowButton>
                      </div>
                    )}
                  </div>
                  {editingBranch?.id === b.id && <BranchEditor proxyId={proxySummary.id} branch={b} onDone={() => setEditingBranch(null)} />}
                </div>
              ))}
            </div>
          )}

          {tab === 'ports' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Safe ports (comma separated)</label>
                <input value={safe || detail.safePorts.join(', ')} onChange={(e) => setSafe(e.target.value)} placeholder={detail.safePorts.join(', ') || 'e.g. 80, 443'} className="input font-mono text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">SSL ports (comma separated)</label>
                <input value={ssl || detail.sslPorts.join(', ')} onChange={(e) => setSsl(e.target.value)} placeholder={detail.sslPorts.join(', ') || 'e.g. 443'} className="input font-mono text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Full outbound access (src · optional until)</label>
                <div className="space-y-2">
                  {fa.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input value={row.src} onChange={(e) => setFa(fa.map((r, j) => j === i ? { ...r, src: e.target.value } : r))} placeholder="IP or CIDR" className="input font-mono text-sm flex-1" />
                      <input type="date" disabled={!row.src.trim()} onChange={(e) => setFa(fa.map((r, j) => j === i ? { ...r, until: e.target.value } : r))} className="input text-sm flex-1" title="Expiry date (optional)" />
                      <GlowButton variant="ghost" className="py-1 px-2.5 text-xs" onClick={() => setFa(fa.filter((_, j) => j !== i))}>Remove</GlowButton>
                    </div>
                  ))}
                </div>
                <GlowButton variant="secondary" className="mt-2 py-1.5 px-3 text-xs" onClick={() => setFa([...fa, { src: '' }])}>+ Add row</GlowButton>
              </div>
              {error && tab === 'ports' && <p className="text-sm text-red-600">{error}</p>}
              {canEdit && (
                <div className="flex items-center gap-3">
                  <GlowButton onClick={() => savePorts.mutate()} disabled={savePorts.isPending} loading={savePorts.isPending}>Save ports</GlowButton>
                  <GlowButton variant="secondary" onClick={() => saveFa.mutate()} disabled={saveFa.isPending} loading={saveFa.isPending}>Save full access</GlowButton>
                </div>
              )}
            </div>
          )}

          {tab === 'history' && (
            <div className="space-y-3">
              <p className="text-sm text-slate-500">Every requested config change is recorded as a ticket-style entry — from the Slack bot, the dashboard, or an API client.</p>
              {(changes?.changeRequests?.length ?? 0) === 0 ? (
                <div className="card p-8 text-center">
                  <p className="text-sm font-medium text-slate-700 mb-1">No change requests yet</p>
                  <p className="text-xs text-slate-400">Requests appear here the moment a branch, list, port, or access rule changes.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {changes!.changeRequests.map((c) => (
                    <div key={c.id} className="card p-3 flex items-start gap-3">
                      <span className={`mt-0.5 shrink-0 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${c.source === 'WEB' ? 'text-blue-700 bg-blue-50' : 'text-slate-600 bg-slate-100'}`}>{c.source}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{c.summary}</p>
                        <p className="text-[11px] text-slate-400 mt-0.5 font-mono">{c.action} · {new Date(c.createdAt).toLocaleString()}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'setup' && (
            <div className="space-y-4 text-sm">
              <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4 space-y-1.5">
                <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Agent connection</p>
                <p className="text-slate-500">Poll endpoint: <code className="font-mono text-xs text-slate-800">GET /api/proxy-agent/poll</code> with the registration key as a <span className="font-mono text-xs">pk_…</span> bearer token.</p>
                <p className="text-slate-500">Last seen <span className="font-medium text-slate-700">{ago(detail.lastSeenAt)}</span>{detail.lastError ? <> · last error: <span className="text-red-600 font-mono text-xs">{detail.lastError}</span></> : null}</p>
              </div>

              <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4 space-y-2">
                <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Registration key</p>
                {detail.registrationHint ? (
                  <p className="text-slate-500">Registered key hint: <span className="font-mono text-sm text-slate-800">{detail.registrationHint}</span> (shown once — rotate to regenerate and view again).</p>
                ) : (
                  <p className="text-slate-500">No key registered yet{canEdit ? ' — create the proxy, then rotate to mint one' : ''}.</p>
                )}
                {canEdit && <GlowButton variant="secondary" className="py-1.5 px-3 text-xs" onClick={() => setRotating(true)}>Rotate agent key</GlowButton>}
                {canEdit && <VerifyTokenField proxyId={proxySummary.id} />}
              </div>

              <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4 space-y-2 break-all">
                <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Bundle signing public key</p>
                {pubkey ? <p className="font-mono text-[11px] text-slate-700">{pubkey.publicKey}</p> : <p className="text-slate-400 text-xs">Loading…</p>}
                <p className="text-xs text-slate-400">Pin this key on the agent host so config bundles can be verified before <span className="font-mono">squid -k reconfigure</span>.</p>
              </div>
            </div>
          )}
        </div>
      </motion.div>
      <AnimatePresence>{rotating && <RotateKeyModal proxyId={proxySummary.id} onClose={() => setRotating(false)} />}</AnimatePresence>
    </div>
  );
}

export default function SquidPage() {
  const { user } = useAuth();
  const canEdit = user?.role === 'ORG_ADMIN';
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<ProxySummary | null>(null);

  const { data, isLoading } = useQuery<{ proxies: ProxySummary[] }>({
    queryKey: ['squid-proxies'],
    queryFn: () => squidApi.list({}).then((r) => r.data as { proxies: ProxySummary[] }),
    refetchInterval: 15_000,
  });
  const proxies = data?.proxies ?? [];

  return (
    <RoleGuard allowedRoles={['ORG_ADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-6 sm:p-8 max-w-[1100px] mx-auto space-y-6">
            <PageHeader eyebrow="Security" title="Squid Outbound Proxy" icon={icons.squid}
              subtitle="Configure ACL rules per proxy. A pull-based agent on each host applies the generated config and reports back — no inbound ports needed." />

            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-400">{proxies.length} proxy{proxies.length === 1 ? '' : 'es'} configured</p>
              {canEdit && <GlowButton onClick={() => setCreating(true)}>New proxy</GlowButton>}
            </div>

            {isLoading ? (
              <div className="space-y-3">{[...Array(2)].map((_, i) => <Shimmer key={i} className="h-20 rounded-xl" />)}</div>
            ) : proxies.length === 0 ? (
              <div className="card p-12 text-center">
                <p className="text-sm font-medium text-slate-700 mb-1">{canEdit ? 'No proxies yet' : 'No proxies configured'}</p>
                <p className="text-xs text-slate-400">Add a proxy, define its branches, and pair it with the agent package on the target host.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {proxies.map((p) => {
                  const cfg = STATUS_CFG[p.status] ?? STATUS_CFG['UNPROVISIONED']!;
                  const applied = p.appliedSeq >= p.revision;
                  return (
                    <button key={p.id} type="button" onClick={() => setOpen(p)} className="w-full text-left card p-4 flex items-center gap-4 hover:border-brand-200 transition-colors cursor-pointer">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-slate-900">{p.name}</p>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border ${cfg.cls}`}>{cfg.label}</span>
                          {p.locked && <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border text-red-700 bg-red-50 border-red-100">Locked</span>}
                          {(() => { const eb = expiryBadge(p.customerService); return eb ? <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border ${eb.cls}`}>{eb.label}</span> : null; })()}
                        </div>
                        {p.description && <p className="text-xs text-slate-400 mt-0.5 truncate">{p.description}</p>}
                        {p.customerService && <p className="text-[11px] text-slate-400 mt-1">via {p.customerService.name} · expires {new Date(p.customerService.endDate).toLocaleDateString()}</p>}
                        <p className="text-[11px] text-slate-400 mt-1">{p._count.branches} branch{p._count.branches === 1 ? '' : 'es'} · last seen {ago(p.lastSeenAt)}</p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="font-mono text-xs text-slate-500 tabular-nums">
                          rev {p.revision}{applied && p.revision > 0 ? ' ✓' : ` / ${p.appliedSeq} applied`}
                        </p>
                        <p className="text-[10px] text-slate-400 mt-1">Click to manage</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
      <AnimatePresence>
        {creating && <CreateProxyModal onClose={() => setCreating(false)} />}
        {open && <ProxyDetailModal proxySummary={open} onClose={() => setOpen(null)} />}
      </AnimatePresence>
    </RoleGuard>
  );
}