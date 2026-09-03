'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import type { Role } from '@/lib/schemas';

interface RoleGuardProps {
  allowedRoles: Role[];
  /**
   * Platform permission the page also requires. Role alone is too coarse for the
   * vendor's own surfaces — every staff account is ADMINISTRATOR, so without this
   * an Intern reaches /saas-admin/catalog and watches every request 403.
   *
   * A courtesy redirect, not a boundary: the routes behind the page are enforced
   * server-side regardless. Customer roles hold no permissions, so only pass this
   * on pages whose allowedRoles is ADMINISTRATOR-only.
   */
  permission?: string;
  children: React.ReactNode;
}

export default function RoleGuard({ allowedRoles, permission, children }: RoleGuardProps) {
  const { user, loading, can } = useAuth();
  const router = useRouter();
  const allowed = !!user && allowedRoles.includes(user.role) && (!permission || can(permission));

  useEffect(() => {
    if (!loading) {
      if (!user) router.replace('/login');
      else if (!allowed) router.replace('/403');
    }
  }, [user, loading, allowed, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-canvas">
        <div className="flex flex-col items-center gap-4">
          <div className="relative w-9 h-9">
            <div className="absolute inset-0 rounded-full border-2 border-slate-200" />
            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-brand animate-spin" />
          </div>
          <p className="text-xs font-medium text-slate-400">Authenticating…</p>
        </div>
      </div>
    );
  }

  if (!allowed) return null;

  return <>{children}</>;
}
