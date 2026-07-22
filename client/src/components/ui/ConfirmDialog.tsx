'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import clsx from 'clsx';

// ─── Reusable confirmation dialog ─────────────────────────────────────────────
// Replaces native window.confirm() with an on-brand, accessible modal. Usage:
//
//   const confirm = useConfirm();
//   if (await confirm({ title: 'Delete project', message: '…', variant: 'danger',
//                       confirmText: 'Delete' })) mutation.mutate();
//
// The promise resolves true (confirmed) or false (cancelled / dismissed).

type ConfirmVariant = 'default' | 'danger';

export interface ConfirmOptions {
  title: string;
  message?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: ConfirmVariant;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return ctx;
}

const DangerIcon = () => (
  <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
      d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
  </svg>
);
const QuestionIcon = () => (
  <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
      d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
  </svg>
);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();

  const confirm = useCallback<ConfirmFn>((opts) => {
    setOptions(opts);
    return new Promise<boolean>((resolve) => { resolverRef.current = resolve; });
  }, []);

  const close = useCallback((result: boolean) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  const open = options !== null;
  const isDanger = options?.variant === 'danger';

  // Focus management, Escape to cancel, a two-button focus trap, and scroll lock.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Focus Cancel on destructive prompts (safer default), Confirm otherwise.
    const focusTimer = window.setTimeout(() => {
      (isDanger ? cancelBtnRef : confirmBtnRef).current?.focus();
    }, 20);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key === 'Tab') {
        const els = [cancelBtnRef.current, confirmBtnRef.current].filter(Boolean) as HTMLElement[];
        if (els.length < 2) return;
        e.preventDefault();
        const idx = els.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey
          ? (idx <= 0 ? els.length - 1 : idx - 1)
          : (idx >= els.length - 1 ? 0 : idx + 1);
        els[next].focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(focusTimer);
    };
  }, [open, isDanger, close]);

  const btnBase =
    'inline-flex flex-1 items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold ' +
    'transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-offset-2 focus-visible:ring-offset-white';

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AnimatePresence>
        {open && options && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.15 }}
          >
            <div
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
              onClick={() => close(false)}
              aria-hidden="true"
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
              aria-describedby={options.message ? 'confirm-desc' : undefined}
              initial={{ opacity: 0, scale: reduce ? 1 : 0.96, y: reduce ? 0 : 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: reduce ? 1 : 0.98, y: reduce ? 0 : 4 }}
              transition={{ duration: reduce ? 0 : 0.18, ease: [0.4, 0, 0.2, 1] }}
              className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl ring-1 ring-slate-900/5"
            >
              <div className={clsx(
                'mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full',
                isDanger ? 'bg-red-50 text-red-600' : 'bg-brand-50 text-brand',
              )}>
                {isDanger ? <DangerIcon /> : <QuestionIcon />}
              </div>

              <h2 id="confirm-title" className="text-center text-lg font-semibold tracking-tight text-slate-900">
                {options.title}
              </h2>
              {options.message && (
                <div id="confirm-desc" className="mx-auto mt-1.5 max-w-sm text-center text-sm leading-relaxed text-slate-600">
                  {options.message}
                </div>
              )}

              <div className="mt-6 flex gap-3">
                <button
                  ref={cancelBtnRef}
                  type="button"
                  onClick={() => close(false)}
                  className={clsx(btnBase,
                    'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 focus-visible:ring-slate-400/50')}
                >
                  {options.cancelText ?? 'Cancel'}
                </button>
                <button
                  ref={confirmBtnRef}
                  type="button"
                  onClick={() => close(true)}
                  className={clsx(btnBase, 'text-white',
                    isDanger
                      ? 'bg-red-600 hover:bg-red-700 focus-visible:ring-red-500/50'
                      : 'bg-brand hover:bg-brand-700 focus-visible:ring-brand/50')}
                >
                  {options.confirmText ?? 'Confirm'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ConfirmContext.Provider>
  );
}
