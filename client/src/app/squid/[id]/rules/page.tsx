'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { squidApi } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { icons } from '@/components/ui/Sidebar';
import { Shimmer } from '@/components/ui/Shimmer';
import RoleGuard from '@/components/guards/RoleGuard';
import { notify } from '@/lib/toast-bus';

type Role = 'USER' | 'ORG_ADMIN' | 'ADMINISTRATOR';

interface SquidBotRule {
  id: string;
  botId: string;
  customerId: string;
  proxyId: string | null;
  ip: string;
  domain: string;
  isDestIp: boolean;
  app: string | null;
  expiresAt: string | null;
  lastSeenAt: string;
  details?: { discoveryDeps?: string[] };
}

interface SquidBotState {
  botId: string;
  customerId: string;
  proxyId: string | null;
  instanceId: string | null;
  version: string | null;
  status: string;
  socketConnected: boolean;
  lastEventAt: string | null;
  msgCount: number;
  squidActive: boolean;
  squidParseOk: boolean | null;
  squidLastReloadAt: string | null;
  domainCount: number;
  discovery: { domain: string; deps: string[]; at: number } | null;
  lastError: string | null;
  raw: Record<string, unknown>;
  observedAt: string;
  createdAt: string;
  updatedAt: string;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function formatRelativeTime(iso: string | number | null | undefined): string {
  if (iso == null || iso === '') return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function expiryBadge(expiresAt: string | null): React.ReactNode {
  if (!expiresAt) return <span className="text-emerald-600 font-mono text-xs">indefinite</span>;
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return <span className="text-rose-600 font-mono text-xs">expired</span>;
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (hours > 24) return <span className="text-amber-600 font-mono text-xs">{Math.floor(hours / 24)}d {hours % 24}h</span>;
  if (hours > 0) return <span className="text-amber-600 font-mono text-xs">{hours}h {minutes}m</span>;
  return <span className="text-rose-600 font-mono text-xs">{minutes}m</span>;
}

function sourceBadge(source: 'web' | 'slack' | 'unknown'): React.ReactNode {
  const config = {
    web: { label: 'Web', class: 'bg-brand-50 text-brand-700' },
    slack: { label: 'Slack', class: 'bg-emerald-50 text-emerald-700' },
    unknown: { label: 'Unknown', class: 'bg-slate-100 text-slate-700' },
  };
  const c = config[source];
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${c.class}`}>{c.label}</span>;
}

function RulesPageContent({ params }: { params: { id: string } }) {
  const { id: proxyId } = params;

  const { data: rulesData, isLoading: rulesLoading, refetch: refetchRules } = useQuery({
    queryKey: ['squid-bot-rules', proxyId],
    queryFn: async () => {
      // The bot status endpoint returns rules; we also need the bot state for discovery
      const statusRes = await squidApi.telemetry(proxyId);
      return statusRes.data as { rules?: SquidBotRule[]; state?: SquidBotState };
    },
    refetchInterval: 30_000,
  });

  const [filterIp, setFilterIp] = useState('');
  const [filterDomain, setFilterDomain] = useState('');
  const [showExpired, setShowExpired] = useState(false);

  const rules = useMemo(() => {
    const all = (rulesData?.rules ?? []) as SquidBotRule[];
    return all.filter((r) => {
      if (!showExpired && r.expiresAt && new Date(r.expiresAt).getTime() <= Date.now()) return false;
      if (filterIp && !r.ip.includes(filterIp)) return false;
      if (filterDomain && !r.domain.toLowerCase().includes(filterDomain.toLowerCase())) return false;
      return true;
    });
  }, [rulesData, filterIp, filterDomain, showExpired]);

  const state = rulesData?.state as SquidBotState | undefined;

  if (rulesLoading && !rules) {
    return (
      <div className="p-6 sm:p-8 max-w-[1100px] mx-auto space-y-6">
        <PageHeader
          eyebrow="Security"
          title="Squid Proxy"
          icon={icons.squid}
          subtitle="Active rules mirror — synced from the host bot"
        />
        <div className="space-y-3">{[...Array(3)].map((_, i) => <Shimmer key={i} className="h-16 rounded-xl" />)}</div>
      </div>
    );
  }

  const botLinked = !!state?.botId;

  return (
    <div className="p-6 sm:p-8 max-w-[1100px] mx-auto space-y-6">
      <PageHeader
        eyebrow="Security"
        title="Active Rules"
        icon={icons.squid}
        subtitle={botLinked
          ? `Mirror of the host bot's domains.json · {rules.length} rule{rules.length !== 1 ? 's' : ''} · Last seen {formatRelativeTime(state?.observedAt)}`
          : 'No host bot linked — rules will appear once the bot connects'}
      />

      {/* Bot status summary */}
      <div className="grid sm:grid-cols-3 gap-4">
        <div className="card p-4">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Bot Status</p>
          <p className="text-2xl font-semibold text-slate-900 mt-1">
            {state?.status === 'CONNECTED' ? (
              <span className="text-emerald-600">● Connected</span>
            ) : state?.status === 'DISCONNECTED' ? (
              <span className="text-slate-400">○ Disconnected</span>
            ) : (
              <span className="text-rose-600">⚠ {state?.status}</span>
            )}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Instance: <span className="font-mono text-slate-600">{state?.instanceId ?? '—'}</span>
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Squid Service</p>
          <p className="text-2xl font-semibold text-slate-900 mt-1">
            {state?.squidActive ? (
              <span className="text-emerald-600">● Running</span>
            ) : (
              <span className="text-rose-600">○ Stopped</span>
            )}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Last reload: {formatRelativeTime(state?.squidLastReloadAt)}
            {state?.squidParseOk === false && <span className="ml-2 text-rose-600">⚠ parse failed</span>}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Rules & Discovery</p>
          <p className="text-2xl font-semibold text-slate-900 mt-1">{rules.length} active</p>
          <p className="text-xs text-slate-400 mt-1">
            {state?.discovery && (
              <>
                Last scan: <span className="font-mono text-slate-600">{formatRelativeTime(state.discovery.at)}</span>{' '}
                → {state.discovery.deps?.length ?? 0} deps
              </>
            )}
            {state?.lastError && <span className="text-rose-600 ml-2">Last error: {state.lastError}</span>}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4 flex flex-wrap gap-4 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-slate-700 mb-1">Filter by Client IP</label>
          <input
            type="text"
            value={filterIp}
            onChange={(e) => setFilterIp(e.target.value)}
            placeholder="e.g. 10.0.0"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-slate-700 mb-1">Filter by Domain</label>
          <input
            type="text"
            value={filterDomain}
            onChange={(e) => setFilterDomain(e.target.value)}
            placeholder="e.g. github.com"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={showExpired}
            onChange={(e) => setShowExpired(e.target.checked)}
            className="rounded border-slate-300 text-brand focus:ring-brand"
          />
          Show expired
        </label>
        {rules.length > 0 && (
          <button
            onClick={() => { refetchRules(); notify('Refreshed from host bot', 'info'); }}
            className="px-3 py-2 text-sm font-medium text-brand hover:text-brand-700 hover:bg-brand-50 rounded-lg transition-colors"
          >
            Refresh Now
          </button>
        )}
      </div>

      {/* Rules Table */}
      {rules.length === 0 ? (
        <div className="card p-12 text-center">
          <svg className="w-12 h-12 mx-auto text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p className="mt-3 text-sm font-medium text-slate-700">No active rules</p>
          <p className="text-xs text-slate-400 mt-1">
            {botLinked ? 'The bot has no active allow rules for this proxy.' : 'Link a host bot to this proxy to see its active rules.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-100">
                <th className="pb-2">Client IP</th>
                <th className="pb-2">Domain / Destination IP</th>
                <th className="pb-2">Expiry</th>
                <th className="pb-2">Source</th>
                <th className="pb-2">App / Special</th>
                <th className="pb-2">Last Seen</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rules.map((r) => {
                const isExpired = r.expiresAt && new Date(r.expiresAt).getTime() <= Date.now();
                const source = r.app === 'slack' ? 'slack' : r.app === 'web' ? 'web' : r.app ? r.app : 'unknown';
                return (
                  <tr key={r.id} className={isExpired ? 'bg-rose-25' : 'hover:bg-slate-50'}>
                    <td className="py-3 font-mono text-slate-900">{r.ip}</td>
                    <td className="py-3">
                      <span className={r.isDestIp ? 'text-rose-600 font-mono' : 'font-mono'}>{r.domain}</span>
                      {r.isDestIp && <span className="ml-1 text-[10px] bg-rose-50 text-rose-600 px-1.5 py-0.5 rounded">dest IP</span>}
                    </td>
                    <td className="py-3 font-mono text-xs">{expiryBadge(r.expiresAt)}</td>
                    <td className="py-3">{sourceBadge(source as 'web' | 'slack' | 'unknown')}</td>
                    <td className="py-3 text-slate-500 font-mono text-xs">{r.app ?? '—'}</td>
                    <td className="py-3 text-slate-500 text-xs">{formatRelativeTime(r.lastSeenAt)}</td>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        {r.details?.discoveryDeps && r.details.discoveryDeps.length > 0 && (
                          <span className="text-[10px] text-slate-400" title={r.details.discoveryDeps.join(', ')}>
                            🔍 {r.details.discoveryDeps.length} deps
                          </span>
                        )}
                        <button
                          className="text-xs text-brand hover:text-brand-700 hover:underline"
                          onClick={() => navigator.clipboard.writeText(`${r.ip} ${r.domain} ${r.expiresAt ?? 'indefinite'}`)}
                        >
                          Copy
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Discovery deps panel */}
      {state?.discovery && state.discovery.deps.length > 0 && (
        <details className="card group">
          <summary className="flex items-center gap-2 p-4 cursor-pointer list-none">
            <svg className="w-5 h-5 text-slate-400 group-open:rotate-90 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9 5l7 7-7 7" />
            </svg>
            <span className="font-medium text-slate-900">Dependency Discovery for <code className="font-mono text-brand bg-brand-50 px-1 rounded">{state.discovery.domain}</code></span>
            <span className="text-xs text-slate-400 ml-auto">Scanned {formatRelativeTime(state.discovery.at)} · {state.discovery.deps.length} dependencies</span>
          </summary>
          <div className="px-4 pb-4 pt-0 border-t border-slate-100">
            <div className="flex flex-wrap gap-2">
              {state.discovery.deps.map((dep, i) => (
                <span key={i} className="text-xs font-mono bg-slate-50 text-slate-700 px-2 py-1 rounded border border-slate-100">{dep}</span>
              ))}
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

export default function RulesPage({ params }: { params: { id: string } }) {
  const allowedRoles: Role[] = ['ORG_ADMIN', 'ADMINISTRATOR'];
  return (
    <RoleGuard allowedRoles={allowedRoles}>
      <RulesPageContent params={params} />
    </RoleGuard>
  );
}