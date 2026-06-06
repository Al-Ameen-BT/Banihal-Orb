'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { motion } from 'framer-motion';
import GlowButton from '@/components/ui/GlowButton';

const stagger = {
  animate: { transition: { staggerChildren: 0.08 } },
};

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] } },
};

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[App Error]', error);
  }, [error]);

  return (
    <div className="relative min-h-screen flex items-center justify-center px-6 overflow-hidden bg-[var(--canvas)]">

      {/* Background layer */}
      <div className="fixed inset-0 -z-10 pointer-events-none" aria-hidden>
        {/* Violet ambient glow */}
        <div
          className="absolute -top-32 left-1/2 -translate-x-1/2 w-[900px] h-[700px] rounded-full opacity-50"
          style={{ background: 'radial-gradient(ellipse, rgba(124,58,237,0.10) 0%, transparent 70%)' }}
        />
        {/* Dot grid */}
        <div
          className="absolute inset-0 opacity-[0.45]"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(15,23,42,0.05) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />
        <div
          className="absolute inset-0 opacity-0"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.6) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />
        {/* Ghost exclamation mark */}
        <div className="absolute inset-0 flex items-center justify-center select-none">
          <span
            className="font-black leading-none"
            style={{ fontSize: '40vw', color: 'rgba(124,58,237,0.04)', letterSpacing: '-0.04em' }}
          >
            !
          </span>
        </div>
      </div>

      {/* Card */}
      <motion.div
        variants={stagger}
        initial="initial"
        animate="animate"
        className="relative z-10 w-full max-w-md"
      >
        <div className="bg-white/90 backdrop-blur-sm border border-slate-200/80 rounded-3xl shadow-[0_8px_40px_-8px_rgba(124,58,237,0.14),0_1px_3px_0_rgba(15,23,42,0.06)] px-10 py-12 text-center">

          {/* Floating icon */}
          <motion.div variants={fadeUp} className="flex justify-center mb-7">
            <motion.div
              animate={{ y: [0, -7, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
              className="relative"
            >
              {/* Glow halo */}
              <div className="absolute inset-0 rounded-2xl bg-violet-400/20 blur-2xl scale-125" />
              <div className="relative w-[72px] h-[72px] rounded-2xl bg-gradient-to-br from-violet-50 to-violet-100 border border-violet-200 flex items-center justify-center shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                <svg className="w-9 h-9 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                </svg>
              </div>
            </motion.div>
          </motion.div>

          {/* Badge */}
          <motion.div variants={fadeUp} className="flex justify-center mb-5">
            <span className="inline-flex items-center gap-2 bg-violet-50 border border-violet-200 rounded-full px-4 py-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
              <span className="font-mono text-[11px] font-bold text-violet-600 tracking-[0.15em] uppercase">Unexpected Error</span>
            </span>
          </motion.div>

          {/* Heading */}
          <motion.h1 variants={fadeUp} className="text-[28px] font-bold text-slate-900 tracking-tight mb-3">
            Something Went Wrong
          </motion.h1>

          {/* Description */}
          <motion.p variants={fadeUp} className="text-[15px] text-slate-500 leading-relaxed mb-2 max-w-[320px] mx-auto">
            An unexpected error occurred while loading this page.
          </motion.p>
          <motion.p variants={fadeUp} className="text-[13px] text-slate-400 leading-relaxed mb-9 max-w-[300px] mx-auto">
            Try refreshing the page. If the problem continues, our team has been notified and will look into it.
          </motion.p>

          {/* Error digest — for debugging without exposing details */}
          {error.digest && (
            <motion.div variants={fadeUp} className="mb-7">
              <span className="inline-flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">
                <span className="font-mono text-[10px] text-slate-400">digest:</span>
                <span className="font-mono text-[10px] text-slate-500 font-medium">{error.digest}</span>
              </span>
            </motion.div>
          )}

          {/* Divider */}
          <motion.div variants={fadeUp} className="h-px bg-slate-100 mb-7" />

          {/* Actions */}
          <motion.div variants={fadeUp} className="flex items-center justify-center gap-3">
            <GlowButton onClick={reset}>Try Again</GlowButton>
            <Link href="/dashboard">
              <GlowButton variant="secondary">Back to Dashboard</GlowButton>
            </Link>
          </motion.div>

          {/* Help link */}
          <motion.p variants={fadeUp} className="mt-6 text-xs text-slate-400">
            Still broken?{' '}
            <Link href="/support" className="text-brand hover:text-brand-700 underline underline-offset-2 transition-colors">
              Contact support
            </Link>
          </motion.p>
        </div>
      </motion.div>
    </div>
  );
}
