'use client';

// The admission queue: organizations that have registered, confirmed their email,
// and are now waiting for a member of staff to hand their admin the approval code.
//
// Deliberately does NOT show the code. It is stored bcrypt-hashed, so it is not
// recoverable here even in principle — the plaintext exists only in the approvers'
// inboxes. "Send a new code" is the recourse when one never arrived.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { saasAdminApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar, { icons } from '@/components/ui/Sidebar';
import { PageHeader } from '@/components/ui/PageHeader';
import GlowButton from '@/components/ui/GlowButton';
import { ShimmerCard } from '@/components/ui/Shimmer';
import { useToast } from '@/components/ui/Toast';

interface PendingOrg {
  id: string;
  name: string;
  domain: string | null;
  mailId: string;
  contactPerson: string;
  contactNumber: string;
  createdAt: string;
  emailVerified: boolean;
  codeExpiresAt: string | null;
  codeAttempts: number;
}

const errMsg = (err: unknown, fallback: string): string =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

function since(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/** Whether a live code is still outstanding, and how long it has left. */
function codeState(org: PendingOrg): { label: string; tone: string } {
  if (!org.codeExpiresAt) return { label: 'No code issued', tone: 'text-slate-400' };
  const secs = Math.round((new Date(org.codeExpiresAt).getTime() - Date.now()) / 1000);
  if (secs <= 0) return { label: 'Code expired', tone: 'text-slate-400' };
  return {
    label: `Code valid for ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`,
    tone: 'text-emerald-600',
  };
}

function PendingOrgs() {
  const toast = useToast();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery<{ orgs: PendingOrg[] }>({
    queryKey: ['saas-admin', 'pending-orgs'],
    queryFn: () => saasAdminApi.listPendingOrgs().then((r) => r.data as { orgs: PendingOrg[] }),
    // Short, because the codes on this page expire in minutes.
    staleTime: 10_000,
  });

  const reissue = useMutation({
    mutationFn: (id: string) => saasAdminApi.reissueOrgApproval(id),
    onMutate: (id: string) => setBusyId(id),
    onSuccess: () => {
      toast('A new approval code has been sent to your inbox.', 'success');
      void qc.invalidateQueries({ queryKey: ['saas-admin', 'pending-orgs'] });
    },
    onError: (err) => toast(errMsg(err, 'Could not issue a new code'), 'error'),
    onSettled: () => setBusyId(null),
  });

  const orgs = data?.orgs ?? [];

  return (
    <div className="p-6 sm:p-8 max-w-[1600px] mx-auto space-y-6">
      <PageHeader eyebrow="Platform" title="Pending organizations" icon={icons.pending}
        subtitle="These organizations cannot sign in until you give their administrator the approval code from your email. Verify who you are speaking to first — withholding the code is how a registration is refused." />

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 2 }).map((_, i) => <ShimmerCard key={i} />)}</div>
      ) : isError ? (
        <div className="card p-8 text-center">
          <p className="text-sm font-medium text-slate-900">Couldn&apos;t load the queue</p>
          <p className="mt-1.5 text-sm text-slate-500">{errMsg(error, 'The service did not respond.')}</p>
          <div className="mt-4">
            <GlowButton variant="secondary" className="py-1.5 px-3 text-xs" onClick={() => void refetch()}>Try again</GlowButton>
          </div>
        </div>
      ) : orgs.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50">
            <svg className="h-6 w-6 text-emerald-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-900">Nothing waiting</p>
          <p className="mt-1.5 text-sm text-slate-500">Every registered organization has been admitted.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {orgs.map((org, i) => {
            const code = codeState(org);
            return (
              <motion.div
                key={org.id}
                initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, delay: i * 0.04 }}
                className="card p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-bold text-slate-900">{org.name}</h2>
                      {org.domain && (
                        <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-semibold text-slate-500">
                          {org.domain}
                        </span>
                      )}
                      {!org.emailVerified && (
                        <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-500/15">
                          Email not confirmed
                        </span>
                      )}
                    </div>

                    <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1.5 text-[13px] sm:grid-cols-2">
                      <div className="flex gap-2">
                        <dt className="w-24 flex-shrink-0 text-slate-400">Administrator</dt>
                        <dd className="font-medium text-slate-700">{org.contactPerson}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-24 flex-shrink-0 text-slate-400">Email</dt>
                        <dd className="truncate font-medium text-slate-700">{org.mailId}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-24 flex-shrink-0 text-slate-400">Phone</dt>
                        <dd className="font-medium text-slate-700">{org.contactNumber}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-24 flex-shrink-0 text-slate-400">Registered</dt>
                        <dd className="font-medium text-slate-700">{since(org.createdAt)}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="flex flex-col items-end gap-2">
                    <span className={`font-mono text-xs tabular-nums ${code.tone}`}>{code.label}</span>
                    {org.codeAttempts > 0 && (
                      <span className="text-[11px] text-amber-600">{org.codeAttempts} failed attempt{org.codeAttempts === 1 ? '' : 's'}</span>
                    )}
                    <GlowButton
                      variant="secondary" className="py-1.5 px-3 text-xs"
                      disabled={busyId === org.id || !org.emailVerified}
                      loading={busyId === org.id}
                      onClick={() => reissue.mutate(org.id)}
                    >
                      Send a new code
                    </GlowButton>
                    {!org.emailVerified && (
                      <span className="max-w-[190px] text-right text-[11px] leading-snug text-slate-400">
                        A code is only issued once they confirm their email.
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function PendingOrgsPage() {
  return (
    <RoleGuard allowedRoles={['ADMINISTRATOR']} permission="orgs.approve">
      <div className="flex">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-y-auto">
          <PendingOrgs />
        </main>
      </div>
    </RoleGuard>
  );
}
