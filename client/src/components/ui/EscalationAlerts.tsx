'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { saasAdminApi } from '@/lib/api';
import type { TicketEscalation } from '@/lib/schemas';

const SEEN_KEY = 'escalation-alerts-since';
const POLL_MS = 10_000;

const priorityDot: Record<string, string> = {
  CRITICAL: 'bg-red-500', HIGH: 'bg-amber-500', MEDIUM: 'bg-cyan-500', LOW: 'bg-slate-400',
};

/**
 * Administrator escalation alerts: polls every 10s; tickets forwarded by org
 * admins trigger slide-in toasts and accumulate on the bell until marked read.
 * The "seen" watermark persists in localStorage so reloads don't replay alerts.
 */
export default function EscalationAlerts() {
  const [unread, setUnread] = useState<TicketEscalation[]>([]);
  const [toasts, setToasts] = useState<TicketEscalation[]>([]);
  const [open, setOpen] = useState(false);
  const seenIds = useRef<Set<string>>(new Set());

  useQuery({
    queryKey: ['admin-escalation-alerts'],
    queryFn: async () => {
      let since = localStorage.getItem(SEEN_KEY);
      if (!since) {
        since = new Date().toISOString();
        localStorage.setItem(SEEN_KEY, since);
      }
      const { data } = await saasAdminApi.listEscalations({ since });
      const res = data as { escalations: TicketEscalation[]; now: string };
      const fresh = res.escalations.filter((e) => !seenIds.current.has(e.id));

      if (fresh.length > 0) {
        for (const e of fresh) seenIds.current.add(e.id);
        localStorage.setItem(SEEN_KEY, res.now);
        setUnread((prev) => [...fresh, ...prev].slice(0, 25));
        const popped = fresh.slice(0, 3);
        setToasts((prev) => [...popped, ...prev].slice(0, 3));
        for (const e of popped) {
          setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== e.id)), 8000);
        }
      } else if (res.escalations.length === 0) {
        localStorage.setItem(SEEN_KEY, res.now);
      }
      return res;
    },
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });

  return (
    <>
      {/* Bell */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={`Escalation alerts${unread.length ? ` — ${unread.length} unread` : ''}`}
          className="relative flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors cursor-pointer"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
          </svg>
          {unread.length > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center">
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
                <p className="text-xs font-semibold text-slate-900">Escalated Tickets</p>
                {unread.length > 0 && (
                  <button type="button" onClick={() => { setUnread([]); setOpen(false); }}
                    className="text-[11px] font-semibold text-brand hover:text-brand-700 cursor-pointer">
                    Mark all read
                  </button>
                )}
              </div>
              <div className="max-h-64 overflow-y-auto">
                {unread.length === 0 ? (
                  <p className="px-4 py-6 text-center text-xs text-slate-400">No new escalations.</p>
                ) : (
                  unread.map((e) => (
                    <Link key={e.id} href="/dashboard" onClick={() => setOpen(false)}
                      className="block px-4 py-2.5 border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityDot[e.priority] ?? 'bg-slate-400'}`} />
                        <p className="text-xs font-semibold text-slate-900 truncate">{e.subject}</p>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5 pl-3.5">{e.customer?.name ?? 'Unknown org'} · {e.issueType}</p>
                    </Link>
                  ))
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Toasts — fixed top-right */}
      <div className="fixed top-4 right-4 z-[100] space-y-2 w-80 pointer-events-none">
        <AnimatePresence>
          {toasts.map((e) => (
            <motion.div
              key={e.id}
              initial={{ opacity: 0, x: 60 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 60 }}
              transition={{ duration: 0.25 }}
              className="card p-4 shadow-card-hover border-l-4 border-l-rose-500 pointer-events-auto"
            >
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-rose-50 border border-rose-100 flex items-center justify-center flex-shrink-0">
                  <svg className="w-4 h-4 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-rose-700">Ticket escalated by {e.customer?.name ?? 'an organization'}</p>
                  <p className="text-sm text-slate-700 truncate mt-0.5">{e.subject}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {e.issueType} ·{' '}
                    <span className={`font-semibold ${e.priority === 'CRITICAL' || e.priority === 'HIGH' ? 'text-red-600' : 'text-slate-500'}`}>{e.priority}</span>
                    {e.escalatedBy && <> · by {e.escalatedBy.name}</>}
                  </p>
                  <Link href="/dashboard"
                    onClick={() => setToasts((prev) => prev.filter((x) => x.id !== e.id))}
                    className="inline-block mt-1.5 text-[11px] font-semibold text-brand hover:text-brand-700">
                    Review on dashboard →
                  </Link>
                </div>
                <button type="button" aria-label="Dismiss"
                  onClick={() => setToasts((prev) => prev.filter((x) => x.id !== e.id))}
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
