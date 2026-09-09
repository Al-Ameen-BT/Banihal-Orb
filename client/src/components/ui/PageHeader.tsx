'use client';

import { motion } from 'framer-motion';

// The one page header for every app page: eyebrow · title · subtitle beside an
// optional icon tile, with room for actions on the right. `icon` takes either a
// bare SVG path string (the Sidebar's `icons` map) or a ready-made node.
export function PageHeader({ eyebrow, title, subtitle, icon, actions }: {
  eyebrow: React.ReactNode; title: React.ReactNode; subtitle?: React.ReactNode;
  icon?: React.ReactNode | string; actions?: React.ReactNode;
}) {
  return (
    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
      className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div className="flex items-start gap-3.5">
        {icon && (
          <div className="hidden sm:flex w-11 h-11 rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 ring-1 ring-brand-200/70 items-center justify-center flex-shrink-0 text-brand">
            {typeof icon === 'string'
              ? <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d={icon} />
                </svg>
              : icon}
          </div>
        )}
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="text-[1.6rem] font-bold tracking-tight text-slate-900 leading-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500 max-w-xl">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex-shrink-0">{actions}</div>}
    </motion.div>
  );
}
