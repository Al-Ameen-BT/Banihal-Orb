'use client';

import { motion } from 'framer-motion';
import AnimatedNumber from './AnimatedNumber';

type Tone = 'brand' | 'cyan' | 'violet' | 'emerald' | 'amber' | 'rose' | 'bio' | 'magenta';

interface KpiCardProps {
  title: string;
  value: number | string;
  delta?: number;
  subtitle?: string;
  tone?: Tone;
  prefix?: string;
  suffix?: string;
  format?: (n: number) => string;
}

// Tone → tinted dot. Legacy tones (bio/magenta) remapped to light-friendly hues.
const toneMap: Record<Tone, string> = {
  brand:   'bg-brand',
  cyan:    'bg-cyan-500',
  violet:  'bg-violet-500',
  emerald: 'bg-emerald-500',
  amber:   'bg-amber-500',
  rose:    'bg-rose-500',
  bio:     'bg-emerald-500',
  magenta: 'bg-fuchsia-500',
};

export default function KpiCard({
  title,
  value,
  delta,
  subtitle,
  tone = 'brand',
  prefix = '',
  suffix = '',
  format,
}: KpiCardProps) {
  const dot = toneMap[tone];
  const hasDelta = delta !== undefined;
  const isPositive = (delta ?? 0) >= 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      className="bg-white border border-slate-200 rounded-xl shadow-card p-5 transition-shadow duration-200 hover:shadow-card-hover"
    >
      {/* Label row */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">{title}</p>
        <span className={`w-2 h-2 rounded-full ${dot}`} />
      </div>

      {/* Value — hero element */}
      <div className="flex items-baseline gap-1">
        {prefix && <span className="text-slate-400 text-xl font-semibold">{prefix}</span>}
        <span className="font-mono text-[2rem] font-bold text-slate-900 tabular-nums leading-none tracking-tight">
          {typeof value === 'number' ? <AnimatedNumber value={value} format={format} /> : value}
        </span>
        {suffix && <span className="text-slate-400 text-xl font-semibold ml-0.5">{suffix}</span>}
      </div>

      {/* Footer metadata */}
      {(hasDelta || subtitle) && (
        <div className="flex items-center gap-2 mt-3">
          {hasDelta && (
            <span
              className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[11px] font-semibold tabular-nums ${
                isPositive ? 'text-emerald-700 bg-emerald-50' : 'text-red-700 bg-red-50'
              }`}
            >
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 12 12" aria-hidden="true">
                {isPositive ? <path d="M6 2l4 5H2l4-5z" /> : <path d="M6 10l-4-5h8l-4 5z" />}
              </svg>
              {Math.abs(delta!).toFixed(1)}%
            </span>
          )}
          {subtitle && <span className="text-xs text-slate-400">{subtitle}</span>}
        </div>
      )}
    </motion.div>
  );
}
