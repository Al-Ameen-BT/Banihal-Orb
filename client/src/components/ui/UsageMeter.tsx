'use client';

import { motion } from 'framer-motion';
import AnimatedNumber from './AnimatedNumber';

interface UsageMeterProps {
  used: number;
  limit: number;
  label?: string;
}

export default function UsageMeter({ used, limit, label = 'API Credits' }: UsageMeterProps) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const barColor = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-brand';
  const pctColor = pct >= 90 ? 'text-red-600' : pct >= 70 ? 'text-amber-600' : 'text-brand';

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">{label}</span>
        <span className="font-mono text-sm text-slate-500">
          <AnimatedNumber value={used} className="text-slate-900 font-semibold" />
          <span className="text-slate-400"> / {limit.toLocaleString()}</span>
          <span className={`ml-2 font-semibold ${pctColor}`}>{pct}%</span>
        </span>
      </div>

      <div className="relative h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
          className={`h-full rounded-full ${barColor}`}
        />
      </div>
    </div>
  );
}
