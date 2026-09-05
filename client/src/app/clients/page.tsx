'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { saasAdminApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import SummaryTile from '@/components/ui/SummaryTile';
import { ShimmerRow } from '@/components/ui/Shimmer';
import { Segmented } from '../ticketing/shared';
import { mfaStatus } from '@/lib/display';

// Everyone in a CLIENT organization, across all of them at once.
//
// This is the one view neither of the existing surfaces gives you: the Control
// Plane lists organizations, and /saas-admin/orgs/[id] lists one org's roster
// with full editing. Browsing "who is an org admin anywhere" meant opening orgs
// one at a time. So this page is deliberately read-only — each organization
// heading links through to the detail page, which is where editing belongs and
// stays the single place that logic lives.

interface ClientUser {
  id: string; name: string; email: string; role: string;
  mfaEnabled: boolean; lastLoginAt: string | null; createdAt: string;
  customer: { id: string; name: string; slug: string; plan?: string | null; mfaRequired?: boolean };
}

const roleConfig: Record<string, { label: string; cls: string }> = {
  USER:      { label: 'User',      cls: 'text-slate-600 bg-slate-100' },
  ORG_ADMIN: { label: 'Org Admin', cls: 'text-violet-700 bg-violet-50' },
};

function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export default function ClientsPage() {
  const { can } = useAuth();
  const canManageUsers = can('users.manage');
  const [roleFilter, setRoleFilter] = useState<'ALL' | 'ORG_ADMIN' | 'USER'>('ALL');

  const { data: allUsers, isLoading } = useQuery<ClientUser[]>({
    queryKey: ['all-users'],
    queryFn: () => saasAdminApi.listAllUsers().then((r) => (r.data as { users: ClientUser[] }).users),
    enabled: canManageUsers,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const rows = allUsers ?? [];
  const orgAdmins = rows.filter((u) => u.role === 'ORG_ADMIN').length;
  const members = rows.filter((u) => u.role === 'USER').length;

  const filtered = rows.filter((u) => roleFilter === 'ALL' || u.role === roleFilter);

  // The server already sorts by customer name, then role, then name, so a single
  // pass preserves that order — no client-side sort, and groups come out in the
  // same order every render.
  const groups = useMemo(() => {
    const byOrg = new Map<string, { org: ClientUser['customer']; users: ClientUser[] }>();
    for (const u of filtered) {
      const g = byOrg.get(u.customer.id);
      if (g) g.users.push(u);
      else byOrg.set(u.customer.id, { org: u.customer, users: [u] });
    }
    return [...byOrg.values()];
  }, [filtered]);

  return (
    <RoleGuard allowedRoles={['ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-6 sm:p-8 max-w-[1200px] mx-auto space-y-6">

            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
              <p className="text-sm text-slate-500 mb-1">Platform</p>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Clients</h1>
              <p className="mt-1 text-sm text-slate-500">Everyone in your client organizations, grouped by company.</p>
            </motion.div>

            {!canManageUsers ? (
              // RoleGuard admits any ADMINISTRATOR; the roster needs its own key,
              // so name it rather than rendering an empty page.
              <div className="card p-8 text-center">
                <p className="text-sm font-medium text-slate-900">You don&apos;t have access to the client directory</p>
                <p className="mt-1.5 text-sm text-slate-500">Clients requires the <span className="font-mono text-xs">users.manage</span> permission. Ask an administrator to grant it.</p>
              </div>
            ) : (
              <>
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.04 }}>
                  <div className="grid grid-cols-3 gap-4">
                    <SummaryTile label="Org Admins" value={orgAdmins} tone="violet" hint="Across every client org" />
                    <SummaryTile label="Users" value={members} tone="emerald" hint="Across every client org" />
                    <SummaryTile label="Total" value={rows.length} tone="brand" hint={`In ${new Set(rows.map((u) => u.customer.id)).size} organizations`} />
                  </div>
                </motion.div>

                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.08 }}>
                  <div className="card overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between gap-3 flex-wrap">
                      <Segmented
                        value={roleFilter}
                        onChange={setRoleFilter}
                        size="sm"
                        layoutId="clientsRole"
                        options={[
                          { value: 'ALL', label: 'Everyone' },
                          { value: 'ORG_ADMIN', label: 'Org Admins' },
                          { value: 'USER', label: 'Users' },
                        ]}
                      />
                      <span className="text-xs text-slate-400 tabular-nums">
                        {filtered.length} {filtered.length === 1 ? 'person' : 'people'}
                        {groups.length > 0 && ` · ${groups.length} ${groups.length === 1 ? 'org' : 'orgs'}`}
                      </span>
                    </div>

                    {isLoading ? (
                      <div className="p-4 space-y-3">{Array.from({ length: 5 }).map((_, i) => <ShimmerRow key={i} />)}</div>
                    ) : groups.length === 0 ? (
                      <p className="px-5 py-12 text-center text-sm text-slate-400">
                        {rows.length === 0
                          ? 'No client users yet. They appear here once an organization registers.'
                          : `No ${roleFilter === 'ORG_ADMIN' ? 'org admins' : 'users'} in any client organization.`}
                      </p>
                    ) : (
                      <div className="divide-y divide-slate-100">
                        {groups.map(({ org, users }) => (
                          <section key={org.id}>
                            {/* Sticky so the company stays visible while scrolling
                                a long roster. Links to the org detail page, which
                                is where editing a member actually happens. */}
                            <header className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-slate-50/95 backdrop-blur-sm px-4 py-2 border-b border-slate-100">
                              <Link
                                href={`/saas-admin/orgs/${org.id}`}
                                className="text-xs font-semibold text-slate-700 hover:text-brand transition-colors truncate"
                              >
                                {org.name}
                                <span className="ml-1.5 font-normal text-slate-400">→</span>
                              </Link>
                              <span className="text-[11px] text-slate-400 tabular-nums flex-shrink-0">
                                {users.length} {users.length === 1 ? 'person' : 'people'}
                              </span>
                            </header>

                            <ul className="divide-y divide-slate-50">
                              {users.map((u) => {
                                const cfg = roleConfig[u.role] ?? { label: u.role, cls: 'text-slate-600 bg-slate-100' };
                                const isOnline = u.lastLoginAt && (Date.now() - new Date(u.lastLoginAt).getTime()) < 30 * 60 * 1000;
                                return (
                                  <li key={u.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors">
                                    <div className="relative flex-shrink-0">
                                      <div className={`w-9 h-9 rounded-full bg-gradient-to-br ${u.role === 'ORG_ADMIN' ? 'from-violet-400 to-violet-600' : 'from-slate-300 to-slate-400'} flex items-center justify-center text-sm font-bold text-white`}>
                                        {u.name.charAt(0)}
                                      </div>
                                      {isOnline && <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 rounded-full border-2 border-white" />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-baseline gap-2">
                                        <p className="text-sm font-semibold text-slate-900 truncate">{u.name}</p>
                                        {!mfaStatus(u).on && (
                                        // role="img" + aria-label because a bare ⚠ with only a
                                        // title attribute is silent to screen readers and
                                        // unreachable on touch.
                                        <span role="img" aria-label="Two-factor authentication is off"
                                          title="Two-factor authentication is off"
                                          className="text-amber-500 text-xs flex-shrink-0">⚠</span>
                                      )}
                                      </div>
                                      <p className="text-xs text-slate-400 truncate">{u.email}</p>
                                    </div>
                                    <div className="flex items-center gap-4 flex-shrink-0">
                                      <p className="text-xs font-mono text-slate-500 hidden sm:block">
                                        {u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never'}
                                      </p>
                                      <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${cfg.cls}`}>
                                        <span className="w-1.5 h-1.5 rounded-full bg-current" />
                                        {cfg.label}
                                      </span>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          </section>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              </>
            )}

          </div>
        </main>
      </div>
    </RoleGuard>
  );
}
