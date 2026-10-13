'use client';

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { squidApi } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { icons } from '@/components/ui/Sidebar';
import GlowButton from '@/components/ui/GlowButton';
import { Shimmer } from '@/components/ui/Shimmer';
import RoleGuard from '@/components/guards/RoleGuard';
import { notify } from '@/lib/toast-bus';

type Role = 'USER' | 'ORG_ADMIN' | 'ADMINISTRATOR';

interface ProxySummary {
  id: string;
  name: string;
  description: string | null;
  status: string;
}

interface ChangeRequest {
  id: string;
  proxyId: string;
  customerId: string;
  actorId: string | null;
  source: string;
  action: string;
  summary: string;
  details: {
    ip: string;
    domain?: string;
    hours?: number;
    reason?: string;
    requester?: { kind: 'web' | 'slack'; userId?: string; name?: string; email?: string; slackUserId?: string; slackUserName?: string; channelId?: string };
    via?: string;
    isDestIp?: boolean;
  };
  ticketId: string | null;
  ticketUrl: string | null;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'DISPATCHED' | 'REJECTED' | 'APPLIED' | 'FAILED';
  appliedSeq: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ChangeReceipt {
  changeRequestId: string;
  ticketId: string | null;
  ticketNumber: string | null;
  status: 'pending_approval';
  webUrl: string | null;
}

type ActionType = 'allow' | 'deny' | 'extend' | 'full-net' | 'lock-net';

const ACTION_LABELS: Record<ActionType, string> = {
  allow: 'Allow Domain',
  deny: 'Deny Domain',
  extend: 'Extend Expiry',
  'full-net': 'Full Net Override',
  'lock-net': 'Lock Net (Revoke Full Net)',
};

const ACTION_DESCRIPTIONS: Record<ActionType, string> = {
  allow: 'Grant access to a domain (or destination IP) for a specific client IP',
  deny: 'Revoke access to a domain for a specific client IP',
  extend: 'Add time to an existing allow rule',
  'full-net': 'Grant unrestricted internet access to a client IP (requires approval)',
  'lock-net': 'Revoke a previously granted full-net override',
};

const ACTION_REQUIRES_DOMAIN: Record<ActionType, boolean> = {
  allow: true,
  deny: true,
  extend: true,
  'full-net': false,
  'lock-net': false,
};

const ACTION_REQUIRES_HOURS: Record<ActionType, boolean | 'optional'> = {
  allow: 'optional',
  deny: false,
  extend: true,
  'full-net': false,
  'lock-net': false,
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function statusBadge(status: ChangeRequest['status']) {
  const config: Record<string, { label: string; class: string }> = {
    PENDING_APPROVAL: { label: 'Pending Approval', class: 'bg-amber-50 text-amber-700' },
    APPROVED: { label: 'Approved', class: 'bg-cyan-50 text-cyan-700' },
    DISPATCHED: { label: 'Dispatched to Host', class: 'bg-brand-50 text-brand-700' },
    REJECTED: { label: 'Declined', class: 'bg-rose-50 text-rose-700' },
    APPLIED: { label: 'Applied', class: 'bg-emerald-50 text-emerald-700' },
    FAILED: { label: 'Failed', class: 'bg-red-50 text-red-700' },
  };
  const c = config[status] ?? { label: status, class: 'bg-slate-100 text-slate-700' };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${c.class}`}>{c.label}</span>;
}

function sourceBadge(source: string) {
  const config: Record<string, { label: string; class: string }> = {
    WEB: { label: 'Web', class: 'bg-brand-50 text-brand-700' },
    SLACK: { label: 'Slack', class: 'bg-emerald-50 text-emerald-700' },
    API: { label: 'API', class: 'bg-violet-50 text-violet-700' },
  };
  const c = config[source] ?? { label: source, class: 'bg-slate-100 text-slate-700' };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${c.class}`}>{c.label}</span>;
}

function ActionForm({ proxyId, onSuccess }: { proxyId: string; onSuccess: (receipt: ChangeReceipt) => void }) {
  const [action, setAction] = useState<ActionType>('allow');
  const [ip, setIp] = useState('');
  const [domain, setDomain] = useState('');
  const [hours, setHours] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (body: { action: ActionType; ip: string; domain?: string; hours?: number; reason?: string }) =>
      squidApi.listChangeRequests(proxyId).then(r => r.data as { changeRequests: ChangeRequest[] }).then(() => 
        fetch(`/api/squid/${proxyId}/change-requests`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(async res => {
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(err.error ?? 'Failed to create change request');
          }
          return res.json() as Promise<ChangeReceipt>;
        })
      ),
    onSuccess: (receipt) => {
      setSubmitting(false);
      setError(null);
      notify('Change request submitted — awaiting approval', 'success');
      onSuccess(receipt);
      setIp(''); setDomain(''); setHours(''); setReason('');
    },
    onError: (e: Error) => {
      setSubmitting(false);
      setError(e.message);
    },
  });

  const requiresDomain = ACTION_REQUIRES_DOMAIN[action];
  const requiresHours = ACTION_REQUIRES_HOURS[action];
  const hoursLabel = action === 'allow' ? 'Expiry (hours, optional)' : 'Expiry (hours, required)';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!ip.trim()) { setError('Client IP is required'); return; }
    if (requiresDomain && !domain.trim()) { setError(`${ACTION_LABELS[action]} requires a domain`); return; }
    if (requiresHours === true && !hours.trim()) { setError('Hours is required'); return; }
    if (requiresHours !== false && hours && +hours <= 0) { setError('Hours must be greater than 0'); return; }
    if ((action === 'deny' || action === 'full-net' || action === 'lock-net') && hours) { setError(`${ACTION_LABELS[action]} does not take hours`); return; }

    mutation.mutate({
      action,
      ip: ip.trim(),
      domain: domain.trim() || undefined,
      hours: hours ? +hours : undefined,
      reason: reason.trim() || undefined,
    });
  };

  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center gap-3">
        <svg className="w-8 h-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
        <div>
          <p className="font-semibold text-slate-900">{ACTION_LABELS[action]}</p>
          <p className="text-xs text-slate-500">{ACTION_DESCRIPTIONS[action]}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <select
          value={action}
          onChange={(e) => setAction(e.target.value as ActionType)}
          className="w-full sm:w-64 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        >
          {(['allow', 'deny', 'extend', 'full-net', 'lock-net'] as ActionType[]).map((a) => (
            <option key={a} value={a}>{ACTION_LABELS[a]}</option>
          ))}
        </select>

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Client IP <span className="text-rose-500">*</span></label>
            <input
              type="text"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="e.g. 10.0.0.5"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              autoComplete="off"
            />
          </div>
          {requiresDomain && (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Domain / Destination IP <span className="text-rose-500">*</span></label>
              <input
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.com or 192.0.2.1"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                autoComplete="off"
              />
            </div>
          )}
        </div>

        {requiresHours !== false && (
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              {hoursLabel} {requiresHours === true ? <span className="text-rose-500">*</span> : <span className="text-slate-400">(indefinite if empty)</span>}
            </label>
            <input
              type="number"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              placeholder="e.g. 24"
              min="1"
              max="876000"
              className="w-full sm:w-64 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Reason (optional, max 500 chars)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Brief justification for the change request…"
            maxLength={500}
            rows={2}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>

        {error && <p className="text-sm text-rose-600 bg-rose-50 p-2 rounded">{error}</p>}

        <GlowButton type="submit" disabled={submitting} className="w-full sm:w-auto">
          {submitting ? 'Submitting…' : 'Submit Change Request'}
        </GlowButton>
      </form>
    </div>
  );
}

function RequestsList({ proxyId }: { proxyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['squid-change-requests', proxyId],
    queryFn: () => squidApi.listChangeRequests(proxyId).then((r) => r.data as { changeRequests: ChangeRequest[] }),
    refetchInterval: 15_000,
  });

  const requests = useMemo(() => data?.changeRequests ?? [], [data]);

  if (isLoading) {
    return <div className="space-y-3">{[...Array(3)].map((_, i) => <Shimmer key={i} className="h-16 rounded-xl" />)}</div>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400 font-medium">Recent Change Requests (auto-refreshes)</p>
      {requests.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm font-medium text-slate-700">No change requests yet</p>
          <p className="text-xs text-slate-400 mt-1">Submit your first request using the form above</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-100">
                <th className="pb-2">Action</th>
                <th className="pb-2">Target</th>
                <th className="pb-2">Source</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Requested</th>
                <th className="pb-2">Approver / Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {requests.map((cr) => (
                <tr key={cr.id} className="hover:bg-slate-50">
                  <td className="py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-brand-50 text-brand-700">
                      {cr.action.replace('BOT_', '').replace(/_/g, '-').toLowerCase()}
                    </span>
                  </td>
                  <td className="py-3 font-mono text-sm">
                    {cr.details.ip} {cr.details.domain && <span className="text-slate-400 ml-1">→ {cr.details.domain}</span>}
                    {cr.details.hours && <span className="text-slate-400 ml-1">({cr.details.hours}h)</span>}
                  </td>
                  <td className="py-3">{sourceBadge(cr.source)}</td>
                  <td className="py-3">{statusBadge(cr.status)}</td>
                  <td className="py-3 text-slate-600">{formatDate(cr.createdAt)}</td>
                  <td className="py-3 text-slate-500">
                    {cr.status === 'PENDING_APPROVAL' && 'Awaiting approval…'}
                    {cr.status === 'APPROVED' && 'Approved — awaiting dispatch'}
                    {cr.status === 'DISPATCHED' && 'Sent to host bot'}
                    {cr.status === 'APPLIED' && cr.appliedSeq && <span className="font-mono">seq {cr.appliedSeq}</span>}
                    {cr.status === 'REJECTED' && 'Declined by approver'}
                    {cr.status === 'FAILED' && cr.error && <span className="text-rose-600">{cr.error}</span>}
                    {cr.ticketUrl && (
                      <a href={cr.ticketUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-brand hover:underline ml-2">
                        View Ticket →
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RequestsPageContent({ params }: { params: { id: string } }) {
  const { id: proxyId } = params;
  const queryClient = useQueryClient();

  const { data: proxyData } = useQuery({
    queryKey: ['squid-proxy', proxyId],
    queryFn: () => squidApi.get(proxyId),
    staleTime: 30_000,
  });

  const handleSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['squid-change-requests', proxyId] });
  };

  return (
    <div className="p-6 sm:p-8 max-w-[1100px] mx-auto space-y-6">
      <PageHeader
        eyebrow="Security"
        title={proxyData?.data?.name ?? 'Squid Proxy'}
        icon={icons.squid}
        subtitle={`Change Requests · ${proxyData?.data?.description ?? 'No description'}`}
      />

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <ActionForm proxyId={proxyId} onSuccess={handleSuccess} />
        </div>
        <div className="lg:col-span-2">
          <RequestsList proxyId={proxyId} />
        </div>
      </div>
    </div>
  );
}

export default function RequestsPage({ params }: { params: { id: string } }) {
  const allowedRoles: Role[] = ['ORG_ADMIN', 'ADMINISTRATOR'];
  return (
    <RoleGuard allowedRoles={allowedRoles}>
      <RequestsPageContent params={params} />
    </RoleGuard>
  );
}