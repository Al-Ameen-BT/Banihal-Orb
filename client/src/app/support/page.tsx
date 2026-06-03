'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { orgsApi } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import TicketForm from '@/components/ui/TicketForm';
import type { OrganizationService } from '@/lib/schemas';

export default function SupportPage() {
  const { data: servicesData } = useQuery<{ services: OrganizationService[]; monthlyTotal: number }>({
    queryKey: ['my-services'],
    queryFn: () => orgsApi.getServices().then((r) => r.data as { services: OrganizationService[]; monthlyTotal: number }),
    staleTime: 30_000,
  });

  return (
    <RoleGuard allowedRoles={['USER', 'ORG_ADMIN', 'SADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[800px] mx-auto space-y-8">

            {/* Header */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
              <p className="text-sm text-slate-500 mb-1">Help &amp; Support</p>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">Open a Support Ticket</h1>
              <p className="mt-1 text-sm text-slate-500">
                Describe your issue or request. Critical incidents trigger a 1-hour response SLA.
              </p>
            </motion.div>

            {/* SLA reference */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.04 }} className="card p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500 mb-3">Response SLA by Priority</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <SlaCell label="Critical" sla="1 hour"  cls="text-red-700 bg-red-50"      dot="bg-red-500" />
                <SlaCell label="High"     sla="4 hours" cls="text-amber-700 bg-amber-50"  dot="bg-amber-500" />
                <SlaCell label="Medium"   sla="1 day"   cls="text-cyan-700 bg-cyan-50"    dot="bg-cyan-500" />
                <SlaCell label="Low"      sla="3 days"  cls="text-slate-600 bg-slate-100" dot="bg-slate-400" />
              </div>
            </motion.div>

            {/* Ticket form */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.07 }}>
              <TicketForm services={servicesData?.services ?? []} />
            </motion.div>

            {/* Cross-link to chat */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.1 }}>
              <Link href="/chat" className="block card p-5 hover:shadow-card-hover hover:border-slate-300 transition-all group">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-brand to-violet-600 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.091 3.091z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-900 group-hover:text-brand transition-colors">Have a quick question?</p>
                    <p className="text-xs text-slate-500 mt-0.5">Try the assistant — for simple questions you don&apos;t need to open a ticket.</p>
                  </div>
                  <span className="text-brand opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                </div>
              </Link>
            </motion.div>

          </div>
        </main>
      </div>
    </RoleGuard>
  );
}

function SlaCell({ label, sla, cls, dot }: { label: string; sla: string; cls: string; dot: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold flex-shrink-0 ${cls}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
        {label}
      </span>
      <span className="text-sm font-mono tabular-nums text-slate-700">{sla}</span>
    </div>
  );
}
