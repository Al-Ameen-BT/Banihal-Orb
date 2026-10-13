'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { squidApi } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { icons } from '@/components/ui/Sidebar';
import { Shimmer } from '@/components/ui/Shimmer';
import { useAuth } from '@/contexts/AuthContext';
import { roleGuard } from '@/components/guards/RoleGuard';

type Role = 'USER' | 'ORG_ADMIN' | 'ADMINISTRATOR';

interface ProxyBotStatus {
  linked: boolean;
  bot: {
    id: string;
    name: string;
    slug: string;
    enabled: boolean;
    status: string;
    lastCheckedAt: string | null;
    lastError: string | null;
  } | null;
  state: {
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
  } | null;
  rules: { active: number; expiringIn24h: number } | null;
  commands: { pending: number; dispatched: number; acked: number; failed: number; timedOut: number } | null;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function statusDot(status: string, healthy: string, unhealthy: string, unknown: string): React.ReactNode {
  const s = status?.toUpperCase() ?? '';
  if (s === healthy) return <span className="inline-flex items-center gap-1.5 text-emerald-600"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Connected</span>;
  if (s === unhealthy) return <span className="inline-flex items-center gap-1.5 text-rose-600"><span className="w-2 h-2 rounded-full bg-rose-500" /> Disconnected</span>;
  if (s === 'ERROR') return <span className="inline-flex items-center gap-1.5 text-rose-600"><span className="w-2 h-2 rounded-full bg-rose-500" /> Error</span>;
  return <span className="inline-flex items-center gap-1.5 text-slate-400"><span className="w-2 h-2 rounded-full bg-slate-300" /> {s || unknown}</span>;
}

function StatusPageContent({ params }: { params: Promise<{ id: string }> }) {
  const { id: proxyId } = params;

  const { data: statusData, isLoading, refetch } = useQuery({
    queryKey: ['squid-bot-status', proxyId],
    queryFn: () => squidApi.telemetry(proxyId).then((r) => r.data as ProxyBotStatus),
    refetchInterval: 15_000,
  });

  const status = statusData?.data;

  if (isLoading && !status) {
    return (
      <div className="p-6 sm:p-8 max-w-[1100px] mx-auto space-y-6">
        <PageHeader
          eyebrow="Security"
          title="Squid Proxy"
          icon={icons.squid}
          subtitle="Bot health, Squid service state, and command pipeline"
        />
        <div className="space-y-3">{[...Array(3)].map((_, i) => <Shimmer key={i} className="h-20 rounded-xl" />)}</div>
      </div>
    );
  }

  const bot = status?.bot;
  const state = status?.state;
  const linked = status?.linked ?? false;

  return (
    <div className="p-6 sm:p-8 max-w-[1100px] mx-auto space-y-6">
      <PageHeader
        eyebrow="Security"
        title="Bot & Host Status"
        icon={icons.squid}
        subtitle={linked
          ? `Host bot ${bot?.name ?? '—'} (${bot?.slug ?? '—'}) · Last polled ${formatRelativeTime(state?.observedAt)}`
          : 'No host bot linked to this proxy — provision one in /saas-admin/squid'}
      />

      {/* Link status card */}
      <div className="card p-6">
        <div className="flex items-center gap-4">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${linked ? 'bg-emerald-50' : 'bg-slate-100'}`}>
            <svg className={`w-7 h-7 ${linked ? 'text-emerald-600' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d={linked ? 'M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244' : 'M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z'} />
            </svg>
          </div>
          <div>
            <p className="text-lg font-semibold text-slate-900">
              {linked ? 'Host Bot Linked' : 'No Host Bot Linked'}
            </p>
            <p className="text-sm text-slate-500">
              {linked
                ? `Bot ${bot?.name} (${bot?.slug}) is the executor for per-IP rule changes.`
                : 'Provision a bot in Platform Control Plane and assign it to this proxy.'}
            </p>
          </div>
        </div>
        {linked && bot && (
          <div className="mt-4 grid sm:grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-slate-400">Bot Status</p>
              <p className="font-medium">{statusDot(bot.status, 'CONNECTED', 'DISCONNECTED', 'Unknown')}</p>
            </div>
            <div>
              <p className="text-slate-400">Enabled</p>
              <p className="font-medium">{bot.enabled ? 'Yes' : 'No'}</p>
            </div>
            <div>
              <p className="text-slate-400">Last Checked</p>
              <p className="font-medium">{formatRelativeTime(bot.lastCheckedAt)}</p>
            </div>
          </div>
        )}
      </div>

      {linked && state && (
        <>
          {/* Host bot telemetry */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="card p-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Socket</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">
                {state.socketConnected ? (
                  <span className="text-emerald-600">● Connected</span>
                ) : (
                  <span className="text-rose-600">○ Disconnected</span>
                )}
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Last event: {formatRelativeTime(state.lastEventAt)}
              </p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Messages (session)</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{state.msgCount}</p>
              <p className="text-xs text-slate-400 mt-1">Since socket connect</p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Instance</p>
              <p className="text-sm font-mono text-slate-900 mt-1 truncate">{state.instanceId ?? '—'}</p>
              <p className="text-xs text-slate-400 mt-1">Version: {state.version ?? '—'}</p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Bot Status</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">
                {statusDot(state.status, 'CONNECTED', 'DISCONNECTED', 'Unknown')}
              </p>
            </div>
          </div>

          {/* Squid service health */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="card p-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Squid Service</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">
                {state.squidActive ? (
                  <span className="text-emerald-600">● Running</span>
                ) : (
                  <span className="text-rose-600">○ Stopped</span>
                )}
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Last reload: {formatRelativeTime(state.squidLastReloadAt)}
              </p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Config Parse</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">
                {state.squidParseOk === true ? (
                  <span className="text-emerald-600">✓ OK</span>
                ) : state.squidParseOk === false ? (
                  <span className="text-rose-600">✗ Failed</span>
                ) : (
                  <span className="text-slate-400">Unknown</span>
                )}
              </p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Active Rules</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{status.rules?.active ?? 0}</p>
              <p className="text-xs text-slate-400 mt-1">
                {status.rules?.expiringIn24h ?? 0} expiring in 24h
              </p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Bot Errors</p>
              <p className="text-sm text-slate-900 mt-1 truncate max-w-[180px]">
                {state.lastError ?? 'None'}
              </p>
            </div>
          </div>

          {/* Command pipeline */}
          <div className="card p-6">
            <p className="text-sm font-semibold text-slate-900 mb-4">Command Pipeline (last 24h)</p>
            <div className="grid sm:grid-cols-5 gap-4">
              {[
                { key: 'pending', label: 'Pending', value: status.commands?.pending ?? 0, color: 'amber' },
                { key: 'dispatched', label: 'Dispatched', value: status.commands?.dispatched ?? 0, color: 'brand' },
                { key: 'acked', label: 'Acked', value: status.commands?.acked ?? 0, color: 'emerald' },
                { key: 'failed', label: 'Failed', value: status.commands?.failed ?? 0, color: 'rose' },
                { key: 'timedOut', label: 'Timed Out', value: status.commands?.timedOut ?? 0, color: 'red' },
              ].map((c) => (
                <div key={c.key} className="text-center p-3 bg-slate-50 rounded-xl">
                  <p className="text-3xl font-bold text-slate-900">{c.value}</p>
                  <p className={`text-xs font-medium text-${c.color}-700 mt-1`}>{c.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Discovery */}
          {state.discovery && state.discovery.deps.length > 0 && (
            <details className="card group">
              <summary className="flex items-center gap-2 p-4 cursor-pointer list-none">
                <svg className="w-5 h-5 text-slate-400 group-open:rotate-90 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9 5l7 7-7 7" />
                </svg>
                <span className="font-medium text-slate-900">Last Dependency Discovery</span>
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

          {/* Raw state (debug) */}
          <details className="card group">
            <summary className="flex items-center gap-2 p-4 cursor-pointer list-none text-sm text-slate-500">
              <svg className="w-5 h-5 group-open:rotate-90 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9 5l7 7-7 7" />
              </svg>
              <span>Raw State Snapshot (debug)</span>
            </summary>
            <div className="px-4 pb-4 pt-0 border-t border-slate-100">
              <pre className="text-[10px] bg-slate-900 text-slate-100 p-4 rounded overflow-auto max-h-64">
                {JSON.stringify(state.raw, null, 2)}
              </pre>
            </div>
          </details>
        </>
      )}

      {!linked && (
        <div className="card p-8 text-center">
          <svg className="w-16 h-16 mx-auto text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <h3 className="mt-4 text-lg font-semibold text-slate-900">No Host Bot Linked</h3>
          <p className="mt-2 text-sm text-slate-500 max-w-md mx-auto">
            This proxy has no Slack bot with <code className="font-mono bg-slate-100 px-1 rounded">workerMode=SQUID_BOT</code> assigned.
            Go to <a href="/saas-admin/squid" className="text-brand hover:underline">Platform Control Plane → Squid Proxies</a>
            to provision a bot and link it to this proxy.
          </p>
        </div>
      )}
    </div>
  );
}

export default function StatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = useAuth();
  const allowedRoles: Role[] = ['ORG_ADMIN', 'ADMINISTRATOR'];
  return roleGuard(allowedRoles, <StatusPageContent params={params} />);
}