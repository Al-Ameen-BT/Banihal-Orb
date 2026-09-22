'use client';

import { motion, HTMLMotionProps } from 'framer-motion';
import clsx from 'clsx';
import React from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface GlowButtonProps extends Omit<HTMLMotionProps<'button'>, 'ref'> {
  children: React.ReactNode;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
  className?: string;
}

// Clean Enterprise: solid brand primary, hairline secondary, subtle ghost.
// Hover changes color/shadow only — never scale that shifts layout.
const variants: Record<Variant, string> = {
  primary:
    'bg-brand text-white font-semibold shadow-xs hover:bg-brand-700 active:bg-brand-800',
  secondary:
    'bg-white text-slate-700 font-medium border border-slate-300 hover:bg-slate-50 hover:border-slate-400 active:bg-slate-100',
  ghost:
    'bg-transparent text-slate-600 font-medium hover:bg-slate-100 hover:text-slate-900',
  danger:
    'bg-white text-red-600 font-medium border border-red-200 hover:bg-red-50 hover:border-red-300 active:bg-red-100',
};

export default function GlowButton({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  icon,
  className,
  ...rest
}: GlowButtonProps) {
  const sizeClasses = {
    sm: 'px-3 py-1.5 text-xs gap-1.5',
    md: 'px-4 py-2.5 text-sm gap-2',
    lg: 'px-6 py-3 text-base gap-2.5',
  };

  return (
    <motion.button
      whileTap={{ scale: disabled || loading ? 1 : 0.98 }}
      transition={{ duration: 0.1 }}
      disabled={disabled || loading}
      className={clsx(
        'relative inline-flex items-center justify-center cursor-pointer rounded-lg',
        'transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variants[variant],
        sizeClasses[size],
        className,
      )}
      {...rest}
    >
      {loading && (
        <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-r-transparent animate-spin" />
      )}
      {icon && <span className="flex-shrink-0">{icon}</span>}
      <span className={loading ? 'opacity-80' : ''}>{children}</span>
    </motion.button>
  );
}
