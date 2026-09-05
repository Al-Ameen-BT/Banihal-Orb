'use client';

import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ticketingApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import { ShimmerCard } from '@/components/ui/Shimmer';
import { useAuth } from '@/contexts/AuthContext';
import GlowButton from '@/components/ui/GlowButton';
import AdminTicketing from './AdminTicketing';
import {
  NewTicketForm, StatusBadge, PriorityBadge, SlaBadge, TypeBadge, PageHeader, StatStrip,
  Toolbar, Segmented, SearchInput, EmptyState, TicketBoard, Avatar, Modal, Icons, statusCfg, timeAgo,
  apiErrorMessage,
} from './shared';
import TicketDetail from './TicketDetail';
import type { TicketDTO, TicketProject, TicketStatus } from '@/lib/schemas';

type StatusFilter = 'ALL' | TicketStatus;
type View = 'list' | 'board';

function UserTicketing() {
  const { data: projectsData } = useQuery<{ projects: TicketProject[] }>({
    queryKey: ['ticketing', 'projects'],
    queryFn: () => ticketingApi.listProjects().then((r) => r.data as { projects: TicketProject[] }),
    staleTime: 60_000,
  });

  const { data: mineData, isLoading, isError, error, refetch } = useQuery<{ tickets: TicketDTO[] }>({
    queryKey: ['ticketing', 'my-tickets'],
    queryFn: () => ticketingApi.listTickets({ mine: true }).then((r) => r.data as { tickets: TicketDTO[] }),
    staleTime: 15_000,
  });

  // /ticketing?ticket=<id> opens that ticket straight away — the deep link used by
  // the assignment push notification.
  const searchParams = useSearchParams();
  const [detailId, setDetailId] = useState<string | null>(searchParams.get('ticket'));
  const [showForm, setShowForm] = useState(false);
  const [view, setView] = useState<View>('list');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [search, setSearch] = useState('');

  const tickets = useMemo(() => mineData?.tickets ?? [], [mineData]);
  const counts = useMemo(() => ({
    open: tickets.filter((t) => t.status !== 'completed').length,
    inProgress: tickets.filter((t) => t.status === 'in_progress').length,
    completed: tickets.filter((t) => t.status === 'completed').length,
  }), [tickets]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tickets.filter((t) =>
      (statusFilter === 'ALL' || t.status === statusFilter) &&
      (!q || t.title.toLowerCase().includes(q) || t.ticketNumber.toLowerCase().includes(q)));
  }, [tickets, statusFilter, search]);

  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: 'ALL', label: 'All' }, { value: 'todo', label: 'To Do' }, { value: 'in_progress', label: 'In Progress' },
    { value: 'client_pending', label: 'Pending' }, { value: 'completed', label: 'Done' },
  ];

  return (
    <div className="p-6 sm:p-8 max-w-[1200px] mx-auto space-y-6">
      {detailId && <TicketDetail ticketId={detailId} onClose={() => setDetailId(null)} />}

      <Modal open={showForm} onClose={() => setShowForm(false)} title="Raise a ticket" width="max-w-2xl">
        <NewTicketForm projects={projectsData?.projects ?? []} role="USER"
          onCreated={() => setShowForm(false)} onCancel={() => setShowForm(false)} />
      </Modal>

      <PageHeader eyebrow="Ticketing" title="IT Support Tickets"
        subtitle="Raise IT issues and track their progress — your support team handles them from the control system." icon={Icons.ticket({ className: 'w-6 h-6' })}
        actions={<GlowButton onClick={() => setShowForm(true)} className="inline-flex items-center gap-1.5"><Icons.plus className="w-4 h-4" />New ticket</GlowButton>} />

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

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.05 }} className="space-y-4">
        <Toolbar>
          <Segmented value={statusFilter} onChange={setStatusFilter} options={statusOptions} size="sm" layoutId="userStatus" />
          <SearchInput value={search} onChange={setSearch} placeholder="Search title or TKT-number…" />
          <Segmented value={view} onChange={setView} size="sm" layoutId="userView"
            options={[{ value: 'list', label: 'List', icon: Icons.list }, { value: 'board', label: 'Board', icon: Icons.board }]} />
        </Toolbar>

        {isLoading ? (
          <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <ShimmerCard key={i} />)}</div>
        ) : isError ? (
          /* Without this branch a failed request fell through to "No tickets yet",
             so an outage or a rejected query was indistinguishable from an empty
             queue — and invited the user to raise a duplicate ticket. */
          <div className="card p-8 text-center">
            <p className="text-sm font-medium text-slate-900">Couldn&apos;t load your tickets</p>
            <p className="mt-1.5 text-sm text-slate-500">
              {apiErrorMessage(error, 'The ticket service did not respond. Your tickets are safe — this is only a display problem.')}
            </p>
            <div className="mt-4">
              <GlowButton variant="secondary" className="py-1.5 px-3 text-xs" onClick={() => void refetch()}>Try again</GlowButton>
            </div>
          </div>
        ) : tickets.length === 0 ? (
          <EmptyState icon={Icons.ticket({ className: 'w-6 h-6' })} title="No tickets yet"
            hint="Raise your first IT support ticket and track it here."
            action={<GlowButton onClick={() => setShowForm(true)}>Raise a ticket</GlowButton>} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Icons.search({ className: 'w-6 h-6' })} title="No tickets match" hint="Try a different status filter or search term." />
        ) : view === 'board' ? (
          <TicketBoard tickets={filtered} onOpen={setDetailId} />
        ) : (
          <div className="space-y-2.5">
            {filtered.map((t) => {
              const cfg = statusCfg[t.status] ?? statusCfg['todo']!;
              return (
                <motion.div key={t.id} layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
                  onClick={() => setDetailId(t.id)}
                  className="card relative overflow-hidden pl-5 pr-5 py-3.5 flex items-center gap-3 cursor-pointer hover:shadow-card-hover hover:border-slate-300 transition-all">
                  <span className={`absolute left-0 inset-y-0 w-1 ${cfg.bar}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] font-bold text-slate-400">{t.ticketNumber}</span>
                      <p className="text-sm font-semibold text-slate-900 truncate">{t.title}</p>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1.5 flex-wrap">
                      <TypeBadge type={t.type} />
                      <span>{t.projectName ?? 'No project'} · {timeAgo(t.createdAt)}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {t.assignee
                      ? <span className="hidden lg:inline-flex items-center gap-1.5 text-[11px] text-slate-500"><Avatar name={t.assignee.name} size="xs" />{t.assignee.name}</span>
                      : <span className="hidden lg:inline text-[11px] font-semibold text-amber-600">Awaiting assignment</span>}
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
  );
}

export default function TicketingPage() {
  return <Suspense fallback={null}><TicketingPageInner /></Suspense>;
}

function TicketingPageInner() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const isAdmin = user?.role === 'ORG_ADMIN' || user?.role === 'ADMINISTRATOR';

  // Every deep link into this page (?tab=, ?ticket=, ?assignee=) is read through a
  // useState INITIALIZER, which React runs once per mount. A client-side navigation to
  // /ticketing?… while this tree is already mounted reuses the components, so those
  // initializers never re-run and the new URL is silently ignored — you had to hard
  // refresh to make a deep link take effect. Keying on the query string remounts the
  // tree whenever it changes, which is exactly when the seeds must be re-read.
  //
  // Safe because NOTHING under app/ticketing writes to the URL (no router.push, no
  // history.pushState): the query string only ever changes on a real navigation, so
  // this can never discard filters/search the user is in the middle of typing. Add a
  // URL write here and this remounts on every keystroke — sync the state explicitly
  // in that case instead.
  const deepLinkKey = searchParams.toString();

  return (
    <RoleGuard allowedRoles={['USER', 'ORG_ADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          {isAdmin ? <AdminTicketing key={deepLinkKey} /> : <UserTicketing key={deepLinkKey} />}
        </main>
      </div>
    </RoleGuard>
  );
}
