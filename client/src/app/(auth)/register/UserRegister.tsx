'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { authApi } from '@/lib/api';
import { RegisterSchema } from '@/lib/schemas';
import GlowButton from '@/components/ui/GlowButton';
import AmbientBackdrop from '@/components/ui/AmbientBackdrop';

export default function RegisterPage() {
  const router = useRouter();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    setServerError('');

    const fd = new FormData(e.currentTarget);
    const data = {
      name: fd.get('name') as string,
      email: fd.get('email') as string,
      password: fd.get('password') as string,
      organizationName: fd.get('organizationName') as string,
      contactNumber: fd.get('contactNumber') as string,
    };

    const result = RegisterSchema.safeParse(data);
    if (!result.success) {
      const flat = result.error.flatten().fieldErrors;
      setErrors(Object.fromEntries(Object.entries(flat).map(([k, v]) => [k, v?.[0] ?? ''])));
      return;
    }

    setLoading(true);
    try {
      await authApi.register(result.data);
      router.push('/dashboard');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Registration failed';
      setServerError(msg);
    } finally {
      setLoading(false);
    }
  }

  const fields: Array<{ id: string; label: string; type?: string; autoComplete?: string; placeholder: string }> = [
    { id: 'organizationName', label: 'Organization name', placeholder: 'Organization Name' },
    { id: 'name', label: 'Your full name', placeholder: 'Your Name' },
    { id: 'email', label: 'Work email', type: 'email', autoComplete: 'email', placeholder: 'you@organization.com' },
    { id: 'contactNumber', label: 'Contact number', type: 'tel', autoComplete: 'tel', placeholder: '+91 9876543210' },
    { id: 'password', label: 'Password', type: 'password', autoComplete: 'new-password', placeholder: 'New password' },
  ];

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-12">
      <AmbientBackdrop />
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
        className="w-full max-w-[420px]"
      >
        {/* Brand */}
        <div className="mb-8 text-center">
          <div className="flex justify-center mb-6">
            <img src="/banihal-logo.png" alt="Banihal Logo" className="max-h-12 w-auto object-contain" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-1 tracking-tight">Create your Account</h1>
          <p className="text-sm text-slate-500">Start managing your security operations</p>
        </div>

        {/* Card */}
        <div className="card p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
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

            {fields.map(({ id, label, type = 'text', autoComplete, placeholder }) => (
              <div key={id}>
                <label htmlFor={id} className="block text-sm font-medium text-slate-700 mb-1.5">{label}</label>
                <input id={id} name={id} type={type} autoComplete={autoComplete} placeholder={placeholder} className="input" />
                {errors[id] && <p className="mt-1.5 text-xs text-red-600">{errors[id]}</p>}
              </div>
            ))}

            <GlowButton type="submit" loading={loading} className="w-full !mt-6">
              {loading ? 'Creating organization…' : 'Create organization'}
            </GlowButton>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-slate-500">
          Already have an account?{' '}
          <Link href="/login" className="font-semibold text-brand hover:text-brand-700 transition-colors">
            Sign in
          </Link>
        </p>
      </motion.div >
    </div >
  );
}
