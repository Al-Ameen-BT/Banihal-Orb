'use client';

import { motion } from 'framer-motion';

interface ToggleProps {
  enabled: boolean;
  onChange: (val: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}

export default function Toggle({ enabled, onChange, label, description, disabled }: ToggleProps) {
  return (
    <div className="flex items-center justify-between py-4">
      <div className="pr-4">
        <p className="text-sm font-medium text-slate-900">{label}</p>
        {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!enabled)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors duration-200 cursor-pointer
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2
          disabled:opacity-50 disabled:cursor-not-allowed
          ${enabled ? 'bg-brand' : 'bg-slate-200'}`}
        aria-pressed={enabled}
        aria-label={label}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
          className="inline-block h-4 w-4 rounded-full bg-white shadow-sm"
          style={{ marginLeft: enabled ? '22px' : '4px' }}
        />
      </button>
    </div>
  );
}
