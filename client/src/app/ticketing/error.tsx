'use client';

// Segment-level boundary for /ticketing.
//
// Without this, any render-time throw in the ticketing tree escapes to the app
// boundary (src/app/error.tsx), which replaces the ENTIRE page — sidebar and all —
// with a full-screen "Something Went Wrong" card and sends the user back to the
// dashboard. One malformed ticket should not cost the whole console.
//
// Scoped here rather than nested deeper because the tabs are a single client
// component, not separate route segments; this is the closest boundary the App
// Router can give the ticketing views.

import { useEffect } from 'react';
import GlowButton from '@/components/ui/GlowButton';

export default function TicketingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Ticketing]', error);
  }, [error]);

  return (
    <div className="p-6 sm:p-8 max-w-[1600px] mx-auto">
      <div className="card p-10 text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 ring-1 ring-inset ring-amber-500/15">
          <svg className="h-6 w-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        </div>

        <h2 className="text-base font-bold text-slate-900">Ticketing could not be displayed</h2>
        <p className="mx-auto mt-2 max-w-[420px] text-sm text-slate-500">
          Something went wrong rendering this view. Your tickets are unaffected — this is a
          display problem only.
        </p>

        {error.digest && (
          <p className="mt-4 font-mono text-[10px] text-slate-400">digest: {error.digest}</p>
        )}

        <div className="mt-6 flex items-center justify-center gap-2">
          <GlowButton className="py-1.5 px-4 text-xs" onClick={reset}>Try again</GlowButton>
          <GlowButton variant="secondary" className="py-1.5 px-4 text-xs" onClick={() => window.location.reload()}>
            Reload page
          </GlowButton>
        </div>
      </div>
    </div>
  );
}
