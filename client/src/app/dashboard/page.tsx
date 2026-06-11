'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { orgsApi, requestsApi, chatApi, announcementsApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import { ShimmerCard } from '@/components/ui/Shimmer';
import { useAuth } from '@/contexts/AuthContext';
import AdminPlatformDashboard from './AdminDashboard';
import type {
  Customer, OrganizationService, ServiceRequest, OrgServiceRequest, RequestStatus,
  ChatSessionSummary, ChatSessionDetail, Announcement, AnnouncementLevel,
} from '@/lib/schemas';

// ─── Status / priority presentation ─────────────────────────────────────────
const serviceStatusConfig: Record<string, { cls: string; dot: string; label: string }> = {
  ACTIVE:    { cls: 'text-emerald-700 bg-emerald-50', dot: 'bg-emerald-500', label: 'Active' },
  EXPIRING:  { cls: 'text-amber-700 bg-amber-50',     dot: 'bg-amber-500',   label: 'Expiring Soon' },
  EXPIRED:   { cls: 'text-red-700 bg-red-50',         dot: 'bg-red-500',     label: 'Expired' },
  SUSPENDED: { cls: 'text-slate-600 bg-slate-100',    dot: 'bg-slate-400',   label: 'Suspended' },
};

const ticketStatusConfig: Record<RequestStatus, { cls: string; dot: string; label: string }> = {
  OPEN:        { cls: 'text-amber-700 bg-amber-50',   dot: 'bg-amber-500',   label: 'Open' },
  IN_PROGRESS: { cls: 'text-cyan-700 bg-cyan-50',     dot: 'bg-cyan-500',    label: 'In Progress' },
  RESOLVED:    { cls: 'text-emerald-700 bg-emerald-50', dot: 'bg-emerald-500', label: 'Resolved' },
  CLOSED:      { cls: 'text-slate-600 bg-slate-100',  dot: 'bg-slate-400',   label: 'Closed' },
  ESCALATED:   { cls: 'text-red-700 bg-red-50',       dot: 'bg-red-500',     label: 'Escalated' },
};

const priorityConfig: Record<string, string> = {
  CRITICAL: 'text-red-700 bg-red-50',
  HIGH:     'text-amber-700 bg-amber-50',
  MEDIUM:   'text-cyan-700 bg-cyan-50',
  LOW:      'text-slate-600 bg-slate-100',
};

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400_000);
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Subscribed service card ────────────────────────────────────────────────
function ServiceCard({ svc }: { svc: OrganizationService }) {
  const cfg = serviceStatusConfig[svc.status] ?? serviceStatusConfig['ACTIVE']!;
  const days = daysUntil(svc.renewsAt);
  const renewalLabel = days < 0 ? `Expired ${Math.abs(days)}d ago` : days === 0 ? 'Renews today' : `Renews in ${days}d`;
  const renewalColor = days < 0 ? 'text-red-600' : days < 30 ? 'text-amber-600' : 'text-slate-500';
  const isDimmed = svc.status === 'EXPIRED' || svc.status === 'SUSPENDED' || !svc.enabled;

  return (
    <div className={`card p-5 ${isDimmed ? 'opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 leading-tight">{svc.name}</p>
          {svc.description && <p className="text-xs text-slate-500 mt-1 line-clamp-2">{svc.description}</p>}
        </div>
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold flex-shrink-0 ${cfg.cls}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
          {cfg.label}
        </span>
      </div>
      <div className="flex items-center justify-between pt-3 border-t border-slate-100">
        <span className={`text-xs font-mono tabular-nums font-semibold ${renewalColor}`}>{renewalLabel}</span>
        <span className="text-xs font-mono tabular-nums text-slate-500">₹{svc.monthlyPrice.toLocaleString()}/mo</span>
      </div>
    </div>
  );
}

// ─── Ticket row (expandable) ────────────────────────────────────────────────
function TicketRow({ ticket }: { ticket: ServiceRequest }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  const status = ticketStatusConfig[ticket.status];
  const canClose = ticket.status !== 'CLOSED' && ticket.status !== 'RESOLVED';

  async function handleClose() {
    setClosing(true);
    try {
      await requestsApi.close(ticket.id);
      await queryClient.invalidateQueries({ queryKey: ['my-requests'] });
    } finally {
      setClosing(false);
    }
  }

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-slate-50/60 transition-colors cursor-pointer"
      >
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold flex-shrink-0 ${status.cls}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-slate-900 truncate">{ticket.subject}</span>
          <span className="block text-[11px] text-slate-400 mt-0.5">
            {ticket.type.replace('_', ' ')} · {formatDate(ticket.createdAt)}
          </span>
        </span>
        <span className={`hidden sm:inline-flex px-2 py-0.5 rounded-md text-[11px] font-semibold flex-shrink-0 ${priorityConfig[ticket.priority]}`}>
          {ticket.priority}
        </span>
        <span className="font-mono text-[10px] text-slate-300 flex-shrink-0">TKT-{ticket.id.slice(-8).toUpperCase()}</span>
        <svg className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-slate-100"
          >
            <div className="px-5 py-4 space-y-3">
              {ticket.service && (
                <p className="text-xs"><span className="text-slate-400">Service:</span> <span className="font-medium text-slate-700">{ticket.service}</span></p>
              )}
              <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
                {ticket.description || <span className="text-slate-400 italic">No description provided.</span>}
              </p>
              <div className="flex items-center gap-4 text-[11px] text-slate-400 pt-1">
                <span>Updated {relativeTime(ticket.updatedAt)}</span>
                {ticket.resolvedAt && <span>Resolved {formatDate(ticket.resolvedAt)}</span>}
              </div>
              {canClose && (
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={closing}
                  className="text-xs font-semibold text-slate-600 hover:text-red-600 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {closing ? 'Closing…' : 'Close this ticket'}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Org-admin ticket row (read-only overview, shows the creator) ───────────
function OrgTicketRow({ ticket }: { ticket: OrgServiceRequest }) {
  const [expanded, setExpanded] = useState(false);
  const status = ticketStatusConfig[ticket.status];
  const creator = ticket.createdBy?.name ?? 'Unknown user';

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-slate-50/60 transition-colors cursor-pointer"
      >
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold flex-shrink-0 ${status.cls}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-slate-900 truncate">{ticket.subject}</span>
          <span className="block text-[11px] text-slate-400 mt-0.5">
            {creator} · {ticket.type.replace('_', ' ')} · {formatDate(ticket.createdAt)}
          </span>
        </span>
        <span className={`hidden sm:inline-flex px-2 py-0.5 rounded-md text-[11px] font-semibold flex-shrink-0 ${priorityConfig[ticket.priority]}`}>
          {ticket.priority}
        </span>
        <svg className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-slate-100"
          >
            <div className="px-5 py-4 space-y-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span><span className="text-slate-400">Raised by:</span> <span className="font-medium text-slate-700">{creator}</span></span>
                {ticket.createdBy?.email && <span className="text-slate-400">{ticket.createdBy.email}</span>}
                {ticket.service && <span><span className="text-slate-400">Service:</span> <span className="font-medium text-slate-700">{ticket.service}</span></span>}
              </div>
              <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
                {ticket.description || <span className="text-slate-400 italic">No description provided.</span>}
              </p>
              <div className="flex items-center gap-4 text-[11px] text-slate-400 pt-1">
                <span>Updated {relativeTime(ticket.updatedAt)}</span>
                {ticket.resolvedAt && <span>Resolved {formatDate(ticket.resolvedAt)}</span>}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Chat history viewer modal ──────────────────────────────────────────────
function ChatHistoryModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { data, isLoading } = useQuery<ChatSessionDetail>({
    queryKey: ['chat-session', sessionId],
    queryFn: () => chatApi.getSession(sessionId).then((r) => r.data as ChatSessionDetail),
  });

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}
        transition={{ duration: 0.2 }}
        className="card w-full max-w-[640px] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 flex-shrink-0">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-brand to-violet-600 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.091 3.091z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-900 truncate">{data?.title ?? 'Conversation'}</p>
            <p className="text-[11px] text-slate-400">{data ? `${data.messages.length} messages` : ''}</p>
          </div>
          <Link href={`/chat?session=${sessionId}`} className="text-xs font-semibold text-brand hover:text-brand-700 transition-colors flex-shrink-0">
            Continue →
          </Link>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 transition-colors cursor-pointer flex-shrink-0" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 bg-slate-50/40">
          {isLoading ? (
            <p className="text-sm text-slate-400 text-center py-8">Loading…</p>
          ) : (
            data?.messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === 'USER' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] px-3.5 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                  m.role === 'USER'
                    ? 'bg-brand text-white rounded-br-md'
                    : 'bg-white border border-slate-200 text-slate-800 rounded-bl-md'
                }`}>
                  {m.content}
                </div>
              </div>
            ))
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Announcement banner (platform broadcasts shown to org members) ─────────
const bannerCfg: Record<AnnouncementLevel, { wrap: string; dot: string }> = {
  INFO:     { wrap: 'bg-cyan-50 border-cyan-200 text-cyan-800',   dot: 'bg-cyan-500' },
  WARNING:  { wrap: 'bg-amber-50 border-amber-200 text-amber-800', dot: 'bg-amber-500' },
  CRITICAL: { wrap: 'bg-red-50 border-red-200 text-red-800',       dot: 'bg-red-500' },
};

function AnnouncementBanners() {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const { data } = useQuery<{ announcements: Announcement[] }>({
    queryKey: ['announcements'],
    queryFn: () => announcementsApi.list().then((r) => r.data as { announcements: Announcement[] }),
    staleTime: 60_000,
  });

  const visible = (data?.announcements ?? []).filter((a) => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  return (
    <div className="space-y-2.5">
      {visible.map((a) => {
        const cfg = bannerCfg[a.level];
        return (
          <motion.div key={a.id} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${cfg.wrap}`}>
            <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${cfg.dot} animate-pulse-soft`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold leading-tight">{a.title}</p>
              <p className="text-xs mt-0.5 leading-relaxed opacity-90">{a.message}</p>
            </div>
            <button type="button" aria-label="Dismiss announcement"
              onClick={() => setDismissed((prev) => new Set(prev).add(a.id))}
              className="opacity-50 hover:opacity-100 transition-opacity cursor-pointer flex-shrink-0">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </motion.div>
        );
      })}
    </div>
  );
}

// ─── Page (role-branched) ────────────────────────────────────────────────────
// ADMINISTRATOR gets the platform-wide monitoring dashboard; org members get
// the member dashboard below.
export default function DashboardPage() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-canvas">
        <div className="relative w-9 h-9">
          <div className="absolute inset-0 rounded-full border-2 border-slate-200" />
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-brand animate-spin" />
        </div>
      </div>
    );
  }

  if (user?.role === 'ADMINISTRATOR') return <AdminPlatformDashboard />;
  return <MemberDashboard />;
}

function MemberDashboard() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<RequestStatus | 'ALL'>('ALL');
  const [orgStatusFilter, setOrgStatusFilter] = useState<RequestStatus | 'ALL'>('ALL');
  const [openSession, setOpenSession] = useState<string | null>(null);

  const isAdmin = user?.role === 'ORG_ADMIN' || user?.role === 'ADMINISTRATOR';

  const { data: org } = useQuery<Customer>({
    queryKey: ['org'],
    queryFn: () => orgsApi.getMe().then((r) => r.data as Customer),
    staleTime: 60_000,
  });

  const { data: servicesData } = useQuery<{ services: OrganizationService[]; monthlyTotal: number }>({
    queryKey: ['my-services'],
    queryFn: () => orgsApi.getServices().then((r) => r.data as { services: OrganizationService[]; monthlyTotal: number }),
    staleTime: 30_000,
  });

  const { data: requestsData, isLoading: ticketsLoading } = useQuery<{ requests: ServiceRequest[] }>({
    queryKey: ['my-requests'],
    queryFn: () => requestsApi.list({ limit: 100 }).then((r) => r.data as { requests: ServiceRequest[] }),
    staleTime: 15_000,
  });

  const { data: sessionsData, isLoading: chatLoading } = useQuery<{ sessions: ChatSessionSummary[] }>({
    queryKey: ['chat-sessions'],
    queryFn: () => chatApi.listSessions().then((r) => r.data as { sessions: ChatSessionSummary[] }),
    staleTime: 15_000,
  });

  // Org-admin only: every ticket raised across the organization.
  const { data: orgData, isLoading: orgTicketsLoading } = useQuery<{ requests: OrgServiceRequest[]; counts: Record<string, number>; total: number }>({
    queryKey: ['org-requests'],
    queryFn: () => requestsApi.listOrg({ limit: 200 }).then((r) => r.data as { requests: OrgServiceRequest[]; counts: Record<string, number>; total: number }),
    enabled: isAdmin,
    staleTime: 15_000,
  });

  const hour = new Date().getHours();
  const timeLabel = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

  const services = servicesData?.services ?? [];
  const tickets = requestsData?.requests ?? [];
  const sessions = sessionsData?.sessions ?? [];

  const openCount       = tickets.filter((t) => t.status === 'OPEN' || t.status === 'ESCALATED').length;
  const inProgressCount = tickets.filter((t) => t.status === 'IN_PROGRESS').length;
  const resolvedCount   = tickets.filter((t) => t.status === 'RESOLVED' || t.status === 'CLOSED').length;

  const filteredTickets = statusFilter === 'ALL' ? tickets : tickets.filter((t) => t.status === statusFilter);

  const orgTickets = orgData?.requests ?? [];
  const orgCounts = orgData?.counts ?? {};
  const orgOpen       = (orgCounts['OPEN'] ?? 0) + (orgCounts['ESCALATED'] ?? 0);
  const orgInProgress = orgCounts['IN_PROGRESS'] ?? 0;
  const orgResolved   = (orgCounts['RESOLVED'] ?? 0) + (orgCounts['CLOSED'] ?? 0);
  const orgTotal      = orgData?.total ?? 0;
  const filteredOrgTickets = orgStatusFilter === 'ALL' ? orgTickets : orgTickets.filter((t) => t.status === orgStatusFilter);

  async function handleDeleteSession(id: string) {
    await chatApi.deleteSession(id);
    await queryClient.invalidateQueries({ queryKey: ['chat-sessions'] });
  }

  return (
    <RoleGuard allowedRoles={['USER', 'ORG_ADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[1200px] mx-auto space-y-8">

            {/* Greeting */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
              <p className="text-sm text-slate-500 mb-1">Good {timeLabel},</p>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">{user?.name}</h1>
              {org && (
                <p className="mt-1 text-sm text-slate-500">
                  Member of <span className="font-semibold text-slate-700">{org.name}</span>
                </p>
              )}
            </motion.div>

            {/* Platform announcements */}
            <AnnouncementBanners />

            {/* Organization tickets (org-admin only) */}
            {isAdmin && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.03 }} className="space-y-4">
                <div className="flex items-baseline justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">Organization Tickets</h2>
                    <p className="text-xs text-slate-500 mt-0.5">Every ticket raised by users across {org?.name ?? 'your organization'}</p>
                  </div>
                  <select
                    value={orgStatusFilter}
                    onChange={(e) => setOrgStatusFilter(e.target.value as RequestStatus | 'ALL')}
                    className="input !py-1 !px-2 text-xs w-auto"
                  >
                    <option value="ALL">All statuses</option>
                    <option value="OPEN">Open</option>
                    <option value="IN_PROGRESS">In Progress</option>
                    <option value="RESOLVED">Resolved</option>
                    <option value="CLOSED">Closed</option>
                    <option value="ESCALATED">Escalated</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatTile label="Open"         value={orgOpen}       tone="amber" />
                  <StatTile label="In Progress"  value={orgInProgress} tone="brand" />
                  <StatTile label="Resolved"     value={orgResolved}   tone="emerald" />
                  <StatTile label="Total Raised" value={orgTotal}      tone="red" />
                </div>

                {orgTicketsLoading ? (
                  <div className="space-y-2.5">{Array.from({ length: 3 }).map((_, i) => <ShimmerCard key={i} />)}</div>
                ) : filteredOrgTickets.length === 0 ? (
                  <div className="card p-8 text-center text-sm text-slate-500">
                    {orgTickets.length === 0 ? 'No tickets have been raised in your organization yet.' : 'No tickets match this filter.'}
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {filteredOrgTickets.map((t) => <OrgTicketRow key={t.id} ticket={t} />)}
                  </div>
                )}
              </motion.div>
            )}

            {/* Personal ticket status tiles */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.04 }}>
              {isAdmin && <h2 className="text-base font-semibold text-slate-900 mb-4">Your Tickets &amp; Activity</h2>}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatTile label="Open Tickets"  value={openCount}       tone="amber" />
                <StatTile label="In Progress"   value={inProgressCount} tone="brand" />
                <StatTile label="Resolved"      value={resolvedCount}   tone="emerald" />
                <StatTile label="Total Tickets" value={tickets.length}  tone="red" />
              </div>
            </motion.div>

            {/* Ticket history */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.1 }} className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-900">Your Tickets</h2>
                <div className="flex items-center gap-3">
                  <Link href="/support" className="text-xs font-semibold text-brand hover:text-brand-700 transition-colors">New ticket →</Link>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as RequestStatus | 'ALL')}
                    className="input !py-1 !px-2 text-xs w-auto"
                  >
                    <option value="ALL">All statuses</option>
                    <option value="OPEN">Open</option>
                    <option value="IN_PROGRESS">In Progress</option>
                    <option value="RESOLVED">Resolved</option>
                    <option value="CLOSED">Closed</option>
                    <option value="ESCALATED">Escalated</option>
                  </select>
                </div>
              </div>

              {ticketsLoading ? (
                <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <ShimmerCard key={i} />)}</div>
              ) : filteredTickets.length === 0 ? (
                <div className="card p-8 text-center text-sm text-slate-500">
                  {tickets.length === 0 ? (
                    <>No tickets yet. Open one from the <Link href="/support" className="text-brand font-semibold">Support</Link> page.</>
                  ) : 'No tickets match this filter.'}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {filteredTickets.map((t) => <TicketRow key={t.id} ticket={t} />)}
                </div>
              )}
            </motion.div>

            {/* Chat history */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.12 }}>
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-base font-semibold text-slate-900">Chat History</h2>
                <Link href="/chat" className="text-xs font-semibold text-brand hover:text-brand-700 transition-colors">New conversation →</Link>
              </div>
              {chatLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {Array.from({ length: 3 }).map((_, i) => <ShimmerCard key={i} />)}
                </div>
              ) : sessions.length === 0 ? (
                <div className="card p-8 text-center text-sm text-slate-500">
                  No saved conversations yet. Start one with the <Link href="/chat" className="text-brand font-semibold">Assistant</Link>.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {sessions.map((s) => (
                    <div key={s.id} className="card p-4 flex flex-col group">
                      <button type="button" onClick={() => setOpenSession(s.id)} className="text-left flex-1 cursor-pointer">
                        <p className="text-sm font-semibold text-slate-900 line-clamp-2 leading-snug">{s.title ?? 'Untitled conversation'}</p>
                        <p className="text-[11px] text-slate-400 mt-2">{s.messageCount} messages · {relativeTime(s.updatedAt)}</p>
                      </button>
                      <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
                        <button type="button" onClick={() => setOpenSession(s.id)} className="text-xs font-semibold text-brand hover:text-brand-700 transition-colors cursor-pointer">View</button>
                        <button type="button" onClick={() => void handleDeleteSession(s.id)} className="text-xs font-medium text-slate-400 hover:text-red-600 transition-colors cursor-pointer">Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>

            {/* Services (secondary) */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.14 }}>
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-base font-semibold text-slate-900">Your Services</h2>
                <span className="text-xs text-slate-400">
                  {services.length} subscriptions · ₹{(servicesData?.monthlyTotal ?? 0).toLocaleString()}/mo
                </span>
              </div>
              {services.length === 0 ? (
                <div className="card p-8 text-center text-sm text-slate-500">
                  No services subscribed yet. Contact your organization admin to get started.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {services.map((svc) => <ServiceCard key={svc.id} svc={svc} />)}
                </div>
              )}
            </motion.div>

          </div>
        </main>
      </div>

      <AnimatePresence>
        {openSession && <ChatHistoryModal sessionId={openSession} onClose={() => setOpenSession(null)} />}
      </AnimatePresence>
    </RoleGuard>
  );
}

function StatTile({ label, value, tone }: { label: string; value: number | string; tone: 'emerald' | 'amber' | 'red' | 'brand' }) {
  const dot = { emerald: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', brand: 'bg-brand' }[tone];
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">{label}</p>
        <span className={`w-2 h-2 rounded-full ${dot}`} />
      </div>
      <p className="font-mono text-[2rem] font-bold text-slate-900 tabular-nums leading-none">{value}</p>
    </div>
  );
}
