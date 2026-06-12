'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import GlowButton from '@/components/ui/GlowButton';

const stagger = {
  animate: { transition: { staggerChildren: 0.08 } },
};

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] } },
};

export default function NotFoundPage() {
  return (
    <div className="relative min-h-screen flex items-center justify-center px-6 overflow-hidden bg-[var(--canvas)]">

      {/* Background layer */}
      <div className="fixed inset-0 -z-10 pointer-events-none" aria-hidden>
        {/* Brand blue ambient glow */}
        <div
          className="absolute -top-32 left-1/2 -translate-x-1/2 w-[900px] h-[700px] rounded-full opacity-50"
          style={{ background: 'radial-gradient(ellipse, rgba(37,99,235,0.11) 0%, transparent 70%)' }}
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
        {/* Ghost number */}
        <div className="absolute inset-0 flex items-center justify-center select-none">
          <span
            className="text-[32vw] font-black leading-none tabular-nums"
            style={{ color: 'rgba(37,99,235,0.045)', letterSpacing: '-0.04em' }}
          >
            404
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
        <div className="bg-white/90 backdrop-blur-sm border border-slate-200/80 rounded-3xl shadow-[0_8px_40px_-8px_rgba(37,99,235,0.14),0_1px_3px_0_rgba(15,23,42,0.06)] px-10 py-12 text-center">

          {/* Floating icon */}
          <motion.div variants={fadeUp} className="flex justify-center mb-7">
            <motion.div
              animate={{ y: [0, -7, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
              className="relative"
            >
              {/* Glow halo */}
              <div className="absolute inset-0 rounded-2xl bg-brand/20 blur-2xl scale-125" />
              <div className="relative w-[72px] h-[72px] rounded-2xl bg-gradient-to-br from-brand-50 to-brand-100 border border-brand-200 flex items-center justify-center shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                <svg className="w-9 h-9 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
                </svg>
              </div>
            </motion.div>
          </motion.div>

          {/* Badge */}
          <motion.div variants={fadeUp} className="flex justify-center mb-5">
            <span className="inline-flex items-center gap-2 bg-brand-50 border border-brand-200 rounded-full px-4 py-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse" />
              <span className="font-mono text-[11px] font-bold text-brand-700 tracking-[0.15em] uppercase">Error 404</span>
            </span>
          </motion.div>

          {/* Heading */}
          <motion.h1 variants={fadeUp} className="text-[28px] font-bold text-slate-900 tracking-tight mb-3">
            Page Not Found
          </motion.h1>

          {/* Description */}
          <motion.p variants={fadeUp} className="text-[15px] text-slate-500 leading-relaxed mb-2 max-w-[320px] mx-auto">
            We couldn&apos;t find the page you were looking for.
          </motion.p>
          <motion.p variants={fadeUp} className="text-[13px] text-slate-400 leading-relaxed mb-9 max-w-[300px] mx-auto">
            The link may be broken, the page may have moved, or you may have typed the URL incorrectly.
          </motion.p>

          {/* Divider */}
          <motion.div variants={fadeUp} className="h-px bg-slate-100 mb-7" />

          {/* Actions */}
          <motion.div variants={fadeUp} className="flex items-center justify-center gap-3">
            <Link href="/dashboard">
              <GlowButton>Back to Dashboard</GlowButton>
            </Link>
            <Link href="/">
              <GlowButton variant="secondary">Go Home</GlowButton>
            </Link>
          </motion.div>

          {/* Help link */}
          <motion.p variants={fadeUp} className="mt-6 text-xs text-slate-400">
            Looking for something?{' '}
            <Link href="/ticketing" className="text-brand hover:text-brand-700 underline underline-offset-2 transition-colors">
              Raise a ticket
            </Link>
          </motion.p>
        </div>
      </motion.div>
    </div>
  );
}
