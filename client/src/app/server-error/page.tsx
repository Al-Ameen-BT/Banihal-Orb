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

export default function ServerErrorPage() {
  return (
    <div className="relative min-h-screen flex items-center justify-center px-6 overflow-hidden bg-[#F8FAFC]">

      {/* Background layer */}
      <div className="fixed inset-0 -z-10 pointer-events-none" aria-hidden>
        {/* Amber ambient glow */}
        <div
          className="absolute -top-32 left-1/2 -translate-x-1/2 w-[900px] h-[700px] rounded-full opacity-50"
          style={{ background: 'radial-gradient(ellipse, rgba(245,158,11,0.13) 0%, transparent 70%)' }}
        />
        {/* Dot grid */}
        <div
          className="absolute inset-0 opacity-[0.45]"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(15,23,42,0.05) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />
        {/* Ghost number */}
        <div className="absolute inset-0 flex items-center justify-center select-none">
          <span
            className="text-[32vw] font-black leading-none tabular-nums"
            style={{ color: 'rgba(245,158,11,0.05)', letterSpacing: '-0.04em' }}
          >
            500
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
        <div className="bg-white/90 backdrop-blur-sm border border-slate-200/80 rounded-3xl shadow-[0_8px_40px_-8px_rgba(245,158,11,0.15),0_1px_3px_0_rgba(15,23,42,0.06)] px-10 py-12 text-center">

          {/* Floating icon */}
          <motion.div variants={fadeUp} className="flex justify-center mb-7">
            <motion.div
              animate={{ y: [0, -7, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
              className="relative"
            >
              {/* Glow halo */}
              <div className="absolute inset-0 rounded-2xl bg-amber-400/20 blur-2xl scale-125" />
              <div className="relative w-[72px] h-[72px] rounded-2xl bg-gradient-to-br from-amber-50 to-amber-100 border border-amber-200 flex items-center justify-center shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                <svg className="w-9 h-9 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M21.75 17.25v.007a3 3 0 01-3 2.993H5.25a3 3 0 01-3-2.993v-.007m0 0a3 3 0 013-2.993H18.75a3 3 0 013 2.993m-18 0V9a3 3 0 013-3h12a3 3 0 013 3v8.25M12 12h.008v.008H12V12zm0-4h.008v.008H12V8zm0 8h.008v.008H12v-.008z" />
                </svg>
              </div>
            </motion.div>
          </motion.div>

          {/* Badge */}
          <motion.div variants={fadeUp} className="flex justify-center mb-5">
            <span className="inline-flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-full px-4 py-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              <span className="font-mono text-[11px] font-bold text-amber-600 tracking-[0.15em] uppercase">Error 500</span>
            </span>
          </motion.div>

          {/* Heading */}
          <motion.h1 variants={fadeUp} className="text-[28px] font-bold text-slate-900 tracking-tight mb-3">
            Internal Server Error
          </motion.h1>

          {/* Description */}
          <motion.p variants={fadeUp} className="text-[15px] text-slate-500 leading-relaxed mb-2 max-w-[320px] mx-auto">
            Something unexpected happened on our end.
          </motion.p>
          <motion.p variants={fadeUp} className="text-[13px] text-slate-400 leading-relaxed mb-9 max-w-[300px] mx-auto">
            Our team has been notified. Please try again in a moment — if the issue persists, reach out to support.
          </motion.p>

          {/* Divider */}
          <motion.div variants={fadeUp} className="h-px bg-slate-100 mb-7" />

          {/* Actions */}
          <motion.div variants={fadeUp} className="flex items-center justify-center gap-3">
            <GlowButton onClick={() => window.location.reload()}>
              Try Again
            </GlowButton>
            <Link href="/dashboard">
              <GlowButton variant="secondary">Back to Dashboard</GlowButton>
            </Link>
          </motion.div>

          {/* Help link */}
          <motion.p variants={fadeUp} className="mt-6 text-xs text-slate-400">
            Still seeing this?{' '}
            <Link href="/support" className="text-brand hover:text-brand-700 underline underline-offset-2 transition-colors">
              Contact support
            </Link>
          </motion.p>
        </div>
      </motion.div>
    </div>
  );
}
