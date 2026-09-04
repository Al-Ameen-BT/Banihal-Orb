'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { authApi } from '@/lib/api';
import GlowButton from '@/components/ui/GlowButton';
import AmbientBackdrop from '@/components/ui/AmbientBackdrop';
import BrandLogo from '@/components/ui/BrandLogo';

type Phase = 'working' | 'done' | 'failed';
const errMsg = (err: unknown, fallback: string): string =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

function VerifyEmail() {
  const router = useRouter();
  const token = useSearchParams().get('token');

  const [phase, setPhase] = useState<Phase>(token ? 'working' : 'failed');
  const [message, setMessage] = useState(token ? '' : 'This confirmation link is missing its token.');
  const [resendTo, setResendTo] = useState('');
  const [resending, setResending] = useState(false);
  const [resendNote, setResendNote] = useState('');

  // React 18 StrictMode mounts effects twice in development. The second call
  // would redeem an already-burned token and report failure over a success, so
  // the request is fired at most once per token.
  const redeemed = useRef(false);

  useEffect(() => {
    if (!token || redeemed.current) return;
    redeemed.current = true;
    authApi.verifyEmail({ token })
      .then(() => {
        setPhase('done');
        setTimeout(() => router.push('/login?verified=1'), 2500);
      })
      .catch((err) => {
        setPhase('failed');
        setMessage(errMsg(err, 'This confirmation link is invalid or has expired.'));
      });
  }, [token, router]);

  async function resend(e: React.FormEvent) {
    e.preventDefault();
    setResending(true);
    setResendNote('');
    try {
      const { data } = await authApi.resendVerification({ email: resendTo.trim() });
      setResendNote((data as { message?: string }).message ?? 'If that address needs confirming, a new link is on its way.');
    } catch (err) {
      setResendNote(errMsg(err, 'Could not send a new link. Please try again shortly.'));
    } finally {
      setResending(false);
    }
  }

  if (phase === 'working') {
    return <div className="card p-6 text-center text-sm text-slate-500">Confirming your email address…</div>;
  }

  if (phase === 'done') {
    return (
      <div className="card p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 mb-4">
          <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <h3 className="text-sm font-medium text-slate-900 mb-2">Email confirmed</h3>
        <p className="text-sm text-slate-500 mb-6">Your address is verified. Taking you to the sign-in page.</p>
        <Link href="/login" className="text-sm font-semibold text-brand hover:underline">Click here if not redirected</Link>
      </div>
    );
  }

  // Failed — offer a fresh link, since an expired one is the common case.
  return (
    <div className="card p-6">
      <div className="text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100 mb-4">
          <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h3 className="text-sm font-medium text-slate-900 mb-2">Could not confirm this link</h3>
        <p className="text-sm text-slate-500 mb-6">{message}</p>
      </div>

      <form onSubmit={resend} className="space-y-3 border-t border-slate-100 pt-5">
        <label htmlFor="resend-email" className="block text-sm font-medium text-slate-700">
          Send a new confirmation link
        </label>
        <input
          id="resend-email" type="email" required value={resendTo}
          onChange={(e) => setResendTo(e.target.value)}
          className="input" placeholder="you@company.com"
        />
        <GlowButton type="submit" loading={resending} disabled={resending} className="w-full">
          {resending ? 'Sending…' : 'Send new link'}
        </GlowButton>
        {resendNote && <p className="text-xs text-slate-500">{resendNote}</p>}
      </form>

      <p className="mt-5 text-center text-sm text-slate-500">
        <Link href="/login" className="font-semibold text-brand hover:underline">Back to sign in</Link>
      </p>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <AmbientBackdrop />
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
        className="w-full max-w-[380px]"
      >
        <div className="mb-8 text-center">
          <div className="flex justify-center mb-6"><BrandLogo height={48} /></div>
          <h1 className="text-2xl font-bold text-slate-900 mb-1 tracking-tight">Confirm your email</h1>
          <p className="text-sm text-slate-500">One step to activate your account.</p>
        </div>

        <Suspense fallback={<div className="card p-6 text-center text-sm text-slate-500">Loading…</div>}>
          <VerifyEmail />
        </Suspense>
      </motion.div>
    </div>
  );
}
