'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';

export default function CookieBanner() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Check if the user has already consented
    const consent = localStorage.getItem('cookieConsent');
    if (!consent) {
      // Small delay for better UX
      const timer = setTimeout(() => setIsVisible(true), 1000);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleAccept = () => {
    localStorage.setItem('cookieConsent', 'accepted');
    setIsVisible(false);
    // Here you would typically initialize analytics/tracking
  };

  const handleDecline = () => {
    localStorage.setItem('cookieConsent', 'declined');
    setIsVisible(false);
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className="fixed bottom-0 left-0 right-0 z-50 p-4 pointer-events-none sm:p-6"
        >
          <div className="mx-auto max-w-7xl pointer-events-auto">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-6 bg-white/90 backdrop-blur-md border border-slate-200/50 shadow-2xl rounded-2xl">
              <div className="flex-1 text-sm text-slate-600">
                <p>
                  We use cookies to enhance your browsing experience, serve personalized ads or content, and analyze our traffic. 
                  By clicking &quot;Accept All&quot;, you consent to our use of cookies. Read our{' '}
                  <Link href="/privacy-policy" className="font-semibold text-brand hover:underline">
                    Privacy Policy
                  </Link>
                  {' '}for more information.
                </p>
              </div>
              <div className="flex items-center gap-3 w-full sm:w-auto">
                <button
                  onClick={handleDecline}
                  className="flex-1 sm:flex-none px-4 py-2.5 text-sm font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap"
                >
                  Decline Optional
                </button>
                <button
                  onClick={handleAccept}
                  className="flex-1 sm:flex-none px-4 py-2.5 text-sm font-semibold text-white bg-brand border border-brand hover:bg-brand-600 rounded-lg transition-colors whitespace-nowrap shadow-sm shadow-brand/20"
                >
                  Accept All
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
