'use client';

// Operations dashboard. One aggregate, two audiences:
//   ADMINISTRATOR — the whole platform's ticket estate.
//   ORG_ADMIN     — the same panels scoped to their org (Node picks the ticket
//                   store by role), plus the per-user load grid, because an org
//                   admin's question is "who on my team is buried?" and a
//                   platform admin's is "which branch/client/assignee is".
// The role split is a *composition* difference, not two copies of the layout —
// so a panel fixed once is fixed for both.

import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { dashboardApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar, { icons } from '@/components/ui/Sidebar';
import { PageHeader } from '@/components/ui/PageHeader';
import { ShimmerCard } from '@/components/ui/Shimmer';
import { useAuth } from '@/contexts/AuthContext';
import type { DashOverview } from '@/lib/schemas';
import {
  AssigneePanel, BranchPanel, ClientsPanel, DailyVolumePanel, IssueDonut,
  KpiLivePanel, Pill, ProjectStatsPanel, SectionBand, TicketStatsPanel, UserLoadPanel,
} from './panels';

const REFRESH_MS = 60_000;

// The spec's ~2fr / 1fr split: a wide visual beside a narrower reading panel,
// collapsing to one column below xl so neither half is squeezed on a laptop.
const SPLIT = 'grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]';

export default function OpsDashboardPage() {
  const { user } = useAuth();
  const isOrgAdmin = user?.role === 'ORG_ADMIN';

  const { data, isLoading, isError, error, dataUpdatedAt, isFetching } = useQuery<DashOverview>({
    queryKey: ['dashboard-overview', isOrgAdmin],
    queryFn: async () => (await dashboardApi.overview(isOrgAdmin)).data as DashOverview,
    refetchInterval: REFRESH_MS,
    // Keep the last good aggregate on screen while a refetch is in flight — a
    // dashboard that blanks every minute is unreadable.
    placeholderData: (prev) => prev,
    retry: 1,
  });

  return (
    <RoleGuard allowedRoles={['ORG_ADMIN', 'ADMINISTRATOR']}>
      <div className="flex min-h-screen bg-[#F5F7FB]">
        <Sidebar />
        <main className="min-w-0 flex-1 px-6 py-8">
          <div className="mx-auto max-w-[1600px] space-y-6">

            <PageHeader eyebrow="Operations" title="Dashboard" icon={icons.dashboard}
              subtitle={isOrgAdmin ? 'Live ticket health for your organisation.' : 'Platform-wide ticket health.'} />

            <StatusStrip data={data} isError={isError} isFetching={isFetching} updatedAt={dataUpdatedAt} />

            {isError && !data && (
              <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-card">
                <p className="text-sm font-semibold text-slate-900">Dashboard data unavailable</p>
                <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
                  {(error as { response?: { status?: number } })?.response?.status === 401
                    ? 'Your session expired. Sign in again to reload the dashboard.'
                    : 'The server did not return an aggregate. It retries automatically every minute.'}
                </p>
              </div>
            )}

            {isLoading && !data && (
              <div className="grid gap-6 lg:grid-cols-2">
                {Array.from({ length: 4 }, (_, i) => <ShimmerCard key={i} />)}
              </div>
            )}

            {data && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="space-y-6"
              >
                <div className="grid gap-6 xl:grid-cols-2">
                  <TicketStatsPanel d={data} href="/ticketing" />
                  <ProjectStatsPanel d={data} href="/ticketing" />
                </div>

                {/* The only section that earns its own band: the donut and the KPI
                    column answer one question together ("what is the estate made
                    of right now"), and the scope line applies to both. */}
                <SectionBand
                  title="Ticket Analytics"
                  subtitle="Scope: All Tickets (Full Dataset)"
                  action={<Pill>{data.analyzed.toLocaleString()} tickets analyzed</Pill>}
                >
                  <div className={SPLIT}>
                    <IssueDonut d={data} />
                    <KpiLivePanel d={data} />
                  </div>
                </SectionBand>

                <div className={SPLIT}>
                  <DailyVolumePanel d={data} />
                  <BranchPanel d={data} />
                </div>

                {/* The org admin's headline panel leads; a platform admin has no
                    single org to look at, so they never see it. */}
                {isOrgAdmin && <UserLoadPanel rows={data.users} />}

                <div className={SPLIT}>
                  <AssigneePanel rows={data.assignees} />
                  <ClientsPanel d={data} />
                </div>
              </motion.div>
            )}
          </div>
        </main>
      </div>
    </RoleGuard>
  );
}

function StatusStrip({ data, isError, isFetching, updatedAt }: {
  data?: DashOverview; isError: boolean; isFetching: boolean; updatedAt: number;
}) {
  const breach = data?.kpi.slaBreachPct ?? 0;
  // Health reads off the live SLA number rather than a hardcoded "Healthy", so the
  // strip cannot claim everything is fine while the breach tile is orange.
  const health = isError
    ? { label: 'Data unavailable', cls: 'text-slate-500' }
    : breach >= 10
      ? { label: 'Degraded', cls: 'text-red-600' }
      : breach >= 5
        ? { label: 'Under pressure', cls: 'text-orange-700' }
        : { label: 'System Healthy', cls: 'text-green-700' };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white px-5 py-3 text-xs shadow-card">
      <span className={`font-semibold ${health.cls}`}>{health.label}</span>
      <span className="text-slate-200" aria-hidden="true">|</span>
      <span className="font-semibold text-slate-700 tabular-nums">
        {(data?.analyzed ?? 0).toLocaleString()} Tickets Analyzed
      </span>
      <span className="text-slate-200" aria-hidden="true">|</span>
      {/* Reports the REAL refresh state. The mock this was drawn from said
          "using fallback data", which was true of that build and is not of this
          one — the aggregate below is live. */}
      <span className="flex items-center gap-1.5 text-slate-500">
        <svg className="h-3.5 w-3.5" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}
             strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span className={`h-1.5 w-1.5 rounded-full ${isFetching ? 'animate-pulse-soft bg-brand' : 'bg-green-500'}`} />
        {isFetching ? 'Refreshing…' : updatedAt ? `Live updated: ${new Date(updatedAt).toLocaleTimeString()}` : 'Waiting for data'}
      </span>
    </div>
  );
}
