'use client';

import { Suspense, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ticketingApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import { ShimmerCard } from '@/components/ui/Shimmer';
import { useAuth } from '@/contexts/AuthContext';
import AdminTicketing from './AdminTicketing';
import { NewTicketForm, StatusBadge, PriorityBadge, SlaBadge, PageHeader, StatStrip, statusCfg, timeAgo } from './shared';
import TicketDetail from './TicketDetail';
import type { TicketDTO, TicketProject } from '@/lib/schemas';

const TicketIcon = (
  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6}
      d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 0 1 0 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 0 1 0-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375Z" />
  </svg>
);

function UserTicketing() {
  const { data: projectsData } = useQuery<{ projects: TicketProject[] }>({
    queryKey: ['ticketing', 'projects'],
    queryFn: () => ticketingApi.listProjects().then((r) => r.data as { projects: TicketProject[] }),
    staleTime: 60_000,
  });

  const { data: mineData, isLoading } = useQuery<{ tickets: TicketDTO[] }>({
    queryKey: ['ticketing', 'my-tickets'],
    queryFn: () => ticketingApi.listTickets({ mine: true }).then((r) => r.data as { tickets: TicketDTO[] }),
    staleTime: 15_000,
  });

  const [detailId, setDetailId] = useState<string | null>(null);
  const tickets = mineData?.tickets ?? [];
  const counts = useMemo(() => ({
    open: tickets.filter((t) => t.status !== 'completed').length,
    inProgress: tickets.filter((t) => t.status === 'in_progress').length,
    completed: tickets.filter((t) => t.status === 'completed').length,
  }), [tickets]);

  return (
    <div className="p-8 max-w-[1100px] mx-auto space-y-7">
      {detailId && <TicketDetail ticketId={detailId} onClose={() => setDetailId(null)} />}
      <PageHeader eyebrow="Ticketing" title="IT Support Tickets"
        subtitle="Raise IT issues and track their progress — your support team handles them from the control system." icon={TicketIcon} />

      {!isLoading && tickets.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
          <StatStrip items={[
            { label: 'Open', value: counts.open, dot: 'bg-amber-500' },
            { label: 'In Progress', value: counts.inProgress, dot: 'bg-cyan-500' },
            { label: 'Resolved', value: counts.completed, dot: 'bg-emerald-500' },
            { label: 'Total Raised', value: tickets.length, dot: 'bg-brand' },
          ]} />
        </motion.div>
      )}

      <div className="space-y-8">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.05 }}>
          <NewTicketForm projects={projectsData?.projects ?? []} role="USER" />
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.08 }} className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">My Tickets</h2>
            {!isLoading && tickets.length > 0 && <span className="text-xs font-medium text-slate-400 tabular-nums">{tickets.length} total</span>}
          </div>

          {isLoading ? (
            <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <ShimmerCard key={i} />)}</div>
          ) : tickets.length === 0 ? (
            <div className="card p-10 text-center">
              <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3">{TicketIcon}</div>
              <p className="text-sm font-semibold text-slate-700">No tickets yet</p>
              <p className="text-xs text-slate-400 mt-1">Raise your first one with the form above.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {tickets.map((t) => {
                const cfg = statusCfg[t.status] ?? statusCfg['todo']!;
                return (
                  <motion.div key={t.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
                    onClick={() => setDetailId(t.id)}
                    className="card relative overflow-hidden pl-5 pr-5 py-3.5 flex items-center gap-3 cursor-pointer hover:shadow-card-hover hover:border-slate-300 transition-all">
                    <span className={`absolute left-0 inset-y-0 w-1 ${cfg.bar}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] font-bold text-slate-400">{t.ticketNumber}</span>
                        <p className="text-sm font-semibold text-slate-900 truncate">{t.title}</p>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        {t.projectName ?? 'No project'} · {timeAgo(t.createdAt)}{t.assignee ? ` · ${t.assignee.name}` : ' · awaiting assignment'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="hidden md:inline-flex"><SlaBadge status={t.slaStatus} remainingSeconds={t.slaRemainingSeconds} /></span>
                      <span className="hidden sm:inline-flex"><PriorityBadge priority={t.priority} /></span>
                      <StatusBadge status={t.status} />
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

export default function TicketingPage() {
  return <Suspense fallback={null}><TicketingPageInner /></Suspense>;
}

function TicketingPageInner() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ORG_ADMIN' || user?.role === 'ADMINISTRATOR';
  return (
    <RoleGuard allowedRoles={['USER', 'ORG_ADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">{isAdmin ? <AdminTicketing /> : <UserTicketing />}</main>
      </div>
    </RoleGuard>
  );
}
