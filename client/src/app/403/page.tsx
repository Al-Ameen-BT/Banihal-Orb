'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import GlowButton from '@/components/ui/GlowButton';
import AmbientBackdrop from '@/components/ui/AmbientBackdrop';

export default function ForbiddenPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <AmbientBackdrop />
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
        className="max-w-md w-full text-center"
      >
        {/* Icon */}
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-red-50 border border-red-100 mb-6">
          <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
        </div>

        <p className="font-mono text-sm font-semibold text-red-500 mb-2 tracking-wide">ERROR 403</p>
        <h1 className="text-2xl font-bold text-slate-900 mb-3">Access denied</h1>
        <p className="text-sm text-slate-500 leading-relaxed mb-8 max-w-sm mx-auto">
          Your current role doesn&apos;t grant access to this area. Contact your administrator to request elevated permissions.
        </p>

        {/* Actions */}
        <div className="flex items-center justify-center gap-3">
          <Link href="/dashboard">
            <GlowButton>Back to dashboard</GlowButton>
          </Link>
          <Link href="/profile">
            <GlowButton variant="secondary">My profile</GlowButton>
          </Link>
        </div>
      </motion.div>
    </div>
  );
}
