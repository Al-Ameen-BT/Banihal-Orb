'use client';

import { useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { authApi } from '@/lib/api';
import GlowButton from '@/components/ui/GlowButton';
import AmbientBackdrop from '@/components/ui/AmbientBackdrop';
import { z } from 'zod';
import BrandLogo from '@/components/ui/BrandLogo';

const ForgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');

    const result = ForgotPasswordSchema.safeParse({ email });
    if (!result.success) {
      setError(result.error.errors[0].message);
      return;
    }

    setLoading(true);
    try {
      await authApi.forgotPassword({ email: result.data.email });
      setSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.error || 'An error occurred. Please try again.');
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
        <div className="mb-8 text-center">
          <div className="flex justify-center mb-6">
            <BrandLogo height={48} />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-1 tracking-tight">Reset password</h1>
          <p className="text-sm text-slate-500">Enter your email to receive a reset link</p>
        </div>

        <div className="card p-6">
          {success ? (
            <div className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 mb-4">
                <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <h3 className="text-sm font-medium text-slate-900 mb-2">Check your email</h3>
              <p className="text-sm text-slate-500 mb-6">
                If an account exists for {email}, we&apos;ve sent a password reset link. The link expires in 1 hour — check your inbox and spam folder.
              </p>
              <Link href="/login" className="text-sm font-semibold text-brand hover:underline">
                Return to sign in
              </Link>
            </div>
          ) : (
            <form method="post" onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2.5 px-3.5 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"
                >
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                  {error}
                </motion.div>
              )}

              <div>
                <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1.5">Email address</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input"
                  placeholder="you@company.com"
                />
              </div>

              <GlowButton type="submit" loading={loading} className="w-full">
                {loading ? 'Sending link…' : 'Send reset link'}
              </GlowButton>
            </form>
          )}
        </div>

        {!success && (
          <p className="mt-6 text-center text-sm text-slate-500">
            Remember your password?{' '}
            <Link href="/login" className="font-semibold text-brand hover:text-brand-700 transition-colors">
              Sign in
            </Link>
          </p>
        )}
      </motion.div>
    </div>
  );
}
