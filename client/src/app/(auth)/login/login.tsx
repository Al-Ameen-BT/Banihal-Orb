'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { useAuth } from '@/contexts/AuthContext';
import { LoginSchema } from '@/lib/schemas';
import GlowButton from '@/components/ui/GlowButton';
import AmbientBackdrop from '@/components/ui/AmbientBackdrop';

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

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    setServerError('');

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
      await login(result.data.email, result.data.password);
      router.push('/dashboard');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Authentication failed';
      setServerError(msg);
    } finally {
      setLoading(false);
    }
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
          <h1 className="text-2xl font-bold text-slate-900 text-slate-900 mb-1 tracking-tight">Welcome back</h1>
          <p className="text-sm text-slate-500">Sign in to your console</p>
        </div>

        {/* Card */ }
        <div className="card p-6">
          <form onSubmit={handleSubmit} className="space-y-5">
            <Suspense>
              <RegistrationSuccessBanner />
            </Suspense>

            {serverError && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2.5 px-3.5 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                </svg>
                {serverError}
              </motion.div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1.5">Email</label>
              <input id="email" name="email" type="email" autoComplete="email" className="input" placeholder="you@company.com" />
              {errors['email'] && <p className="mt-1.5 text-xs text-red-600">{errors['email']}</p>}
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1.5">Password</label>
              <input id="password" name="password" type="password" autoComplete="current-password" className="input" placeholder="••••••••••••" />
              {errors['password'] && <p className="mt-1.5 text-xs text-red-600">{errors['password']}</p>}
            </div>

            <GlowButton type="submit" loading={loading} className="w-full">
              {loading ? 'Signing in…' : 'Sign in'}
            </GlowButton>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-slate-500">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="font-semibold text-brand hover:text-brand-700 transition-colors">
            Create an Account
          </Link>
        </p>
      </motion.div >
    </div >
  );
}
