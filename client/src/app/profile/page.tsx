'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { usersApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar, { icons } from '@/components/ui/Sidebar';
import { PageHeader } from '@/components/ui/PageHeader';
import Toggle from '@/components/ui/Toggle';
import GlowButton from '@/components/ui/GlowButton';
import EnablePushButton from '@/components/EnablePushButton';
import { roleBadgeFor, mfaStatus } from '@/lib/display';

const roleConfig: Record<string, { label: string; cls: string; avatar: string }> = {
  USER:          { label: 'User',          cls: 'text-slate-600 bg-slate-100',  avatar: 'from-slate-400 to-slate-500' },
  ORG_ADMIN:     { label: 'Org Admin',     cls: 'text-violet-700 bg-violet-50', avatar: 'from-violet-400 to-violet-600' },
  ADMINISTRATOR: { label: 'Administrator', cls: 'text-rose-700 bg-rose-50',     avatar: 'from-rose-500 to-rose-700' },
};

export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [saved, setSaved] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  const updateMutation = useMutation({
    mutationFn: (data: { name?: string; mfaEnabled?: boolean }) => usersApi.updateMe(data),
    onSuccess: async () => {
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const passwordMutation = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) => usersApi.changePassword(data),
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordError('');
      setPasswordSaved(true);
      setTimeout(() => setPasswordSaved(false), 2500);
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to update password';
      setPasswordError(msg);
    },
  });

  function handlePasswordSubmit() {
    setPasswordError('');
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }
    passwordMutation.mutate({ currentPassword, newPassword });
  }

  const roleCfg = roleConfig[user?.role ?? ''] ?? roleConfig['USER']!;
  // This page used to render roleCfg.label unconditionally, so an Intern's own
  // profile told them they were an "Administrator" — and unlike the sidebar, a
  // reload never corrected it because the platform role was never consulted.
  const staffBadge = user?.role === 'ADMINISTRATOR' ? roleBadgeFor(user.platformRole) : null;
  const mfa = mfaStatus(user ?? { mfaEnabled: false });

  return (
    <RoleGuard allowedRoles={['USER', 'ORG_ADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-8 max-w-[640px] mx-auto space-y-8">

            {/* Header */}
            <PageHeader eyebrow="Account" title="My Profile" icon={icons.profile} />

            {/* Identity */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.04, ease: [0.4,0,0.2,1] }}>
              <h2 className="text-base font-semibold text-slate-900 mb-4">Identity</h2>
              <div className="card p-6">
                {/* Avatar row */}
                <div className="flex items-center gap-4 mb-6 pb-6 border-b border-slate-100">
                  <div className={`w-14 h-14 rounded-full flex items-center justify-center text-2xl font-bold ${
                    staffBadge ? `${staffBadge.cls} ring-1 ring-inset ring-current/20` : `bg-gradient-to-br ${roleCfg.avatar} text-white`
                  }`}>
                    {user?.name?.charAt(0) ?? '?'}
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-slate-900 leading-tight">{user?.name}</p>
                    <p className="text-sm text-slate-500 mt-0.5">{user?.email}</p>
                    {user?.role && (
                      <span className={`mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold ${staffBadge?.cls ?? roleCfg.cls}`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-current" />
                        {staffBadge?.label ?? roleCfg.label}
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
                {/* Under org enforcement this shows ON and locks. Before, it could
                    be switched off while login still challenged on every untrusted
                    device — the control appeared to work and changed nothing. The
                    server refuses the write too, so the API can't route around it. */}
                <Toggle
                  label="Two-Factor Authentication"
                  description={mfa.source === 'org'
                    ? 'Required by your organization — this cannot be turned off.'
                    : 'Add an extra layer of security to your account'}
                  enabled={mfa.on}
                  onChange={(v) => updateMutation.mutate({ mfaEnabled: v })}
                  disabled={updateMutation.isPending || mfa.source === 'org'}
                />
              </div>
            </motion.div>

            {/* Notifications */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.1, ease: [0.4,0,0.2,1] }}>
              <h2 className="text-base font-semibold text-slate-900 mb-4">Notifications</h2>
              <div className="card p-6">
                <p className="text-sm font-medium text-slate-900">Desktop notifications</p>
                <p className="text-xs text-slate-500 mt-1 mb-4">
                  Get notified on this device when a ticket is assigned to you — even when this tab isn’t open.
                  Applies to this browser only; enable it again on each device you use.
                </p>
                <EnablePushButton />
              </div>
            </motion.div>

            {/* Change Password */}
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.13, ease: [0.4,0,0.2,1] }}>
              <h2 className="text-base font-semibold text-slate-900 mb-4">Change Password</h2>
              <div className="card p-6 space-y-4">
                <div>
                  <label htmlFor="currentPassword" className="block text-sm font-medium text-slate-700 mb-1.5">Current password</label>
                  <input
                    id="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="input"
                    placeholder="••••••••••••"
                  />
                </div>
                <div>
                  <label htmlFor="newPassword" className="block text-sm font-medium text-slate-700 mb-1.5">New password</label>
                  <input
                    id="newPassword"
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="input"
                    placeholder="Min. 12 chars, upper, lower, number, symbol"
                  />
                </div>
                <div>
                  <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-700 mb-1.5">Confirm new password</label>
                  <input
                    id="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="input"
                    placeholder="Re-enter new password"
                  />
                </div>

                <AnimatePresence>
                  {passwordError && (
                    <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                      className="flex items-center gap-2 text-sm text-red-600">
                      <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                      </svg>
                      {passwordError}
                    </motion.p>
                  )}
                </AnimatePresence>

                <div className="flex items-center gap-3 pt-1">
                  <GlowButton
                    onClick={handlePasswordSubmit}
                    disabled={passwordMutation.isPending || !currentPassword || !newPassword || !confirmPassword}
                    loading={passwordMutation.isPending}
                  >
                    Update Password
                  </GlowButton>
                  <AnimatePresence>
                    {passwordSaved && (
                      <motion.span initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                        className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                        Password updated
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>

          </div>
        </main>
      </div>
    </RoleGuard>
  );
}
