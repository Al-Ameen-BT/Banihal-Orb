'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { ticketingApi, notificationsApi } from '@/lib/api';
import type { TicketDTO, TicketUpdateAlert, NotificationDTO } from '@/lib/schemas';

const POLL_MS = 10_000;
const priorityDot: Record<string, string> = { urgent: 'bg-red-500', high: 'bg-amber-500', medium: 'bg-cyan-500', low: 'bg-slate-400' };

// A normalized notification. `action` (optional) renders a button (e.g. "Claim")
// whose async `run` resolves → the item is removed, rejects → an inline error shows.
export interface NotifItem {
  id: string;
  title: string;
  subtitle?: string;
  tone?: string;               // dot color class
  href?: string;               // navigates on click
  action?: { label: string; run: () => Promise<void>; disabled?: boolean };
  /**
   * Set on items backed by a real Notification row. Those carry server-side read
   * state, so dismissing one must be ACKED rather than only dropped locally —
   * otherwise it returns on the next poll, which is the whole bug the durable
   * store exists to fix. Items without it are the legacy watermark feeds.
   */
  durable?: boolean;
}

// ─── Generic bell: polling + unread list + toasts (one system for every role) ──
function Bell({ label, emptyText, storageKey, queryKey, accent = 'brand', fetchItems }: {
  label: string; emptyText: string; storageKey: string; queryKey: unknown[];
  accent?: 'brand' | 'rose';
  fetchItems: (since: string) => Promise<{ items: NotifItem[]; now: string }>;
}) {
  const [unread, setUnread] = useState<NotifItem[]>([]);
  const [toasts, setToasts] = useState<NotifItem[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const seen = useRef<Set<string>>(new Set());

  useQuery({
    queryKey,
    queryFn: async () => {
      let since = localStorage.getItem(storageKey);
      if (!since) { since = new Date().toISOString(); localStorage.setItem(storageKey, since); }
      const { items, now } = await fetchItems(since);
      const fresh = items.filter((i) => !seen.current.has(i.id));
      if (fresh.length > 0) {
        for (const i of fresh) seen.current.add(i.id);
        localStorage.setItem(storageKey, now);
        setUnread((p) => [...fresh, ...p].slice(0, 25));
        const pop = fresh.slice(0, 3);
        setToasts((p) => [...pop, ...p].slice(0, 3));
        for (const i of pop) setTimeout(() => setToasts((p) => p.filter((x) => x.id !== i.id)), 8000);
      } else if (items.length === 0) {
        localStorage.setItem(storageKey, now); // advance watermark to keep the window small
      }
      return { items, now };
    },
    refetchInterval: POLL_MS, refetchIntervalInBackground: false, retry: false,
  });

  const drop = (id: string) => {
    const item = [...unread, ...toasts].find((x) => x.id === id);
    if (item?.durable) void notificationsApi.markRead(id).catch(() => {});
    setUnread((p) => p.filter((x) => x.id !== id));
    setToasts((p) => p.filter((x) => x.id !== id));
  };
  async function runAction(item: NotifItem) {
    if (!item.action || busy) return;
    setBusy(item.id); setError('');
    try { await item.action.run(); drop(item.id); }
    catch (e: unknown) { setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Action failed'); }
    finally { setBusy(null); }
  }

  const accentBar = accent === 'rose' ? 'border-l-rose-500' : 'border-l-brand';
  const accentBg = accent === 'rose' ? 'bg-rose-50 border-rose-100 text-rose-600' : 'bg-brand-50 border-brand-100 text-brand';
  const badge = accent === 'rose' ? 'bg-rose-500' : 'bg-brand';

  return (
    <>
      <div className="relative">
        <button type="button" onClick={() => { setOpen((v) => !v); setError(''); }}
          aria-label={`${label}${unread.length ? ` — ${unread.length} unread` : ''}`}
          className="relative flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors cursor-pointer">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
          </svg>
          {unread.length > 0 && (
            <span className={`absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-white text-[10px] font-bold flex items-center justify-center ${badge}`}>
              {unread.length > 9 ? '9+' : unread.length}
            </span>
          )}
        </button>

        <AnimatePresence>
          {open && (
            <motion.div initial={{ opacity: 0, y: 4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.15 }} className="absolute bottom-10 left-0 w-72 card shadow-card-hover z-50 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-900">{label}</p>
                {unread.length > 0 && (
                  <button type="button"
                    onClick={() => {
                      if (unread.some((i) => i.durable)) void notificationsApi.markAllRead().catch(() => {});
                      setUnread([]); setOpen(false);
                    }}
                    className="text-[11px] font-semibold text-brand hover:text-brand-700 cursor-pointer">Mark all read</button>
                )}
              </div>
              {error && <p className="px-4 py-1.5 text-[11px] text-red-600 bg-red-50 border-b border-red-100">{error}</p>}
              <div className="max-h-72 overflow-y-auto">
                {unread.length === 0 ? (
                  <p className="px-4 py-6 text-center text-xs text-slate-400">{emptyText}</p>
                ) : (
                  unread.map((i) => (
                    <div key={i.id} className="flex items-start gap-2 px-4 py-2.5 border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
                      <Link href={i.href ?? '#'} onClick={() => { if (i.durable) drop(i.id); setOpen(false); }} className="flex-1 min-w-0 block">
                        <div className="flex items-center gap-2">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${i.tone ?? 'bg-slate-400'}`} />
                          <p className="text-xs font-semibold text-slate-900 truncate">{i.title}</p>
                        </div>
                        {i.subtitle && <p className="text-[11px] text-slate-400 mt-0.5 pl-3.5 truncate">{i.subtitle}</p>}
                      </Link>
                      {i.action && (
                        <button type="button" disabled={busy === i.id || i.action.disabled} onClick={() => runAction(i)}
                          className="flex-shrink-0 px-2 py-1 rounded-md text-[11px] font-semibold text-white bg-brand hover:bg-brand-600 disabled:opacity-50 cursor-pointer">
                          {busy === i.id ? '…' : i.action.label}
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Toasts */}
      <div className="fixed top-4 right-4 z-[100] space-y-2 w-80 pointer-events-none">
        <AnimatePresence>
          {toasts.map((i) => (
            <motion.div key={i.id} initial={{ opacity: 0, x: 60 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 60 }} transition={{ duration: 0.25 }}
              className={`card p-4 shadow-card-hover border-l-4 ${accentBar} pointer-events-auto`}>
              <div className="flex items-start gap-3">
                <div className={`w-8 h-8 rounded-lg border flex items-center justify-center flex-shrink-0 ${accentBg}`}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-slate-900">{label}</p>
                  <p className="text-sm text-slate-700 truncate mt-0.5">{i.title}</p>
                  {i.subtitle && <p className="text-[11px] text-slate-400 mt-0.5 truncate">{i.subtitle}</p>}
                  <div className="flex items-center gap-3 mt-1.5">
                    {i.href && <Link href={i.href} onClick={() => drop(i.id)} className="text-[11px] font-semibold text-brand hover:text-brand-700">Open →</Link>}
                    {i.action && (
                      <button type="button" disabled={busy === i.id || i.action.disabled} onClick={() => runAction(i)}
                        className="text-[11px] font-semibold text-brand hover:text-brand-700 disabled:opacity-50 cursor-pointer">
                        {busy === i.id ? 'Claiming…' : i.action.label}
                      </button>
                    )}
                  </div>
                </div>
                <button type="button" aria-label="Dismiss" onClick={() => drop(i.id)}
                  className="text-slate-300 hover:text-slate-600 transition-colors cursor-pointer flex-shrink-0">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}

function describeUpdate(u: TicketUpdateAlert): string {
  if (u.type === 'commented') return u.description ? `New comment: ${u.description}` : 'New comment';
  if (u.type === 'assigned') return 'Assignee changed';
  if (u.type === 'status_changed') return 'Status updated';
  return 'Updated';
}

// ─── Role wrappers ─────────────────────────────────────────────────────────────
// USER (and everyone): updates on the tickets they raised.
export function UserNotifications() {
  return (
    <Bell label="My ticket updates" emptyText="No updates on your tickets." storageKey="notif-user-since" queryKey={['notif', 'user']}
      fetchItems={async (since) => {
        const { data } = await ticketingApi.myUpdates(since);
        const res = data as { updates: TicketUpdateAlert[]; now: string };
        return { now: res.now, items: res.updates.map((u) => ({ id: u.id, title: `${u.ticketNumber} ${u.title}`, subtitle: describeUpdate(u), tone: 'bg-cyan-500', href: '/ticketing' })) };
      }} />
  );
}

// ORG_ADMIN: new tickets raised in their org (b2b_ticket).
export function OrgNotifications() {
  return (
    <Bell label="New tickets" emptyText="No new tickets." storageKey="notif-org-since" queryKey={['notif', 'org']}
      fetchItems={async (since) => {
        const { data } = await ticketingApi.getAlerts(since);
        const res = data as { tickets: TicketDTO[]; now: string };
        return { now: res.now, items: res.tickets.map((t) => ({ id: t.id, title: `${t.ticketNumber} ${t.title}`, subtitle: `${t.reporter?.name ?? 'Unknown'} · ${t.type}`, tone: priorityDot[t.priority], href: '/ticketing?tab=tickets' })) };
      }} />
  );
}

// ADMINISTRATOR: two feeds in one bell.
//
//  - DURABLE notifications (@mentions today) — real rows with server-side read
//    state. These survive a reload, which the watermark feeds do not.
//  - ESCALATIONS — the original since-watermark feed, unchanged.
//
// Mixing the two models is a deliberate, temporary compromise: it avoids a second
// bell in the sidebar while the older feeds are still watermark-based. They can be
// migrated onto Notification rows later without touching this component, because
// `kind` already distinguishes them.
export function AdminNotifications() {
  return (
    <Bell label="Notifications" emptyText="Nothing new." storageKey="notif-admin-since" queryKey={['notif', 'admin']} accent="rose"
      fetchItems={async (since) => {
        // Settled, not all: one feed failing must not blank the other. `retry:false`
        // on the query means a rejection here would otherwise empty the whole bell.
        const [notifRes, escRes] = await Promise.allSettled([
          notificationsApi.list({ limit: 25 }),
          ticketingApi.adminEscalationAlerts(since),
        ]);

        const items: NotifItem[] = [];

        if (notifRes.status === 'fulfilled') {
          const { items: rows } = notifRes.value.data as { items: NotificationDTO[]; unreadCount: number };
          // Only unread ones belong in a bell; read state is authoritative here,
          // unlike the watermark feeds where "seen" is browser-local.
          items.push(...rows.filter((n) => !n.readAt).map((n) => ({
            id: n.id,
            title: n.title,
            ...(n.body ? { subtitle: n.body } : {}),
            tone: 'bg-brand',
            ...(n.url ? { href: n.url } : {}),
            durable: true,
          })));
        }

        if (escRes.status === 'fulfilled') {
          const res = escRes.value.data as { tickets: TicketDTO[]; now: string };
          items.push(...res.tickets.map((t) => ({
            id: t.id,
            title: `${t.ticketNumber} ${t.title}`,
            subtitle: `${t.customer?.name ?? t.projectName ?? 'client'} · ${t.assignee ? `→ ${t.assignee.name}` : t.priority}`,
            tone: priorityDot[t.priority] ?? 'bg-slate-400',
            href: '/ticketing?tab=tickets',
          })));
          return { items, now: res.now };
        }

        // Escalations failed: keep the mentions, and do NOT advance the watermark,
        // so the escalations missed this tick are still picked up on the next one.
        return { items, now: since };
      }} />
  );
}
