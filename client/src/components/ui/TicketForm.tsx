'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import GlowButton from './GlowButton';
import { requestsApi } from '@/lib/api';
import type { OrganizationService, RequestType, Priority, ServiceRequest } from '@/lib/schemas';

interface TicketFormProps {
  services?: OrganizationService[];
  /** Optional override; by default the form POSTs to /api/requests directly. */
  onSubmit?: (data: { subject: string; type: RequestType; priority: Priority; service: string | null; description: string }) => Promise<void> | void;
}

const typeOptions: Array<{ value: RequestType; label: string; hint: string }> = [
  { value: 'SUPPORT',         label: 'Support',         hint: 'General question or how-to' },
  { value: 'INCIDENT',        label: 'Incident',        hint: 'Active issue or outage' },
  { value: 'FEATURE_REQUEST', label: 'Feature Request', hint: 'New capability' },
  { value: 'BILLING',         label: 'Billing',         hint: 'Invoice or contract' },
  { value: 'ONBOARDING',      label: 'Onboarding',      hint: 'Setup or training' },
];

const priorityOptions: Array<{ value: Priority; label: string; cls: string; activeCls: string }> = [
  { value: 'LOW',      label: 'Low',      cls: 'text-slate-600 bg-slate-100 hover:bg-slate-200',
    activeCls: 'text-slate-700 bg-slate-200 ring-2 ring-slate-300' },
  { value: 'MEDIUM',   label: 'Medium',   cls: 'text-cyan-700 bg-cyan-50 hover:bg-cyan-100',
    activeCls: 'text-cyan-700 bg-cyan-100 ring-2 ring-cyan-300' },
  { value: 'HIGH',     label: 'High',     cls: 'text-amber-700 bg-amber-50 hover:bg-amber-100',
    activeCls: 'text-amber-700 bg-amber-100 ring-2 ring-amber-300' },
  { value: 'CRITICAL', label: 'Critical', cls: 'text-red-700 bg-red-50 hover:bg-red-100',
    activeCls: 'text-red-700 bg-red-100 ring-2 ring-red-300' },
];

export default function TicketForm({ services = [], onSubmit }: TicketFormProps) {
  const queryClient = useQueryClient();
  const [subject, setSubject]         = useState('');
  const [type, setType]               = useState<RequestType>('SUPPORT');
  const [priority, setPriority]       = useState<Priority>('MEDIUM');
  const [service, setService]         = useState<string>('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting]   = useState(false);
  const [successId, setSuccessId]     = useState<string | null>(null);
  const [error, setError]             = useState<string | null>(null);

  const eligibleServices = services.filter((s) => s.enabled && (s.status === 'ACTIVE' || s.status === 'EXPIRING'));
  const isValid = subject.trim().length >= 5;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);
    setError(null);

    const payload = {
      subject: subject.trim(),
      type,
      priority,
      service: service || null,
      description: description.trim() || undefined,
    };

    try {
      let ticketId: string;
      if (onSubmit) {
        await onSubmit({ ...payload, description: description.trim() });
        ticketId = 'submitted';
      } else {
        const { data } = await requestsApi.create(payload);
        ticketId = (data as ServiceRequest).id;
        await queryClient.invalidateQueries({ queryKey: ['my-requests'] });
      }
      setSuccessId(ticketId);
      setSubject(''); setDescription(''); setService(''); setType('SUPPORT'); setPriority('MEDIUM');
      setTimeout(() => setSuccessId(null), 6000);
    } catch {
      setError('Could not create the ticket. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // Short, human-friendly reference derived from the real ticket id.
  const reference = successId ? `TKT-${successId.slice(-8).toUpperCase()}` : '';

  return (
    <div className="card p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5 pb-4 border-b border-slate-100">
        <div className="w-10 h-10 rounded-lg bg-brand-50 border border-brand-100 flex items-center justify-center flex-shrink-0">
          <svg className="w-5 h-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 010 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 010-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375z" />
          </svg>
        </div>
        <div>
          <h3 className="text-base font-semibold text-slate-900 leading-tight">Create Support Ticket</h3>
          <p className="text-xs text-slate-500 mt-0.5">Your CSM team responds within the SLA tied to priority</p>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {successId ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="py-8 text-center"
          >
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-50 border border-emerald-100 mb-4">
              <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-slate-900 mb-1">Ticket created</p>
            <p className="text-xs text-slate-500">Reference</p>
            <p className="font-mono text-base font-bold text-brand mt-1 tracking-wider">{reference}</p>
            <p className="text-xs text-slate-400 mt-3">Your ticket is now open and visible below. Your CSM will reach out shortly.</p>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onSubmit={handleSubmit}
            className="space-y-4"
          >
            {/* Subject */}
            <div>
              <label htmlFor="subject" className="block text-sm font-medium text-slate-700 mb-1.5">
                Subject <span className="text-red-500">*</span>
              </label>
              <input
                id="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Brief summary of the issue"
                className="input"
                maxLength={200}
                required
              />
              <p className="mt-1 text-[11px] text-slate-400">{subject.length}/200 — minimum 5 characters</p>
            </div>

            {/* Type + Service in row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="type" className="block text-sm font-medium text-slate-700 mb-1.5">Type</label>
                <select id="type" value={type} onChange={(e) => setType(e.target.value as RequestType)} className="input">
                  {typeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label} — {opt.hint}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="service" className="block text-sm font-medium text-slate-700 mb-1.5">Related Service</label>
                <select id="service" value={service} onChange={(e) => setService(e.target.value)} className="input" disabled={eligibleServices.length === 0}>
                  <option value="">— None / general inquiry —</option>
                  {eligibleServices.map((s) => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Priority — radio pills */}
            <div>
              <span className="block text-sm font-medium text-slate-700 mb-1.5">Priority</span>
              <div className="flex flex-wrap gap-2">
                {priorityOptions.map((opt) => {
                  const isActive = priority === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setPriority(opt.value)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${isActive ? opt.activeCls : opt.cls}`}
                      aria-pressed={isActive}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              {priority === 'CRITICAL' && (
                <p className="mt-2 text-[11px] text-red-600">⚠ Critical incidents trigger a 1-hour response SLA and CSM page-out.</p>
              )}
            </div>

            {/* Description */}
            <div>
              <label htmlFor="description" className="block text-sm font-medium text-slate-700 mb-1.5">Description</label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional — add detail: what you observed, what you expected, any error codes…"
                rows={4}
                className="input resize-none"
                maxLength={2000}
              />
              <p className="mt-1 text-[11px] text-slate-400">{description.length}/2000</p>
            </div>

            {/* Submit */}
            <div className="flex items-center gap-3 pt-2">
              <GlowButton type="submit" disabled={!isValid || submitting} loading={submitting}>
                {submitting ? 'Creating…' : 'Submit Ticket'}
              </GlowButton>
              {!isValid && <span className="text-xs text-slate-400">Subject required (5+ chars)</span>}
              {error && <span className="text-xs text-red-600">{error}</span>}
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}
