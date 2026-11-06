'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { squidAdminApi, squidApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';

type Proxy = { id: string; name: string; customerId: string; status: string; lastSeenAt: string | null; revision: number; appliedSeq: number };
type Change = { id: string; summary: string; status: string; ticketId: string | null; ticketUrl: string | null };
type Automation = { paused: boolean; reasons: string[]; scopes: string[] };
const field = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-slate-100';
const button = 'rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50';
function message(error: unknown): string {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Request failed. Please retry.';
}

export default function SquidPage() {
  const { user, can } = useAuth();
  const staff = user?.role === 'ADMINISTRATOR';
  const view = !!user && (!staff || can('squid.view'));
  const manage = !staff || can('squid.manage');
  const ticketWrite = manage && (!staff || can('tickets.write'));
  const queryClient = useQueryClient();
  const [clientId, setClientId] = useState('');
  const [proxyId, setProxyId] = useState('');
  const [action, setAction] = useState('allow');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [reason, setReason] = useState('');
  const [registrationKey, setRegistrationKey] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const submission = useRef({ payload: '', requestKey: '' });
  useEffect(() => {
    const selected = new URLSearchParams(window.location.search).get('clientId');
    if (selected) setClientId(selected);
  }, []);
  const clients = useQuery<{ id: string; name: string }[]>({ queryKey: ['squid-clients'], queryFn: () => squidAdminApi.clients().then(r => r.data.clients), enabled: staff && view });
  const proxies = useQuery<Proxy[]>({
    queryKey: ['squid-proxies', staff, clientId],
    queryFn: () => (staff ? squidAdminApi.list({ customerId: clientId }) : squidApi.list({ limit: 100 })).then(r => r.data.proxies),
    enabled: view && (!staff || !!clientId), refetchInterval: 30_000,
  });
  const proxy = proxies.data?.find(p => p.id === proxyId);
  const automation = useQuery<Automation>({ queryKey: ['squid-automation', proxyId], queryFn: () => (staff ? squidAdminApi : squidApi).automation(proxyId).then(r => r.data), enabled: !!proxy && view, refetchInterval: 30_000 });
  const changes = useQuery<Change[]>({ queryKey: ['squid-changes', proxyId], queryFn: () => (staff ? squidAdminApi.changeRequests(proxyId) : squidApi.listChangeRequests(proxyId)).then(r => r.data.changeRequests), enabled: !!proxy && view, refetchInterval: 30_000 });
  async function run(name: string, work: () => Promise<unknown>, success: string) {
    setBusy(name); setError(''); setNotice('');
    try { await work(); setNotice(success); await queryClient.invalidateQueries({ queryKey: ['squid-automation'] }); await queryClient.invalidateQueries({ queryKey: ['squid-changes'] }); await queryClient.invalidateQueries({ queryKey: ['squid-proxies'] }); }
    catch (e) { setError(message(e)); } finally { setBusy(''); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!proxy) return;
    const form = new FormData(event.currentTarget);
    const data = { action, ip: String(form.get('ip')), reason: String(form.get('reason')), ...(['allow', 'deny', 'extend'].includes(action) ? { domain: String(form.get('domain')) } : {}), ...(form.get('hours') ? { hours: Number(form.get('hours')) } : {}) };
    const payload = JSON.stringify({ proxyId: proxy.id, ...data });
    if (submission.current.payload !== payload) submission.current = { payload, requestKey: crypto.randomUUID() };
    void run('ticket', async () => {
      const result = await (staff ? squidAdminApi : squidApi).requestChange(proxy.id, { ...data, requestKey: submission.current.requestKey });
      submission.current = { payload: '', requestKey: '' };
      return result;
    }, 'Approval ticket created. The proxy will apply the change after approval and delivery.');
  }
  return <RoleGuard allowedRoles={['ORG_ADMIN', 'ADMINISTRATOR']}>
    <div className="flex h-screen overflow-hidden bg-canvas"><Sidebar /><main className="flex-1 overflow-y-auto p-5 sm:p-8">
      <div className="mx-auto max-w-6xl space-y-7">
        <header><h1 className="text-2xl font-semibold text-slate-900">Proxy connections</h1><p className="mt-2 max-w-2xl text-sm text-slate-600">Manage proxy connections and submit configuration requests through approval tickets. Hosts collect approved changes through outbound connections.</p></header>
        {!view ? <p role="alert">Your staff role needs the Squid view permission.</p> : <>
          <div className="grid gap-5 sm:grid-cols-2">
            {staff && <label className="space-y-2 text-sm font-medium">Client<select className={field} value={clientId} onChange={e => { setClientId(e.target.value); setProxyId(''); setNotice(''); setRegistrationKey(''); }}><option value="">Select a client</option>{clients.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
            <label className="space-y-2 text-sm font-medium">Proxy<select className={field} value={proxyId} disabled={staff && !clientId} onChange={e => { setProxyId(e.target.value); setNotice(''); }}><option value="">Select a proxy</option>{proxies.data?.map(p => <option key={p.id} value={p.id}>{p.name} · {p.status}</option>)}</select></label>
          </div>
          {(clients.isError || proxies.isError) && <p role="alert" className="text-sm text-red-700">Could not load clients or proxies. Refresh to retry.</p>}
          {proxies.isFetching && <p role="status" className="text-sm text-slate-600">Refreshing proxy status…</p>}
          {proxies.data?.length === 0 && <p className="text-sm text-slate-600">No proxies are provisioned for this organisation.</p>}
          {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
          {notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
          {staff && manage && clientId && <details className="rounded-xl border border-slate-200 bg-white p-5"><summary className="cursor-pointer text-sm font-semibold">Provision a proxy for this client</summary><form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={event => {
            event.preventDefault();
            const name = String(new FormData(event.currentTarget).get('name'));
            void run('provision', async () => { const response = await squidAdminApi.provision({ customerId: clientId, name }); setRegistrationKey(response.data.key); return response; }, 'Proxy provisioned. Install its host agent and enroll its client certificate.');
          }}><label className="min-w-0 flex-1 space-y-2 text-sm font-medium">Proxy name<input className={field} name="name" required minLength={2} maxLength={32} pattern="[A-Za-z0-9_-]+" /></label><button className={button} disabled={!!busy}>{busy === 'provision' ? 'Provisioning…' : 'Provision proxy'}</button></form>
            {registrationKey && <div className="mt-4 space-y-2"><p className="text-sm text-slate-700">Registration key is shown once. Transfer it to the host’s protected configuration.</p><output className="block break-all rounded-lg bg-slate-100 p-3 font-mono text-sm">{registrationKey}</output><button className={button} onClick={() => setRegistrationKey('')}>Dismiss key</button></div>}
          </details>}
          {proxy && <>
            <section className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="text-lg font-semibold">{proxy.name}</h2><p className="mt-2 text-sm text-slate-600">{proxy.status} · Applied revision {proxy.appliedSeq} of {proxy.revision} · Last contact {proxy.lastSeenAt ? new Date(proxy.lastSeenAt).toLocaleString() : 'not yet received'}</p>
              <p className="mt-2 text-sm font-medium">{automation.isError ? 'Automation state unavailable. Changes are blocked until it can be checked.' : automation.data?.paused ? `Automation paused: ${automation.data.reasons.join('; ')}` : automation.data ? 'Automation running' : 'Checking automation…'}</p>
            </section>
            <section className="space-y-4"><h2 className="text-lg font-semibold">Request a policy change</h2><p className="text-sm text-slate-600">The selected proxy is the execution target. Ticket assignees and approvers remain separate.</p>
              <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2 text-sm font-medium">Action<select className={field} value={action} onChange={e => setAction(e.target.value)}><option value="allow">Allow destination</option><option value="deny">Remove destination access</option><option value="extend">Extend access</option><option value="full-net">Grant unrestricted access</option><option value="lock-net">Revoke unrestricted access</option></select></label>
                <label className="space-y-2 text-sm font-medium">Source IP<input className={field} name="ip" required placeholder="192.168.1.10" /></label>
                {['allow', 'deny', 'extend'].includes(action) && <label className="space-y-2 text-sm font-medium">Destination domain or IP<input className={field} name="domain" required placeholder="example.org" /></label>}
                {['allow', 'extend'].includes(action) && <label className="space-y-2 text-sm font-medium">Duration in hours<input className={field} name="hours" type="number" min="0.01" step="0.01" max="8760" required={action === 'extend'} /></label>}
                <label className="space-y-2 text-sm font-medium sm:col-span-2">Business reason<textarea className={field} name="reason" required minLength={3} maxLength={500} /></label>
                <div><button className={button} disabled={!!busy || !ticketWrite || !automation.data || automation.data.paused}>{busy === 'ticket' ? 'Creating ticket…' : 'Create approval ticket'}</button>{!ticketWrite && <p className="mt-2 text-sm text-slate-600">Your role needs proxy-management and ticket-write permissions.</p>}</div>
              </form>
            </section>
            {manage && <section className="space-y-4 border-t border-slate-200 pt-6"><h2 className="text-lg font-semibold">Automation controls</h2><p className="max-w-2xl text-sm text-slate-600">Pause stops new changes and command delivery. Squid keeps its current policy and continues serving traffic. An operation already applying finishes or rolls back safely.</p>
              <label className="block max-w-xl space-y-2 text-sm font-medium">Reason for pause or resume<input className={field} value={reason} onChange={e => setReason(e.target.value)} minLength={3} maxLength={300} /></label>
              <div className="flex flex-wrap gap-3">
                {[true, false].map(paused => <button key={String(paused)} className={button} disabled={!!busy || reason.trim().length < 3} onClick={() => void run(`proxy-${paused}`, () => (staff ? squidAdminApi : squidApi).pauseAutomation(proxy.id, paused, reason), paused ? 'Proxy automation paused.' : 'Proxy pause cleared. Any client or global pause still applies.')}>{busy === `proxy-${paused}` ? 'Saving…' : `${paused ? 'Pause' : 'Resume'} proxy automation`}</button>)}
                {staff && [true, false].map(paused => <button key={`client-${paused}`} className={button} disabled={!!busy || reason.trim().length < 3} onClick={() => void run(`client-${paused}`, () => squidAdminApi.pauseClient(clientId, paused, reason), 'Client automation control updated.')}>{busy === `client-${paused}` ? 'Saving…' : `${paused ? 'Pause' : 'Resume'} client automation`}</button>)}
                {staff && can('squid.pause.global') && [true, false].map(paused => <button key={`global-${paused}`} className={button} disabled={!!busy || reason.trim().length < 3} onClick={() => void run(`global-${paused}`, () => squidAdminApi.pauseGlobal(paused, reason), 'Global automation control updated.')}>{busy === `global-${paused}` ? 'Saving…' : `${paused ? 'Pause' : 'Resume'} all automation`}</button>)}
              </div>
            </section>}
            {staff && manage && <details className="rounded-xl border border-slate-200 bg-white p-5"><summary className="cursor-pointer text-sm font-semibold">Machine certificate enrollment</summary><p className="mt-3 text-sm text-slate-600">Register the SHA-256 fingerprint of this agent’s client certificate. Enrollment requires mTLS and protocol v2 immediately; update the host before saving. Worker certificates use the separate worker enrollment endpoint.</p><form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void run('enroll', () => squidAdminApi.enroll(proxy.id, fingerprint), 'Agent certificate enrolled. Only the matching certificate and machine key can authenticate.'); }}><label className="block space-y-2 text-sm font-medium">Client certificate SHA-256 fingerprint<input className={field} value={fingerprint} onChange={e => setFingerprint(e.target.value.replace(/:/g, '').trim())} required pattern="[a-fA-F0-9]{64}" /></label><button className={button} disabled={!!busy}>{busy === 'enroll' ? 'Enrolling…' : 'Enroll agent certificate'}</button></form></details>}
            <section className="space-y-4 border-t border-slate-200 pt-6"><h2 className="text-lg font-semibold">Change requests</h2>{changes.isError ? <p role="alert">Could not load change requests.</p> : !changes.data?.length ? <p className="text-sm text-slate-600">No change requests yet. Create a ticket above to request access.</p> : <ul className="divide-y divide-slate-200">{changes.data.map(c => <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 py-3"><p className="min-w-0 flex-1 break-words text-sm">{c.summary}</p><span className="text-xs font-semibold">{c.status}</span>{c.ticketId && <Link className="text-sm text-brand underline underline-offset-4" href={c.ticketUrl || `/ticketing?ticketId=${encodeURIComponent(c.ticketId)}`}>Open ticket</Link>}</li>)}</ul>}</section>
          </>}
        </>}
      </div>
    </main></div>
  </RoleGuard>;
}
