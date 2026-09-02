'use client';

import { motion } from 'framer-motion';

// The one layout behind /403, /not-found, /error and /server-error. Those four
// pages were byte-identical apart from an accent colour, a glyph, a ghost
// watermark and their copy — and each carried its own copy of these variants.

const stagger = { animate: { transition: { staggerChildren: 0.08 } } };

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] } },
};

// Tailwind needs the full class string in the source to emit it, so each accent
// spells its classes out rather than building them from a colour name.
export type Accent = 'rose' | 'brand' | 'violet' | 'amber';

const accents: Record<Accent, {
  glow: string; ghost: string; shadow: string;
  halo: string; tile: string; icon: string; badge: string; dot: string; badgeText: string;
}> = {
  rose: {
    glow: 'rgba(244,63,94,0.12)', ghost: 'rgba(244,63,94,0.04)', shadow: 'rgba(244,63,94,0.15)',
    halo: 'bg-rose-400/20', tile: 'from-rose-50 to-rose-100 border-rose-200', icon: 'text-rose-500',
    badge: 'bg-rose-50 border-rose-200', dot: 'bg-rose-500', badgeText: 'text-rose-600',
  },
  brand: {
    glow: 'rgba(37,99,235,0.11)', ghost: 'rgba(37,99,235,0.045)', shadow: 'rgba(37,99,235,0.14)',
    halo: 'bg-brand/20', tile: 'from-brand-50 to-brand-100 border-brand-200', icon: 'text-brand',
    badge: 'bg-brand-50 border-brand-200', dot: 'bg-brand', badgeText: 'text-brand-700',
  },
  violet: {
    glow: 'rgba(124,58,237,0.10)', ghost: 'rgba(124,58,237,0.04)', shadow: 'rgba(124,58,237,0.14)',
    halo: 'bg-violet-400/20', tile: 'from-violet-50 to-violet-100 border-violet-200', icon: 'text-violet-500',
    badge: 'bg-violet-50 border-violet-200', dot: 'bg-violet-500', badgeText: 'text-violet-600',
  },
  amber: {
    glow: 'rgba(245,158,11,0.13)', ghost: 'rgba(245,158,11,0.05)', shadow: 'rgba(245,158,11,0.15)',
    halo: 'bg-amber-400/20', tile: 'from-amber-50 to-amber-100 border-amber-200', icon: 'text-amber-500',
    badge: 'bg-amber-50 border-amber-200', dot: 'bg-amber-500', badgeText: 'text-amber-600',
  },
};

interface ErrorShellProps {
  accent: Accent;
  /** Watermark behind the card — a status number, or a character like `!`. */
  ghost: string;
  /** `d` of the heroicon outline path shown in the floating tile. */
  iconPath: string;
  badge: string;
  heading: string;
  description: string;
  detail: string;
  /** The two buttons. */
  actions: React.ReactNode;
  /** Trailing "Need help? …" line. */
  footer: React.ReactNode;
  /** Optional extra block between the copy and the divider (e.g. an error digest). */
  children?: React.ReactNode;
}

export default function ErrorShell({
  accent, ghost, iconPath, badge, heading, description, detail, actions, footer, children,
}: ErrorShellProps) {
  const a = accents[accent];
  // A number sets its own width; a glyph like "!" needs the larger size to read.
  const ghostSize = /^\d+$/.test(ghost) ? '32vw' : '40vw';

  return (
    <div className="relative min-h-screen flex items-center justify-center px-6 overflow-hidden bg-[var(--canvas)]">

      {/* Background layer */}
      <div className="fixed inset-0 -z-10 pointer-events-none" aria-hidden>
        <div
          className="absolute -top-32 left-1/2 -translate-x-1/2 w-[900px] h-[700px] rounded-full opacity-50"
          style={{ background: `radial-gradient(ellipse, ${a.glow} 0%, transparent 70%)` }}
        />
        <div
          className="absolute inset-0 opacity-[0.45]"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(15,23,42,0.05) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center select-none">
          <span
            className="font-black leading-none tabular-nums"
            style={{ fontSize: ghostSize, color: a.ghost, letterSpacing: '-0.04em' }}
          >
            {ghost}
          </span>
        </div>
      </div>

      {/* Card */}
      <motion.div variants={stagger} initial="initial" animate="animate" className="relative z-10 w-full max-w-md">
        <div
          className="bg-white/90 backdrop-blur-sm border border-slate-200/80 rounded-3xl px-10 py-12 text-center"
          style={{ boxShadow: `0 8px 40px -8px ${a.shadow}, 0 1px 3px 0 rgba(15,23,42,0.06)` }}
        >
          {/* Floating icon */}
          <motion.div variants={fadeUp} className="flex justify-center mb-7">
            <motion.div
              animate={{ y: [0, -7, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
              className="relative"
            >
              <div className={`absolute inset-0 rounded-2xl blur-2xl scale-125 ${a.halo}`} />
              <div className={`relative w-[72px] h-[72px] rounded-2xl bg-gradient-to-br border flex items-center justify-center shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] ${a.tile}`}>
                <svg className={`w-9 h-9 ${a.icon}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={iconPath} />
                </svg>
              </div>
            </motion.div>
          </motion.div>

          <motion.div variants={fadeUp} className="flex justify-center mb-5">
            <span className={`inline-flex items-center gap-2 border rounded-full px-4 py-1.5 ${a.badge}`}>
              <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${a.dot}`} />
              <span className={`font-mono text-[11px] font-bold tracking-[0.15em] uppercase ${a.badgeText}`}>{badge}</span>
            </span>
          </motion.div>

          <motion.h1 variants={fadeUp} className="text-[28px] font-bold text-slate-900 tracking-tight mb-3">
            {heading}
          </motion.h1>

          <motion.p variants={fadeUp} className="text-[15px] text-slate-500 leading-relaxed mb-2 max-w-[320px] mx-auto">
            {description}
          </motion.p>
          <motion.p variants={fadeUp} className="text-[13px] text-slate-400 leading-relaxed mb-9 max-w-[300px] mx-auto">
            {detail}
          </motion.p>

          {children}

          <motion.div variants={fadeUp} className="h-px bg-slate-100 mb-7" />

          <motion.div variants={fadeUp} className="flex items-center justify-center gap-3">
            {actions}
          </motion.div>

          <motion.p variants={fadeUp} className="mt-6 text-xs text-slate-400">
            {footer}
          </motion.p>
        </div>
      </motion.div>
    </div>
  );
}

export { fadeUp };
