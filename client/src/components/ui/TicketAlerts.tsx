'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { ticketingApi } from '@/lib/api';
import type { TicketDTO } from '@/lib/schemas';

const SEEN_KEY = 'ticketing-alerts-since';
const POLL_MS = 10_000;

const priorityDot: Record<string, string> = {
  urgent: 'bg-red-500', high: 'bg-amber-500', medium: 'bg-cyan-500', low: 'bg-slate-400',
};

/**
 * Org-admin ticket alerts: polls the ticketing API every 10s; new tickets raised
 * by org users trigger slide-in toast popups and accumulate on the bell until
 * marked read. The "seen" watermark persists in localStorage so a page reload
 * doesn't replay old alerts.
 */
export default function TicketAlerts() {
  const [unread, setUnread] = useState<TicketDTO[]>([]);
  const [toasts, setToasts] = useState<TicketDTO[]>([]);
  const [open, setOpen] = useState(false);
  const seenIds = useRef<Set<string>>(new Set());

  useQuery({
    queryKey: ['ticketing', 'alerts'],
    queryFn: async () => {
      let since = localStorage.getItem(SEEN_KEY);
      if (!since) {
        since = new Date().toISOString();
        localStorage.setItem(SEEN_KEY, since);
      }
      const { data } = await ticketingApi.getAlerts(since);
      const res = data as { tickets: TicketDTO[]; now: string };
      const fresh = res.tickets.filter((t) => !seenIds.current.has(t.id));

      if (fresh.length > 0) {
        for (const t of fresh) seenIds.current.add(t.id);
        localStorage.setItem(SEEN_KEY, res.now);
        setUnread((prev) => [...fresh, ...prev].slice(0, 25));
        // Pop up to 3 toasts; each auto-dismisses after 8s.
        const popped = fresh.slice(0, 3);
        setToasts((prev) => [...popped, ...prev].slice(0, 3));
        for (const t of popped) {
          setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 8000);
        }
      } else if (res.tickets.length === 0) {
        // Nothing new — advance the watermark so the window stays small.
        localStorage.setItem(SEEN_KEY, res.now);
      }
      return res;
    },
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });

  function markAllRead() {
    setUnread([]);
    setOpen(false);
  }

  return (
    <>
      {/* Bell (rendered inline where the component is mounted) */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={`Ticket alerts${unread.length ? ` — ${unread.length} unread` : ''}`}
          className="relative flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors cursor-pointer"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
          </svg>
          {unread.length > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
              {unread.length > 9 ? '9+' : unread.length}
            </span>
          )}
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: 4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.15 }}
              className="absolute bottom-10 left-0 w-72 card shadow-card-hover z-50 overflow-hidden"
            >
              <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-900">New Tickets</p>
                {unread.length > 0 && (
                  <button type="button" onClick={markAllRead} className="text-[11px] font-semibold text-brand hover:text-brand-700 cursor-pointer">
                    Mark all read
                  </button>
                )}
              </div>
              <div className="max-h-64 overflow-y-auto">
                {unread.length === 0 ? (
                  <p className="px-4 py-6 text-center text-xs text-slate-400">No new tickets.</p>
                ) : (
                  unread.map((t) => (
                    <Link key={t.id} href="/ticketing?tab=tickets" onClick={() => setOpen(false)}
                      className="block px-4 py-2.5 border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityDot[t.priority] ?? 'bg-slate-400'}`} />
                        <p className="text-xs font-semibold text-slate-900 truncate"><span className="font-mono text-slate-400">{t.ticketNumber}</span> {t.title}</p>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5 pl-3.5">{t.reporter?.name ?? 'Unknown'} · {t.type}</p>
                    </Link>
                  ))
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Toast popups — fixed top-right, above everything */}
      <div className="fixed top-4 right-4 z-[100] space-y-2 w-80 pointer-events-none">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, x: 60 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 60 }}
              transition={{ duration: 0.25 }}
              className="card p-4 shadow-card-hover border-l-4 border-l-brand pointer-events-auto"
            >
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-brand-50 border border-brand-100 flex items-center justify-center flex-shrink-0">
                  <svg className="w-4 h-4 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859M12 3v8.25m0 0l-3-3m3 3l3-3" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-slate-900">New ticket raised</p>
                  <p className="text-sm text-slate-700 truncate mt-0.5"><span className="font-mono text-xs text-slate-400">{t.ticketNumber}</span> {t.title}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {t.reporter?.name ?? 'Unknown'} · {t.type} ·{' '}
                    <span className={`font-semibold ${t.priority === 'urgent' || t.priority === 'high' ? 'text-red-600' : 'text-slate-500'}`}>{t.priority}</span>
                  </p>
                  <Link href="/ticketing?tab=tickets"
                    onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                    className="inline-block mt-1.5 text-[11px] font-semibold text-brand hover:text-brand-700">
                    Open in control system →
                  </Link>
                </div>
                <button type="button" aria-label="Dismiss"
                  onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                  className="text-slate-300 hover:text-slate-600 transition-colors cursor-pointer flex-shrink-0">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}
