'use client';

import { useState, useRef, useEffect } from 'react';
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
  slackBot?: { table?: string; state?: string; lastError?: string } | null;
}

interface ChangeRequest {
  id: string;
  source: string;
  action: string;
  summary: string;
  createdAt: string;
  // New fields for ticket-gated flow
  status?: string;
  ticketId?: string | null;
  ticketUrl?: string | null;
  appliedSeq?: number | null;
  error?: string | null;
  updatedAt?: string;
}

interface TelemetrySummary {
  latest: {
    observedAt: string; seq: number;
    squidVersion: string | null; uptimeSeconds: number | null;
    cpuPercent: number | null; memPercent: number | null; diskPercent: number | null;
    sessions: string[];
    slackBot?: { table?: string; state?: string; lastError?: string } | null;
  } | null;
  hour: { requests: number; denied: number; bytes: number; clients: number };
  sessions: { clientIp: string; lastSeenAt: string }[];
}

interface ActivityRow { observedAt: string; clientIp: string; method: string; action: string; url: string }

interface DepScanResult { finalUrl: string; dependencies: { value: string; host: string; excluded: boolean; category: string; self: boolean }[]; excluded: { value: string; host: string; excluded: boolean; category: string; self: boolean }[] }

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

// SSE hook for real-time change request updates
function useChangeRequestStream(proxyId: string, enabled: boolean) {
  const [eventSource, setEventSource] = useState<EventSource | null>(null);
  const [latestUpdate, setLatestUpdate] = useState<ChangeRequest | null>(null);

  useEffect(() => {
    if (!enabled || !proxyId) return;

    const es = new EventSource(`/api/squid/${proxyId}/change-requests/stream`);
    setEventSource(es);

    es.addEventListener('connected', () => {
      console.log('SSE connected for proxy', proxyId);
    });

    es.addEventListener('change-request-update', (event) => {
      const data = JSON.parse(event.data);
      if (data.changeRequest) {
        setLatestUpdate(data.changeRequest);
      }
    });

    es.onerror = () => {
      console.warn('SSE error, reconnecting...');
      es.close();
    };

    return () => {
      es.close();
      setEventSource(null);
    };
  }, [proxyId, enabled]);

  return { latestUpdate, eventSource };
}

// Status badge component
function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { cls: string; label: string }> = {
    PENDING_APPROVAL: { cls: 'text-amber-700 bg-amber-50 border-amber-100', label: 'Pending Approval' },
    APPROVED: { cls: 'text-blue-700 bg-blue-50 border-blue-100', label: 'Approved' },
    REJECTED: { cls: 'text-red-700 bg-red-50 border-red-100', label: 'Rejected' },
    APPLIED: { cls: 'text-emerald-700 bg-emerald-50 border-emerald-100', label: 'Applied' },
    FAILED: { cls: 'text-red-700 bg-red-50 border-red-100', label: 'Failed' },
  };
  const c = config[status] ?? { cls: 'text-slate-700 bg-slate-100 border-slate-200', label: status };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border ${c.cls}`}>{c.label}</span>;
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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(v >= 10 ? 1 : 2)} ${units[u]}`;
}

function fmtDuration(s: number | null): string {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Slack bot service status → chip. active=green, failed=red, inactive=amber,
// unknown/missing=slate (no telemetry yet or service not installed).
function botChip(bot: { table?: string; state?: string; lastError?: string } | null | undefined):
  { cls: string; label: string; title: string } {
  const state = bot?.state ?? 'unknown';
  const table = bot?.table || 'slack-squid-proxy';
  const map: Record<string, { cls: string; label: string }> = {
    active: { cls: 'text-emerald-700 bg-emerald-50 border-emerald-100', label: 'Bot active' },
    failed: { cls: 'text-red-700 bg-red-50 border-red-100', label: 'Bot failed' },
    inactive: { cls: 'text-amber-700 bg-amber-50 border-amber-100', label: 'Bot stopped' },
    unknown: { cls: 'text-slate-600 bg-slate-100 border-slate-200', label: 'Bot unknown' },
  };
  const m = map[state] ?? map['unknown']!;
  return { ...m, title: `${table} · ${state}${bot?.lastError ? ' — ' + bot.lastError : ''}` };
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

// ─── Live ops dashboard (telemetry) ──────────────────────────────────────────
function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="text-lg font-semibold text-slate-900 mt-1 tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-slate-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function Meter({ label, pct }: { label: string; pct: number | null }) {
  const v = pct ?? 0;
  const n = pct == null;
  return (
    <div className="card p-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
        <p className="text-xs font-medium text-slate-700 tabular-nums">{n ? '—' : `${v.toFixed(0)}%`}</p>
      </div>
      <div className="h-1.5 rounded-full bg-slate-100 mt-2 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${v > 85 ? 'bg-red-500' : v > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: n ? '0%' : `${Math.min(100, v)}%` }} />
      </div>
    </div>
  );
}

function OpsView({ proxyId }: { proxyId: string }) {
  const { data } = useQuery<TelemetrySummary>({
    queryKey: ['squid-telemetry', proxyId],
    queryFn: () => squidApi.telemetry(proxyId).then((r) => r.data as TelemetrySummary),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const l = data?.latest;
  if (!l) return (
    <div className="card p-8 text-center">
      <p className="text-sm font-medium text-slate-700 mb-1">No telemetry yet</p>
      <p className="text-xs text-slate-400">Live metrics appear once the agent&apos;s telemetry push lands. Update the agent to <span className="font-mono">squid-agent.sh</span> v1.2+ with the <span className="font-mono">squid-agent-telemetry.py</span> helper installed.</p>
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Requests (1h)" value={data!.hour.requests.toLocaleString()} />
        <StatCard label="Denied (1h)" value={data!.hour.denied.toLocaleString()} hint="Blocked by ACL rules" />
        <StatCard label="Active sessions" value={String(data!.sessions.length)} hint="Clients active in last 10 min" />
        <StatCard label="Data (1h)" value={fmtBytes(data!.hour.bytes)} hint={`${data!.hour.clients} clients`} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Meter label="CPU" pct={l.cpuPercent} />
        <Meter label="Memory" pct={l.memPercent} />
        <Meter label="Disk" pct={l.diskPercent} />
      </div>
      <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4 space-y-2 text-sm">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Add-on services</p>
          {(() => { const c = botChip(l.slackBot); return (
            <span title={c.title} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-semibold border ${c.cls}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${l.slackBot?.state === 'active' ? 'bg-emerald-500' : l.slackBot?.state === 'failed' ? 'bg-red-500' : 'bg-slate-400'}`} />
              {c.label}
            </span>
          ); })()}
        </div>
        <p className="text-slate-500 flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
          Slack bot <span className="font-mono text-xs text-slate-500">{l.slackBot?.table || 'slack-squid-proxy'}</span>{l.slackBot?.lastError ? <span className="text-red-600 font-mono text-xs">{l.slackBot.lastError}</span> : null}
        </p>
      </div>
      <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4 space-y-1.5 text-sm">
        <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Agent host</p>
        <p className="text-slate-500">Squid <span className="font-medium text-slate-700">{l.squidVersion || '—'}</span> · up <span className="font-medium text-slate-700">{fmtDuration(l.uptimeSeconds)}</span></p>
        <p className="text-slate-500">Snapshot {new Date(l.observedAt).toLocaleString()} · seq {l.seq}</p>
      </div>
      {data!.sessions.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">Active client sessions</p>
          <div className="grid sm:grid-cols-2 gap-1.5">
            {data!.sessions.map((s) => (
              <div key={s.clientIp} className="card px-3 py-2 flex items-center justify-between">
                <span className="font-mono text-xs text-slate-700">{s.clientIp}</span>
                <span className="text-[11px] text-slate-400">{ago(s.lastSeenAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div>
        <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">Usage report</p>
        <a href={squidApi.reportUrl(proxyId, 7)} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-800">
          Download 7-day report (CSV)
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
        </a>
      </div>
    </div>
  );
}

// ─── Usage report (daily aggregates from telemetry snapshots) ────────────────
interface ReportRow { day: string; requests: number; denied: number; bytes: number; clients: number }

function parseReport(csv: string): ReportRow[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  return lines.slice(1).map((l) => {
    const [day, requests, denied, bytes, clients] = l.split(',');
    return { day, requests: Number(requests), denied: Number(denied), bytes: Number(bytes), clients: Number(clients) };
  });
}

function ReportsView({ proxyId }: { proxyId: string }) {
  const [days, setDays] = useState(7);
  const { data } = useQuery<string>({
    queryKey: ['squid-report', proxyId, days],
    queryFn: () => squidApi.report(proxyId, days).then((r) => r.data as string),
  });
  if (!data) return (
    <div className="card p-8 text-center">
      <p className="text-sm font-medium text-slate-700 mb-1">No usage data yet</p>
      <p className="text-xs text-slate-400">Daily numbers appear once the agent&apos;s telemetry pushes cover a full day.</p>
    </div>
  );
  const rows = parseReport(data);
  if (!rows.length) return (
    <div className="card p-8 text-center">
      <p className="text-sm font-medium text-slate-700">No telemetry captured in the selected window</p>
    </div>
  );
  const total = rows.reduce((t, r) => ({ requests: t.requests + r.requests, denied: t.denied + r.denied, bytes: t.bytes + r.bytes, clients: t.clients + r.clients }), { requests: 0, denied: 0, bytes: 0, clients: 0 });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          {[7, 14, 30].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors cursor-pointer ${days === d ? 'bg-brand text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{d} days</button>
          ))}
        </div>
        <a href={squidApi.reportUrl(proxyId, days)} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-800">
          Download CSV
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
        </a>
      </div>
      <div className="rounded-xl border border-slate-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
            <tr><th className="text-left font-semibold px-3 py-2">Day</th><th className="text-right font-semibold px-3 py-2">Requests</th><th className="text-right font-semibold px-3 py-2">Denied</th><th className="text-right font-semibold px-3 py-2">Data</th><th className="text-right font-semibold px-3 py-2">Active clients</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.day} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs text-slate-700">{r.day}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{r.requests.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{r.denied.toLocaleString()}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtBytes(r.bytes)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{r.clients}</td>
              </tr>
            ))}
            <tr className="bg-slate-50 font-semibold text-slate-800">
              <td className="px-3 py-2 text-xs uppercase tracking-wider">Totals</td>
              <td className="px-3 py-2 text-right tabular-nums">{total.requests.toLocaleString()}</td>
              <td className="px-3 py-2 text-right tabular-nums">{total.denied.toLocaleString()}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtBytes(total.bytes)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{total.clients}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Live activity feed (recent access-log lines) ────────────────────────────
function ActivityView({ proxyId }: { proxyId: string }) {
  const [q, setQ] = useState('');
  const [denied, setDenied] = useState('');
  const { data } = useQuery<{ activity: ActivityRow[] }>({
    queryKey: ['squid-activity', proxyId, q, denied],
    queryFn: () => squidApi.activity(proxyId, { q: q || undefined, denied: denied || undefined, limit: 200 }).then((r) => r.data as { activity: ActivityRow[] }),
    refetchInterval: 5000,
  });
  const rows = data?.activity ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search URLs…" className="input text-sm flex-1 min-w-[180px]" />
        <select value={denied} onChange={(e) => setDenied(e.target.value)} className="input text-sm w-auto">
          <option value="">All actions</option>
          <option value="true">Denied only</option>
          <option value="false">Allowed only</option>
        </select>
      </div>
      {rows.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm font-medium text-slate-700 mb-1">No activity yet</p>
          <p className="text-xs text-slate-400">Recent access-log lines appear here (retained 48h). No telemetry push yet? Probe the proxy from a client first.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.observedAt + r.clientIp + r.url} className="card px-3 py-2 flex items-start gap-3">
              <span className={`mt-0.5 shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded w-[52px] text-center ${r.action === 'denied' ? 'text-red-700 bg-red-50' : 'text-emerald-700 bg-emerald-50'}`}>{r.action}</span>
              <span className="mt-0.5 shrink-0 font-mono text-[11px] text-slate-400">{new Date(r.observedAt).toLocaleTimeString()}</span>
              <span className="mt-0.5 shrink-0 font-mono text-[11px] text-slate-500">{r.clientIp}</span>
              <span className="mt-0.5 shrink-0 font-mono text-[11px] text-slate-400">{r.method}</span>
              <span className="text-xs text-slate-700 truncate flex-1" title={r.url}>{r.url}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Dependency finder (static-HTML scan → human ticks → whitelist) ──────────
function DependencyFinderModal({ proxyId, branchId, onClose, onAdd }: {
  proxyId: string; branchId: string; onClose: () => void; onAdd: (lines: string[]) => void;
}) {
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [scan, setScan] = useState<DepScanResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const run = useMutation({
    mutationFn: () => squidApi.dependencyScan(proxyId, { url: url.trim(), branchId }),
    onSuccess: (r) => { setScan(r.data as DepScanResult); setPicked(new Set((r.data as DepScanResult).dependencies.filter((d) => !d.self).map((d) => d.value))); },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not scan — the site may be unreachable or blocked as a private address.'),
  });
  const deps = scan?.dependencies ?? [];
  const toggle = (v: string) => setPicked((p) => { const n = new Set(p); if (n.has(v)) n.delete(v); else n.add(v); return n; });
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[82vh] overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between flex-shrink-0">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Dependency finder</p>
            <p className="text-sm text-slate-500 mt-0.5">Static HTML scan — no JavaScript is executed. Resources loaded via scripts won&apos;t show up (the Slack bot&apos;s Playwright <span className="font-mono text-xs">/discover</span> covers those).</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors cursor-pointer ml-3 flex-shrink-0" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Site to scan <span className="text-red-500">*</span></label>
            <input value={url} onChange={(e) => { setUrl(e.target.value); setScan(null); }} placeholder="https://example.com" className="input font-mono text-sm" />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {!scan ? (
            <GlowButton onClick={() => run.mutate()} disabled={!url.trim() || run.isPending} loading={run.isPending}>Scan for dependencies</GlowButton>
          ) : (
            <>
              <p className="text-xs text-slate-400">Final URL: <span className="font-mono">{scan.finalUrl}</span> · {deps.length} kept, {scan.excluded.length} filtered as tracking/ad/social noise.</p>
              {deps.length === 0 ? (
                <p className="text-sm text-slate-500">No external dependencies found in the HTML.</p>
              ) : (
                <div className="space-y-1.5 max-h-[240px] overflow-y-auto border border-slate-100 rounded-xl p-2">
                  {deps.map((d) => (
                    <label key={d.value} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer">
                      <input type="checkbox" checked={picked.has(d.value)} onChange={() => toggle(d.value)} className="accent-brand" />
                      <span className="font-mono text-xs text-slate-800 flex-1">{d.value}</span>
                      {d.self && <span className="text-[10px] font-semibold uppercase text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded" title="Same root as the scanned site — usually not needed">site itself</span>}
                      {d.category === 'cdn' && <span className="text-[10px] font-semibold uppercase text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">cdn</span>}
                    </label>
                  ))}
                </div>
              )}
              {scan.excluded.length > 0 && (
                <details>
                  <summary className="text-xs font-medium text-slate-500 cursor-pointer">Excluded ({scan.excluded.length}) — tracking / analytics / social / ads</summary>
                  <div className="mt-2 space-y-1">
                    {scan.excluded.map((d) => (
                      <p key={d.value} className="font-mono text-[11px] text-slate-400 flex items-center gap-2">
                        <span>{d.value}</span><span className="text-[10px] uppercase text-slate-300">({d.category})</span>
                      </p>
                    ))}
                  </div>
                </details>
              )}
              <div className="flex items-center gap-3 pt-1">
                <GlowButton onClick={() => { onAdd(deps.filter((d) => picked.has(d.value)).map((d) => '.' + d.value.replace(/^\./, ''))); onClose(); }}
                  disabled={picked.size === 0}>
                  Add {picked.size} to whitelist
                </GlowButton>
                <GlowButton variant="ghost" onClick={onClose}>Cancel</GlowButton>
              </div>
            </>
          )}
        </div>
      </motion.div>
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

// Bulk upload from a plain-text file, one entry per line (v1.12.6 bulk upload
// adapted to the textarea model). Every line still goes through the same
// server-side validation as a typed entry.
function FilePicker({ label, onLoad }: { label: string; onLoad: (text: string) => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input ref={ref} type="file" accept=".txt,.csv,text/plain" className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          if (f.size > 1_000_000) { notify('File too large — 1 MB max', 'error'); e.target.value = ''; return; }
          const r = new FileReader();
          r.onload = () => { onLoad(String(r.result ?? '')); };
          r.readAsText(f);
          e.target.value = '';
        }} />
      <GlowButton variant="ghost" className="py-0.5 px-2 text-[11px]" onClick={() => ref.current?.click()}>{label}</GlowButton>
    </>
  );
}

const countLines = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean).length;

type ListFieldProps = {
  label: string; value: string; onChange: (v: string) => void;
  rows: number; placeholder: string;
};
function ListField({ label, value, onChange, rows, placeholder }: ListFieldProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-semibold text-slate-600 uppercase tracking-wider">{label}</label>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-slate-400 tabular-nums">{countLines(value)} entries</span>
          <FilePicker label="Load from file" onLoad={(t) => onChange(value ? value + '\n' + t : t)} />
        </div>
      </div>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} placeholder={placeholder} className="input resize-none text-sm font-mono" />
    </div>
  );
}

function BranchEditor({ proxyId, branch, onDone }: { proxyId: string; branch: BranchView; onDone: () => void }) {
  const qc = useQueryClient();
  const [sources, setSources] = useState(branch.sources.join('\n'));
  const [wl, setWl] = useState(branch.whitelist.map((e) => (e.subdomain ? '.' : '') + e.value).join('\n'));
  const [bl, setBl] = useState(branch.blacklist.map((e) => (e.subdomain ? '.' : '') + e.value).join('\n'));
  const [finding, setFinding] = useState(false);
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
      <ListField label="Allowed source IPs / CIDRs" value={sources} onChange={setSources} rows={2}
        placeholder={'One per line, e.g.\n203.0.113.0/24\n198.51.100.10'} />
      <ListField label="Whitelist (allowed sites)" value={wl} onChange={setWl} rows={4}
        placeholder={'example.com\ngithub.com — prefix with a dot ( .example.com ) to include all subdomains'} />
      <ListField label="Blacklist (blocked sites)" value={bl} onChange={setBl} rows={3}
        placeholder={'bad.example.com — always wins over a whitelist match'} />
      <div className="flex items-center justify-between pt-0.5">
        <p className="text-[11px] text-slate-400">Add only sites the branch actually needs.</p>
        <GlowButton variant="secondary" className="py-1 px-2.5 text-xs" onClick={() => setFinding(true)}>Find dependencies</GlowButton>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <GlowButton onClick={() => save.mutate()} disabled={save.isPending} loading={save.isPending}>Save lists</GlowButton>
        <GlowButton variant="ghost" onClick={onDone}>Done</GlowButton>
      </div>
      <AnimatePresence>
        {finding && (
          <DependencyFinderModal
            proxyId={proxyId}
            branchId={branch.id}
            onClose={() => setFinding(false)}
            onAdd={(lines) => { setWl((prev) => (prev ? prev + '\n' : '') + lines.join('\n')); notify(`${lines.length} site${lines.length === 1 ? '' : 's'} added — review, then Save lists`, 'success'); }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Detail modal ────────────────────────────────────────────────────────────
// Tab groups keep the detail modal scannable: Monitor = live view, Configure =
// rules, Manage = maintenance. The dashboard starts on Live ops.
const TAB_GROUPS: { group: string; tabs: { key: 'branches' | 'ports' | 'ops' | 'activity' | 'reports' | 'history' | 'setup'; label: string }[] }[] = [
  { group: 'Monitor', tabs: [{ key: 'ops', label: 'Live ops' }, { key: 'activity', label: 'Activity' }, { key: 'reports', label: 'Reports' }] },
  { group: 'Configure', tabs: [{ key: 'branches', label: 'Branches' }, { key: 'ports', label: 'Ports & access' }, { key: 'setup', label: 'Install & keys' }] },
  { group: 'Manage', tabs: [{ key: 'history', label: 'Change log' }] },
];

function ProxyDetailModal({ proxySummary, onClose }: { proxySummary: ProxySummary; onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canEdit = user?.role === 'ORG_ADMIN';
  const [tab, setTab] = useState<'branches' | 'ports' | 'ops' | 'activity' | 'reports' | 'history' | 'setup'>('ops');
  const [branchFilter, setBranchFilter] = useState('');
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

  // SSE for real-time change request updates
  const { latestUpdate } = useChangeRequestStream(proxySummary.id, tab === 'history');

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
    mutationFn: () => squidApi.setFullAccess(proxySummary.id, {
      fullAccess: fa.filter((f) => f.src.trim()).map((f) => ({
        src: f.src.trim(),
        // The date input is day-precision only; the schema demands a full ISO
        // timestamp, so send local midnight (converts cleanly to UTC).
        ...(f.until ? { until: new Date(`${f.until}T00:00:00`).toISOString() } : {}),
      })),
    }),
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

  const q = branchFilter.trim().toLowerCase();
  const filteredBranches = detail.branches.filter(
    (b) => !q || b.name.toLowerCase().includes(q) || (b.description ?? '').toLowerCase().includes(q),
  );

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

        <div className="px-6 pt-3 border-b border-slate-100 flex-shrink-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {TAB_GROUPS.map(({ group, tabs: groupTabs }) => (
              <div key={group} className="flex items-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300 pr-1">{group}</span>
                {groupTabs.map(({ key, label }) => (
                  <button key={key} onClick={() => setTab(key)} className={`px-3 py-2 text-sm font-medium rounded-t-lg -mb-px border-b-2 transition-colors cursor-pointer ${tab === key ? 'border-brand text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
                    {label}
                  </button>
                ))}
              </div>
            ))}
          </div>
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
              {detail.branches.length > 0 && (
                <input value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}
                  placeholder={`Search ${detail.branches.length} branch${detail.branches.length === 1 ? '' : 'es'} by name or description…`}
                  className="input text-sm" />
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
              {filteredBranches.length === 0 ? (
                <div className="card p-8 text-center">
                  <p className="text-sm font-medium text-slate-700 mb-1">{q ? `No branches match "${q}"` : 'No branches yet'}</p>
                  <p className="text-xs text-slate-400">{q ? 'Try a different search term.' : 'Add your first branch to start publishing ACL rules to this proxy.'}</p>
                </div>
              ) : filteredBranches.map((b) => (
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
                      <div className="flex items-center gap-1">
                        {[1, 2, 4, 8, 24].map((h) => (
                          <button key={h} type="button" disabled={!row.src.trim()}
                            onClick={() => setFa(fa.map((r, j) => j === i ? { ...r, until: new Date(Date.now() + h * 3600e3).toLocaleDateString('en-CA') } : r))}
                            title={`Allow for another ${h} hour${h === 1 ? '' : 's'}`}
                            className="text-[11px] px-1.5 py-1 rounded border border-slate-200 text-slate-500 hover:border-brand-200 hover:text-brand-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                            +{h}h
                          </button>
                        ))}
                      </div>
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

          {tab === 'ops' && <OpsView proxyId={proxySummary.id} />}

          {tab === 'activity' && <ActivityView proxyId={proxySummary.id} />}
          {tab === 'reports' && <ReportsView proxyId={proxySummary.id} />}

          {tab === 'history' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-500">Every requested config change is recorded as a ticket-style entry — from the Slack bot, the dashboard, or an API client.</p>
                {latestUpdate && (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100 animate-pulse">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    Live update received
                  </span>
                )}
              </div>
              {(changes?.changeRequests?.length ?? 0) === 0 ? (
                <div className="card p-8 text-center">
                  <p className="text-sm font-medium text-slate-700 mb-1">No change requests yet</p>
                  <p className="text-xs text-slate-400">Requests appear here the moment a branch, list, port, or access rule changes.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {changes!.changeRequests.map((c) => {
                    // Use live update if it matches this change request
                    const live = latestUpdate && latestUpdate.id === c.id ? latestUpdate : c;
                    const status = live.status ?? 'PENDING_APPROVAL';
                    return (
                      <div key={c.id} className="card p-3 flex items-start gap-3">
                        <span className={`mt-0.5 shrink-0 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${c.source === 'WEB' ? 'text-blue-700 bg-blue-50' : 'text-slate-600 bg-slate-100'}`}>{c.source}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 truncate">{c.summary}</p>
                          <div className="flex items-center gap-3 mt-1 flex-wrap">
                            <p className="text-[11px] text-slate-400 font-mono">{c.action} · {new Date(c.createdAt).toLocaleString()}</p>
                            <StatusBadge status={status} />
                            {live.ticketId && live.ticketUrl && (
                              <a href={live.ticketUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-brand-700 hover:text-brand-800 font-mono underline">
                                Ticket: {live.ticketId}
                              </a>
                            )}
                            {live.appliedSeq != null && <span className="text-[11px] text-slate-400">applied seq: {live.appliedSeq}</span>}
                          </div>
                          {live.error && <p className="text-[11px] text-red-600 mt-1">Error: {live.error}</p>}
                        </div>
                      </div>
                    );
                  })}
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
  const isPlatformAdmin = user?.role === 'ADMINISTRATOR';
  const isOrgAdmin = user?.role === 'ORG_ADMIN';
  const canEdit = isOrgAdmin || isPlatformAdmin;
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
              {/* Platform admin creates proxies via /saas-admin/squid; org admins manage assigned proxies only */}
              {isPlatformAdmin && <GlowButton onClick={() => setCreating(true)}>New proxy</GlowButton>}
            </div>

            {isLoading ? (
              <div className="space-y-3">{[...Array(2)].map((_, i) => <Shimmer key={i} className="h-20 rounded-xl" />)}</div>
            ) : proxies.length === 0 ? (
              <div className="card p-12 text-center">
                <p className="text-sm font-medium text-slate-700 mb-1">
                  {isPlatformAdmin ? 'No proxies yet — click "New proxy" to provision one for an organization' : 'No proxies assigned to your organization'}
                </p>
                <p className="text-xs text-slate-400">
                  {isPlatformAdmin 
                    ? 'Provision a proxy, assign it to an organization, and pair it with the agent package on the target host.'
                    : 'Contact your platform administrator to provision a squid proxy for your organization.'
                  }
                </p>
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
                          {(() => { const c = botChip(p.slackBot); return <span title={c.title} className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border ${c.cls}`}>{c.label}</span>; })()}
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
        {isPlatformAdmin && creating && <CreateProxyModal onClose={() => setCreating(false)} />}
        {open && <ProxyDetailModal proxySummary={open} onClose={() => setOpen(null)} />}
      </AnimatePresence>
    </RoleGuard>
  );
}