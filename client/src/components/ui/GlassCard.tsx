'use client';

import { motion, HTMLMotionProps } from 'framer-motion';
import clsx from 'clsx';
import React from 'react';

type Accent = 'brand' | 'violet' | 'emerald' | 'amber' | 'none';

interface GlassCardProps extends Omit<HTMLMotionProps<'div'>, 'ref'> {
  children: React.ReactNode;
  glow?: Accent;       // kept name for API compatibility — renders a top accent strip
  interactive?: boolean;
  className?: string;
  ambient?: boolean;   // API compat — unused
}

const accentMap: Record<Accent, string> = {
  brand:   'before:bg-brand',
  violet:  'before:bg-violet-500',
  emerald: 'before:bg-emerald-500',
  amber:   'before:bg-amber-500',
  none:    '',
};

export default function GlassCard({
  children,
  glow = 'none',
  interactive = false,
  ambient,   // eslint-disable-line no-unused-vars
  className,
  ...rest
}: GlassCardProps) {
  const hasAccent = glow !== 'none';
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      className={clsx(
        'relative bg-white border border-slate-200 rounded-xl shadow-card overflow-hidden',
        hasAccent && 'before:absolute before:inset-x-0 before:top-0 before:h-1 before:content-[""]',
        accentMap[glow],
        interactive && 'cursor-pointer transition-shadow duration-200 hover:shadow-card-hover hover:border-slate-300',
        className,
      )}
      {...rest}
    >
      {children}
    </motion.div>
  );
}
