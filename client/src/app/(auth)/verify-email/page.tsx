'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { authApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import GlowButton from '@/components/ui/GlowButton';
import AmbientBackdrop from '@/components/ui/AmbientBackdrop';
import BrandLogo from '@/components/ui/BrandLogo';

type Phase = 'working' | 'done' | 'approval' | 'failed';
const errMsg = (err: unknown, fallback: string): string =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

// The approval challenge the server hands back for a pending organization. There is
// no code field here by design — the code reaches the org admin from a person, not
// from this response.
type Approval = { challengeId: string; expiresAt: string; organizationName: string };

/** mm:ss — the approval window is minutes long, so bare seconds would read badly. */
const clock = (secs: number): string =>
  `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

const secondsUntil = (iso: string): number =>
  Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));

function VerifyEmail() {
  const router = useRouter();
  const { refresh } = useAuth();
  const token = useSearchParams().get('token');

  const [phase, setPhase] = useState<Phase>(token ? 'working' : 'failed');
  const [message, setMessage] = useState(token ? '' : 'This confirmation link is missing its token.');
  const [resendTo, setResendTo] = useState('');
  const [resending, setResending] = useState(false);
  const [resendNote, setResendNote] = useState('');

  // Approval step state.
  const [approval, setApproval] = useState<Approval | null>(null);
  const [code, setCode] = useState('');
  const [remaining, setRemaining] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const [approvalNote, setApprovalNote] = useState('');

  // React 18 StrictMode mounts effects twice in development. The second call
  // would redeem an already-burned token and report failure over a success, so
  // the request is fired at most once per token.
  const redeemed = useRef(false);

  useEffect(() => {
    if (!token || redeemed.current) return;
    redeemed.current = true;
    authApi.verifyEmail({ token })
      .then(({ data }) => {
        const next = (data as { approval?: Approval }).approval;
        if (next) {
          // Organization still pending: stay here for the code rather than sending
          // them to a login they cannot complete.
          setApproval(next);
          setRemaining(secondsUntil(next.expiresAt));
          setPhase('approval');
          return;
        }
        setPhase('done');
        setTimeout(() => router.push('/login?verified=1'), 2500);
      })
      .catch((err) => {
        setPhase('failed');
        setMessage(errMsg(err, 'This confirmation link is invalid or has expired.'));
      });
  }, [token, router]);

  // Expiry countdown. Recomputed from the server's timestamp rather than
  // decremented blindly, so a backgrounded tab (where timers are throttled) does
  // not show time the code no longer has.
  useEffect(() => {
    if (phase !== 'approval' || !approval) return;
    const t = setInterval(() => setRemaining(secondsUntil(approval.expiresAt)), 1000);
    return () => clearInterval(t);
  }, [phase, approval]);

  // Resend cooldown, seeded from the server's retryAfter when it rejects one.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => (c <= 1 ? 0 : c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  async function submitApproval(e: React.FormEvent) {
    e.preventDefault();
    if (!approval) return;
    setVerifying(true); setApprovalError(''); setApprovalNote('');
    try {
      await authApi.verifyOrgApproval({ challengeId: approval.challengeId, code });
      // Cookies are set by that call, so load the user before navigating —
      // otherwise the dashboard mounts against an empty auth context and bounces.
      await refresh();
      router.replace('/dashboard');
    } catch (err) {
      setCode('');
      setApprovalError(errMsg(err, 'That code was not accepted.'));
      setRemaining(secondsUntil(approval.expiresAt));
    } finally {
      setVerifying(false);
    }
  }

  async function requestNewCode() {
    if (!approval) return;
    setVerifying(true); setApprovalError(''); setApprovalNote('');
    try {
      const { data } = await authApi.resendOrgApproval({ challengeId: approval.challengeId });
      // Re-issuing returns a NEW challenge id — the row is keyed by organization.
      const next = data as { challengeId: string; expiresAt: string };
      setApproval({ ...approval, challengeId: next.challengeId, expiresAt: next.expiresAt });
      setRemaining(secondsUntil(next.expiresAt));
      setCode('');
      setApprovalNote('A new code is on its way to the platform team.');
    } catch (err) {
      const resp = (err as { response?: { data?: { error?: string; retryAfter?: number } } })?.response?.data;
      if (resp?.retryAfter) setCooldown(resp.retryAfter);
      setApprovalError(resp?.error ?? 'Could not request a new code.');
    } finally {
      setVerifying(false);
    }
  }

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

  if (phase === 'approval' && approval) {
    const expired = remaining <= 0;
    return (
      <div className="card p-6">
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 mb-4">
            <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <h3 className="text-sm font-medium text-slate-900 mb-1">Email confirmed</h3>
          <p className="text-sm text-slate-500">
            <span className="font-semibold text-slate-700">{approval.organizationName}</span> now needs approval
            from our platform team.
          </p>
        </div>

        <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3">
          <p className="text-[13px] leading-relaxed text-slate-600">
            A one-time approval code has been sent to our administration team. Contact them to
            receive it, then enter it below to activate your organization.
          </p>
        </div>

        <form onSubmit={submitApproval} className="mt-5 space-y-4">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <label htmlFor="approval-code" className="block text-sm font-medium text-slate-700">Approval code</label>
              <span className={`font-mono text-xs tabular-nums ${expired ? 'text-red-600 font-semibold' : remaining <= 60 ? 'text-amber-600' : 'text-slate-400'}`}>
                {expired ? 'expired' : clock(remaining)}
              </span>
            </div>
            <input
              id="approval-code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
              value={code} disabled={expired}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="input text-center text-2xl font-mono font-bold tracking-[0.5em] tabular-nums disabled:opacity-50"
              placeholder="••••••"
            />
          </div>

          {approvalError && <p className="text-sm text-red-600">{approvalError}</p>}
          {approvalNote && <p className="text-sm text-brand">{approvalNote}</p>}

          <GlowButton type="submit" loading={verifying} disabled={code.length !== 6 || verifying || expired} className="w-full">
            {verifying ? 'Verifying…' : 'Verify & continue'}
          </GlowButton>

          <div className="flex items-center justify-between text-sm">
            <Link href="/login" className="font-medium text-slate-500 hover:text-slate-700">← Back to sign in</Link>
            <button
              type="button" onClick={() => void requestNewCode()} disabled={cooldown > 0 || verifying}
              className={`font-medium cursor-pointer ${cooldown > 0 || verifying ? 'text-slate-400 cursor-not-allowed' : 'text-brand hover:text-brand-700'}`}
            >
              {cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}
            </button>
          </div>
        </form>

        <p className="mt-5 border-t border-slate-100 pt-4 text-xs leading-relaxed text-slate-400">
          Our team will never ask you to share this code with anyone else, and will only ever
          give it to you directly.
        </p>
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
