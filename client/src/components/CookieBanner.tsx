'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';

export type CookieConsent = 'accepted' | 'rejected';
const STORAGE_KEY = 'cookieConsent';

/** Read the stored consent choice (null = not decided yet). Usable elsewhere,
 *  e.g. to gate analytics: `if (getCookieConsent() === 'accepted') { … }`. */
export function getCookieConsent(): CookieConsent | null {
  if (typeof window === 'undefined') return null;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === 'accepted' || v === 'rejected' ? v : null;
}

export default function CookieBanner() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Only prompt when the user hasn't recorded a decision yet. A prior
    // Accept/Reject is remembered; a "Cancel" leaves it undecided so it returns.
    if (!getCookieConsent()) {
      const timer = setTimeout(() => setIsVisible(true), 1000);
      return () => clearTimeout(timer);
    }
  }, []);

  // Persist the decision, hide the banner, and broadcast it so non-essential
  // scripts (analytics/ads) can enable themselves on 'accepted' or stay off.
  const decide = (value: CookieConsent) => {
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* storage disabled */ }
    setIsVisible(false);
    window.dispatchEvent(new CustomEvent('cookieconsentchange', { detail: value }));
  };

  const handleAccept = () => decide('accepted');
  const handleReject = () => decide('rejected');
  // Cancel: dismiss for now WITHOUT storing a choice — the banner reappears on
  // the next visit until the user explicitly accepts or rejects.
  const handleCancel = () => setIsVisible(false);

  return (
    <AnimatePresence>
      {isVisible && (
        // role="region", not "dialog": this traps no focus and the page stays usable, so it
        // isn't a modal. `dialog` also collided with generic [role="dialog"] queries (a11y
        // tooling / e2e selectors) that target the app's real modals.
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          role="region"
          aria-label="Cookie consent"
          className="fixed bottom-0 left-0 right-0 z-50 p-4 pointer-events-none sm:p-6"
        >
          {/* pointer-events-auto lives on the CARD only — the full-width wrapper must stay
              click-through so it doesn't swallow taps on UI beneath it (e.g. the chat input bar). */}
          <div className="mx-auto max-w-7xl">
            <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6 pr-10 bg-white/90 backdrop-blur-md border border-slate-200/50 shadow-2xl rounded-2xl pointer-events-auto">
              {/* Cancel via the corner ✕ as well, for quick dismissal */}
              <button
                onClick={handleCancel}
                aria-label="Cancel"
                className="absolute top-3 right-3 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>

              <div className="flex-1 text-sm text-slate-600">
                <p>
                  We use cookies to keep you signed in, enhance your experience, and analyze traffic.
                  Strictly necessary cookies are always on. Choose <span className="font-semibold text-slate-700">Accept</span> to
                  allow optional cookies, or <span className="font-semibold text-slate-700">Reject</span> to keep only the essential ones. Read our{' '}
                  <Link href="/privacy" className="font-semibold text-brand hover:underline">
                    Privacy Policy
                  </Link>
                  {' '}for details.
                </p>
              </div>

              <div className="flex items-center gap-2.5 w-full sm:w-auto">
                <button
                  onClick={handleCancel}
                  className="flex-1 sm:flex-none px-3.5 py-2.5 text-sm font-semibold text-slate-500 hover:text-slate-700 transition-colors whitespace-nowrap cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleReject}
                  className="flex-1 sm:flex-none px-4 py-2.5 text-sm font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap cursor-pointer"
                >
                  Reject
                </button>
                <button
                  onClick={handleAccept}
                  className="flex-1 sm:flex-none px-4 py-2.5 text-sm font-semibold text-white bg-brand border border-brand hover:bg-brand-600 rounded-lg transition-colors whitespace-nowrap shadow-sm shadow-brand/20 cursor-pointer"
                >
                  Accept
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
