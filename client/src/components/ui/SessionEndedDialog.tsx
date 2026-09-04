'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { setSessionEndedHandler } from '@/lib/session-bus';
import GlowButton from '@/components/ui/GlowButton';

// Shown when the server reports SESSION_REVOKED — most often because an
// administrator changed this account's platform role, which ends the session so
// the new permissions apply immediately instead of after the old token expires.
//
// The wording deliberately covers every cause. A 401 cannot tell us which one it
// was: a password reset and a sign-in on another device revoke through the same
// path, so naming the role change specifically would be wrong some of the time.
export default function SessionEndedProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setSessionEndedHandler(() => setOpen(true));
    return () => setSessionEndedHandler(null);
  }, []);

  // Full reload rather than a router push: every cached query and the AuthContext
  // snapshot belong to the ended session and must not survive into the next one.
  const signIn = useCallback(() => {
    window.location.href = '/login?reason=session-ended';
  }, []);

  return (
    <>
      {children}
      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="alertdialog" aria-modal="true" aria-labelledby="session-ended-title">
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.18 }}
              className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="px-6 pt-6 pb-4 flex items-start gap-4">
                <div className="w-11 h-11 rounded-full bg-amber-50 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 9v3.75m0 3.75h.008M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 id="session-ended-title" className="text-base font-semibold text-slate-900">Your session has ended</h3>
                  <p className="mt-1.5 text-sm text-slate-500 leading-relaxed">
                    Your account was updated, so you&apos;ll need to sign in again to continue. Any unsaved changes on this page will be lost.
                  </p>
                </div>
              </div>
              <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex justify-end">
                <GlowButton onClick={signIn} autoFocus>Sign in again</GlowButton>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
