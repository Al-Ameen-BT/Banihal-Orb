'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { authApi } from '@/lib/api';
import GlowButton from '@/components/ui/GlowButton';
import AmbientBackdrop from '@/components/ui/AmbientBackdrop';
import { z } from 'zod';
import BrandLogo from '@/components/ui/BrandLogo';

const ResetPasswordSchema = z.object({
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/,
      'Must include uppercase, lowercase, number, and special character',
    ),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState('');
  const [success, setSuccess] = useState(false);

  if (!token) {
    return (
      <div className="card p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100 mb-4">
          <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h3 className="text-sm font-medium text-slate-900 mb-2">Invalid or missing token</h3>
        <p className="text-sm text-slate-500 mb-6">
          Please request a new password reset link.
        </p>
        <Link href="/forgot-password" className="text-sm font-semibold text-brand hover:underline">
          Go to Forgot Password
        </Link>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    setServerError('');

    const result = ResetPasswordSchema.safeParse({ password, confirmPassword });
    if (!result.success) {
      const flat = result.error.flatten().fieldErrors;
      setErrors(Object.fromEntries(Object.entries(flat).map(([k, v]) => [k, v?.[0] ?? ''])));
      return;
    }

    setLoading(true);
    try {
      await authApi.resetPassword({ token: token!, newPassword: password });
      setSuccess(true);
      setTimeout(() => {
        router.push('/login');
      }, 3000);
    } catch (err: any) {
      setServerError(err.response?.data?.error || 'An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="card p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 mb-4">
          <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </div>
        <h3 className="text-sm font-medium text-slate-900 mb-2">Password reset successfully</h3>
        <p className="text-sm text-slate-500 mb-6">
          Your password has been changed. You are being redirected to the login page.
        </p>
        <Link href="/login" className="text-sm font-semibold text-brand hover:underline">
          Click here if not redirected
        </Link>
      </div>
    );
  }

  return (
    <div className="card p-6">
      {/* method="post": a pre-hydration native submit must not put the new password in the URL. */}
      <form method="post" onSubmit={handleSubmit} className="space-y-5">
        {serverError && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2.5 px-3.5 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            {serverError}
          </motion.div>
        )}

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1.5">New Password</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
            placeholder="Min. 12 chars, upper, lower, number, symbol"
          />
          {errors['password'] && <p className="mt-1.5 text-xs text-red-600">{errors['password']}</p>}
        </div>

        <div>
          <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-700 mb-1.5">Confirm New Password</label>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="input"
            placeholder="••••••••••••"
          />
          {errors['confirmPassword'] && <p className="mt-1.5 text-xs text-red-600">{errors['confirmPassword']}</p>}
        </div>

        <GlowButton type="submit" loading={loading} className="w-full">
          {loading ? 'Resetting…' : 'Reset Password'}
        </GlowButton>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
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
          <h1 className="text-2xl font-bold text-slate-900 mb-1 tracking-tight">Create new password</h1>
          <p className="text-sm text-slate-500">Your new password must be different from previous used passwords.</p>
        </div>

        <Suspense fallback={<div className="card p-6 text-center text-sm text-slate-500">Loading...</div>}>
          <ResetPasswordForm />
        </Suspense>
      </motion.div>
    </div>
  );
}
