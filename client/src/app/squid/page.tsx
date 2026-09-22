'use client';

import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { squidApi } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { icons } from '@/components/ui/Sidebar';
import GlowButton from '@/components/ui/GlowButton';
import { Shimmer } from '@/components/ui/Shimmer';
import { useAuth } from '@/contexts/AuthContext';

interface ProxySummary {
  id: string;
  name: string;
  description: string | null;
  status: string;
}

export default function SquidIndexPage() {
  const router = useRouter();
  const { user } = useAuth();
  const isPlatformAdmin = user?.role === 'ADMINISTRATOR';

  const { data, isLoading } = useQuery<{ proxies: ProxySummary[] }>({
    queryKey: ['squid-proxies'],
    queryFn: () => squidApi.list({}).then((r) => r.data as { proxies: ProxySummary[] }),
  });
  
  const proxies = useMemo(() => data?.proxies ?? [], [data?.proxies]);

  useEffect(() => {
    // If the org has exactly one proxy, go straight to its dashboard
    if (proxies.length === 1) {
      router.replace(`/squid/${proxies[0].id}/dashboard`);
    }
  }, [proxies, router]);

  return (
    <div className="p-6 sm:p-8 max-w-[1100px] mx-auto space-y-6">
      <PageHeader eyebrow="Security" title="Squid Outbound Proxy" icon={icons.squid}
        subtitle="Configure ACL rules per proxy. A pull-based agent on each host applies the generated config and reports back — no inbound ports needed." />

      {isLoading ? (
        <div className="space-y-3">{[...Array(2)].map((_, i) => <Shimmer key={i} className="h-20 rounded-xl" />)}</div>
      ) : proxies.length === 0 ? (
        <div className="card p-12 text-center">
          <p className="text-sm font-medium text-slate-700 mb-1">
            {isPlatformAdmin ? 'No proxies yet — provision one from Platform Control Plane' : 'No proxies assigned to your organization'}
          </p>
          <p className="text-xs text-slate-400">
            {isPlatformAdmin 
              ? 'Provision a proxy from /saas-admin/squid, assign it to an organization, and pair it with the agent package on the target host.'
              : 'Contact your platform administrator to provision a squid proxy for your organization.'
            }
          </p>
          {isPlatformAdmin && (
            <div className="mt-6">
              <GlowButton onClick={() => router.push('/saas-admin/squid')}>Go to Platform Proxies</GlowButton>
            </div>
          )}
        </div>
      ) : proxies.length > 1 ? (
        <div className="space-y-3">
          <p className="text-xs text-slate-400 font-medium">Select a proxy to manage:</p>
          {proxies.map((p) => (
            <button key={p.id} type="button" onClick={() => router.push(`/squid/${p.id}/dashboard`)} className="w-full text-left card p-4 flex items-center gap-4 hover:border-brand-200 transition-colors cursor-pointer">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-900">{p.name}</p>
                {p.description && <p className="text-xs text-slate-400 mt-0.5 truncate">{p.description}</p>}
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-[10px] text-brand-600 font-medium bg-brand-50 px-2 py-1 rounded-md">Manage →</p>
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}