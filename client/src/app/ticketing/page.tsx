'use client';

import { Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ticketingApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import { ShimmerCard } from '@/components/ui/Shimmer';
import { useAuth } from '@/contexts/AuthContext';
import AdminTicketing from './AdminTicketing';
import { NewTicketForm, StatusBadge, priorityCls, fmtDate } from './shared';
import type { TicketingTicket, TicketingProject } from '@/lib/schemas';

// ─── USER view: raise + track own tickets ────────────────────────────────────
function UserTicketing() {
  const { data: projectsData } = useQuery<{ projects: TicketingProject[] }>({
    queryKey: ['ticketing', 'projects'],
    queryFn: () => ticketingApi.listProjects().then((r) => r.data as { projects: TicketingProject[] }),
    staleTime: 60_000,
  });

  const { data: mineData, isLoading } = useQuery<{ tickets: TicketingTicket[] }>({
    queryKey: ['ticketing', 'my-tickets'],
    queryFn: () => ticketingApi.listTickets({ mine: true }).then((r) => r.data as { tickets: TicketingTicket[] }),
    staleTime: 15_000,
  });

  const tickets = mineData?.tickets ?? [];

  return (
    <div className="p-8 max-w-[1100px] mx-auto space-y-8">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
        <p className="text-sm text-slate-500 mb-1">Ticketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">IT Support Tickets</h1>
        <p className="mt-1 text-sm text-slate-500">Raise IT issues and track their progress — your org admin handles them from the control system.</p>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.05 }}>
          <NewTicketForm projects={projectsData?.projects ?? []} />
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.08 }} className="space-y-3">
          <h2 className="text-base font-semibold text-slate-900">My Tickets</h2>
          {isLoading ? (
            <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <ShimmerCard key={i} />)}</div>
          ) : tickets.length === 0 ? (
            <div className="card p-8 text-center text-sm text-slate-500">No tickets yet — raise your first one with the form.</div>
          ) : (
            <div className="space-y-2.5">
              {tickets.map((t) => (
                <div key={t.id} className="card px-5 py-3.5 flex items-center gap-3">
                  <StatusBadge status={t.status} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-900 truncate">{t.subject}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {t.issueType} · {fmtDate(t.createdAt)}{t.assignee ? ` · assigned to ${t.assignee}` : ' · awaiting assignment'}
                    </p>
                  </div>
                  <span className={`hidden sm:inline-flex px-2 py-0.5 rounded-md text-[11px] font-semibold flex-shrink-0 ${priorityCls[t.priority]}`}>
                    {t.priority}
                  </span>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

// ─── Page (role-branched) ────────────────────────────────────────────────────
export default function TicketingPage() {
  return (
    <Suspense fallback={null}>
      <TicketingPageInner />
    </Suspense>
  );
}

function TicketingPageInner() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ORG_ADMIN' || user?.role === 'ADMINISTRATOR';

  return (
    <RoleGuard allowedRoles={['USER', 'ORG_ADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          {isAdmin ? <AdminTicketing /> : <UserTicketing />}
        </main>
      </div>
    </RoleGuard>
  );
}
