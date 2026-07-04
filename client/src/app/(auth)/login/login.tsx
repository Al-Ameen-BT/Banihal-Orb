'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { useAuth } from '@/contexts/AuthContext';
import { LoginSchema } from '@/lib/schemas';
import GlowButton from '@/components/ui/GlowButton';
import AmbientBackdrop from '@/components/ui/AmbientBackdrop';

const RESEND_COOLDOWN = 30;

function RegistrationSuccessBanner() {
  const searchParams = useSearchParams();
  if (searchParams.get('registered') !== '1') return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-2.5 px-3.5 py-2.5 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700"
    >
      <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
      Account created successfully! Sign in with your new credentials.
    </motion.div>
  );
}

type ErrResp = { error?: string; code?: string; retryAfter?: number; remaining?: number };
const errData = (err: unknown): ErrResp => (err as { response?: { data?: ErrResp } })?.response?.data ?? {};

export default function LoginPage() {
  const { login, verifyMfa, resendMfa } = useAuth();
  const router = useRouter();

  const [phase, setPhase] = useState<'credentials' | 'code'>('credentials');
  const [challengeId, setChallengeId] = useState('');
  const [maskedEmail, setMaskedEmail] = useState('');
  const [code, setCode] = useState('');
  const [rememberDevice, setRememberDevice] = useState(false);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState('');
  const [sessionNotice, setSessionNotice] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  // Resend cooldown countdown.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => (c <= 1 ? 0 : c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  async function handleCredentials(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({}); setServerError(''); setSessionNotice('');

    const fd = new FormData(e.currentTarget);
    const data = { email: fd.get('email') as string, password: fd.get('password') as string };

    const result = LoginSchema.safeParse(data);
    if (!result.success) {
      const flat = result.error.flatten().fieldErrors;
      setErrors(Object.fromEntries(Object.entries(flat).map(([k, v]) => [k, v?.[0] ?? ''])));
      return;
    }

    setLoading(true);
    try {
      const outcome = await login(result.data.email, result.data.password);
      if (!outcome.mfaRequired) {
        // Trusted device — the session is already established, no email code.
        router.push('/dashboard');
        return;
      }
      setChallengeId(outcome.challengeId);
      setMaskedEmail(outcome.email);
      setCode('');
      setInfo(`We sent a 6-digit verification code to ${outcome.email}.`);
      setCooldown(RESEND_COOLDOWN);
      setPhase('code');
    } catch (err: unknown) {
      const resp = errData(err);
      const msg = resp.error ?? 'Authentication failed';
      if (resp.code === 'SESSION_ACTIVE') setSessionNotice(msg);
      else setServerError(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setServerError('');
    if (!/^\d{6}$/.test(code)) { setServerError('Enter the 6-digit code from your email.'); return; }

    setLoading(true);
    try {
      await verifyMfa(challengeId, code, rememberDevice);
      router.push('/dashboard');
    } catch (err: unknown) {
      const resp = errData(err);
      setServerError(resp.error ?? 'Verification failed');
      // A burned or expired challenge can't be retried — restart from credentials.
      if (resp.code === 'MFA_CHALLENGE_INVALID' || resp.code === 'MFA_TOO_MANY_ATTEMPTS') {
        setPhase('credentials'); setCode(''); setInfo(''); setCooldown(0);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (cooldown > 0 || loading) return;
    setServerError(''); setInfo('');
    setLoading(true);
    try {
      const email = await resendMfa(challengeId);
      setMaskedEmail(email);
      setInfo(`A new code was sent to ${email}.`);
      setCooldown(RESEND_COOLDOWN);
    } catch (err: unknown) {
      const resp = errData(err);
      setServerError(resp.error ?? 'Could not resend the code.');
      if (resp.code === 'MFA_RESEND_COOLDOWN' && resp.retryAfter) setCooldown(resp.retryAfter);
      if (resp.code === 'MFA_CHALLENGE_INVALID') { setPhase('credentials'); setCode(''); setInfo(''); }
    } finally {
      setLoading(false);
    }
  }

  function backToCredentials() {
    setPhase('credentials'); setCode(''); setServerError(''); setInfo(''); setCooldown(0);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <AmbientBackdrop />
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
        className="w-full max-w-[380px]"
      >
        {/* Brand */}
        <div className="mb-8 text-center">
          <div className="flex justify-center mb-6">
            <img src="/banihal-logo.png" alt="Banihal Logo" className="max-h-12 w-auto object-contain" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-1 tracking-tight">
            {phase === 'credentials' ? 'Welcome back' : 'Check your email'}
          </h1>
          <p className="text-sm text-slate-500">
            {phase === 'credentials' ? 'Sign in to your console' : `Enter the code we sent to ${maskedEmail}`}
          </p>
        </div>

        <div className="card p-6">
          {/* Shared alerts */}
          {serverError && (
            <motion.div
              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-2.5 px-3.5 py-2.5 mb-5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              {serverError}
            </motion.div>
          )}
          {sessionNotice && (
            <motion.div
              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
              className="flex items-start gap-2.5 px-3.5 py-2.5 mb-5 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800"
            >
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
              </svg>
              <span>{sessionNotice}</span>
            </motion.div>
          )}

          {phase === 'credentials' ? (
            <form onSubmit={handleCredentials} className="space-y-5">
              <Suspense>
                <RegistrationSuccessBanner />
              </Suspense>

              <div>
                <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1.5">Email</label>
                <input id="email" name="email" type="email" autoComplete="email" className="input" placeholder="you@company.com" />
                {errors['email'] && <p className="mt-1.5 text-xs text-red-600">{errors['email']}</p>}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="password" className="block text-sm font-medium text-slate-700">Password</label>
                  <Link href="/forgot-password" className="text-sm font-medium text-brand hover:underline">Forgot password?</Link>
                </div>
                <input id="password" name="password" type="password" autoComplete="current-password" className="input" placeholder="••••••••••••" />
                {errors['password'] && <p className="mt-1.5 text-xs text-red-600">{errors['password']}</p>}
              </div>

              <GlowButton type="submit" loading={loading} className="w-full">
                {loading ? 'Signing in…' : 'Sign in'}
              </GlowButton>
            </form>
          ) : (
            <form onSubmit={handleVerify} className="space-y-5">
              {info && (
                <div className="flex items-start gap-2.5 px-3.5 py-2.5 bg-brand-50 border border-brand-200 rounded-lg text-sm text-brand-700">
                  <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" />
                  </svg>
                  <span>{info}</span>
                </div>
              )}

              <div>
                <label htmlFor="code" className="block text-sm font-medium text-slate-700 mb-1.5">Verification code</label>
                <input
                  id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="input text-center text-2xl font-mono font-bold tracking-[0.5em] tabular-nums"
                  placeholder="••••••"
                />
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox" checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-brand focus:ring-2 focus:ring-brand/40 cursor-pointer"
                />
                <span className="text-sm text-slate-600">Remember this device for 7 days</span>
              </label>

              <GlowButton type="submit" loading={loading} disabled={code.length !== 6} className="w-full">
                {loading ? 'Verifying…' : 'Verify & sign in'}
              </GlowButton>

              <div className="flex items-center justify-between text-sm">
                <button type="button" onClick={backToCredentials} className="font-medium text-slate-500 hover:text-slate-700 cursor-pointer">
                  ← Back
                </button>
                <button
                  type="button" onClick={handleResend} disabled={cooldown > 0 || loading}
                  className={`font-medium cursor-pointer ${cooldown > 0 ? 'text-slate-400 cursor-not-allowed' : 'text-brand hover:text-brand-700'}`}
                >
                  {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
                </button>
              </div>
            </form>
          )}
        </div>

        {phase === 'credentials' && (
          <p className="mt-6 text-center text-sm text-slate-500">
            Don&apos;t have an account?{' '}
            <Link href="/register" className="font-semibold text-brand hover:text-brand-700 transition-colors">
              Create an Account
            </Link>
          </p>
        )}

        <p className="mt-4 text-center text-xs text-slate-400 leading-relaxed">
          By continuing you agree to our{' '}
          <Link href="/terms" className="font-medium text-slate-500 hover:text-brand transition-colors">Terms</Link>{' '}and{' '}
          <Link href="/privacy" className="font-medium text-slate-500 hover:text-brand transition-colors">Privacy Policy</Link>.
        </p>
      </motion.div>
    </div>
  );
}
