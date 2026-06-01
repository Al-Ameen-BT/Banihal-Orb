'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { usersApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import Toggle from '@/components/ui/Toggle';
import GlowButton from '@/components/ui/GlowButton';

const roleConfig: Record<string, { label: string; cls: string; avatar: string }> = {
  USER:       { label: 'User',        cls: 'text-slate-600 bg-slate-100',  avatar: 'from-slate-400 to-slate-500' },
  ORG_ADMIN:  { label: 'Org Admin',   cls: 'text-violet-700 bg-violet-50', avatar: 'from-violet-400 to-violet-600' },
  SAAS_ADMIN: { label: 'Super Admin', cls: 'text-brand-700 bg-brand-50',   avatar: 'from-brand-400 to-brand-600' },
};

export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [saved, setSaved] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (data: { name?: string; mfaEnabled?: boolean }) => usersApi.updateMe(data),
    onSuccess: async () => {
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const roleCfg = roleConfig[user?.role ?? ''] ?? roleConfig['USER']!;

  return (
    <RoleGuard allowedRoles={['USER', 'ORG_ADMIN', 'SAAS_ADMIN']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[640px] mx-auto space-y-8">

            {/* Header */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
              <p className="text-sm text-slate-500 mb-1">Account</p>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">My Profile</h1>
            </motion.div>

            {/* Identity */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.04, ease: [0.4,0,0.2,1] }}>
              <h2 className="text-base font-semibold text-slate-900 mb-4">Identity</h2>
              <div className="card p-6">
                {/* Avatar row */}
                <div className="flex items-center gap-4 mb-6 pb-6 border-b border-slate-100">
                  <div className={`w-14 h-14 rounded-full bg-gradient-to-br ${roleCfg.avatar} flex items-center justify-center text-2xl font-bold text-white`}>
                    {user?.name?.charAt(0) ?? '?'}
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-slate-900 leading-tight">{user?.name}</p>
                    <p className="text-sm text-slate-500 mt-0.5">{user?.email}</p>
                    {user?.role && (
                      <span className={`mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold ${roleCfg.cls}`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-current" />
                        {roleCfg.label}
                      </span>
                    )}
                  </div>
                </div>

                {/* Email (read-only) */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Email</label>
                  <div className="px-3.5 py-2.5 text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-lg select-all">{user?.email}</div>
                </div>

                {/* Name */}
                <div className="mb-5">
                  <label htmlFor="name" className="block text-sm font-medium text-slate-700 mb-1.5">Display Name</label>
                  <input id="name" value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Your display name" />
                </div>

                {/* Save */}
                <div className="flex items-center gap-3">
                  <GlowButton onClick={() => updateMutation.mutate({ name })} disabled={updateMutation.isPending || name === user?.name} loading={updateMutation.isPending}>
                    Save Changes
                  </GlowButton>
                  <AnimatePresence>
                    {saved && (
                      <motion.span initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                        className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                        Saved
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>

            {/* Security */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.07, ease: [0.4,0,0.2,1] }}>
              <h2 className="text-base font-semibold text-slate-900 mb-4">Security</h2>
              <div className="card px-6">
                <Toggle
                  label="Two-Factor Authentication"
                  description="Add an extra layer of security to your account"
                  enabled={user?.mfaEnabled ?? false}
                  onChange={(v) => updateMutation.mutate({ mfaEnabled: v })}
                  disabled={updateMutation.isPending}
                />
              </div>
            </motion.div>

          </div>
        </main>
      </div>
    </RoleGuard>
  );
}
