'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ticketingApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import GlowButton from '@/components/ui/GlowButton';
import { StatusBadge, PriorityBadge, SlaBadge, TypeBadge, fmtDate, timeAgo } from './shared';
import type { TicketDTO, TicketComment, TicketActivity, TicketAttachment, PersonRef } from '@/lib/schemas';

function formatBytes(n: number | null): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function triggerDownload(id: string, name: string) {
  const { data } = await ticketingApi.downloadAttachment(id);
  const url = URL.createObjectURL(data as Blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

function AttachmentChip({ a }: { a: TicketAttachment }) {
  return (
    <button type="button" onClick={() => void triggerDownload(a.id, a.originalName ?? 'attachment')}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer">
      <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
      </svg>
      {a.originalName} <span className="text-slate-400">{formatBytes(a.size)}</span>
    </button>
  );
}

export default function TicketDetail({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<FileList | null>(null);

  const { data: ticket } = useQuery<TicketDTO>({ queryKey: ['ticketing', 'ticket', ticketId], queryFn: () => ticketingApi.getTicket(ticketId).then((r) => r.data as TicketDTO) });
  const { data: commentsData } = useQuery<{ comments: TicketComment[] }>({ queryKey: ['ticketing', 'comments', ticketId], queryFn: () => ticketingApi.getComments(ticketId).then((r) => r.data as { comments: TicketComment[] }) });
  const { data: activityData } = useQuery<{ activity: TicketActivity[] }>({ queryKey: ['ticketing', 'activity', ticketId], queryFn: () => ticketingApi.getActivity(ticketId).then((r) => r.data as { activity: TicketActivity[] }) });
  const { data: attData } = useQuery<{ attachments: TicketAttachment[] }>({ queryKey: ['ticketing', 'attachments', ticketId], queryFn: () => ticketingApi.getTicketAttachments(ticketId).then((r) => r.data as { attachments: TicketAttachment[] }) });
  const { data: watchersData } = useQuery<{ watchers: PersonRef[] }>({ queryKey: ['ticketing', 'watchers', ticketId], queryFn: () => ticketingApi.getWatchers(ticketId).then((r) => r.data as { watchers: PersonRef[] }) });

  const watchers = watchersData?.watchers ?? [];
  const isWatching = !!user && watchers.some((w) => w.email && w.email.toLowerCase() === user.email.toLowerCase());

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ticketing'] });

  const commentMut = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('content', comment.trim());
      if (files) Array.from(files).forEach((f) => form.append('files', f));
      return ticketingApi.addComment(ticketId, form);
    },
    onSuccess: () => { setComment(''); setFiles(null); void invalidate(); },
  });
  const uploadMut = useMutation({
    mutationFn: (fl: FileList) => { const form = new FormData(); Array.from(fl).forEach((f) => form.append('files', f)); return ticketingApi.uploadAttachments(ticketId, form); },
    onSuccess: () => void invalidate(),
  });
  const watchMut = useMutation({
    mutationFn: () => (isWatching ? ticketingApi.unwatch(ticketId) : ticketingApi.watch(ticketId)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ticketing', 'watchers', ticketId] }),
  });

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-slate-900/40 backdrop-blur-sm p-4 sm:p-8" onClick={onClose}>
      <motion.div initial={{ opacity: 0, y: 12, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.18 }}
        onClick={(e) => e.stopPropagation()} className="card w-full max-w-4xl my-2 shadow-pop overflow-hidden">
        {!ticket ? (
          <div className="p-12 text-center text-sm text-slate-400">Loading…</div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-slate-100">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs font-bold text-slate-400">{ticket.ticketNumber}</span>
                  <StatusBadge status={ticket.status} /><PriorityBadge priority={ticket.priority} />
                  <SlaBadge status={ticket.slaStatus} remainingSeconds={ticket.slaRemainingSeconds} /><TypeBadge type={ticket.type} />
                </div>
                <h2 className="text-lg font-bold text-slate-900 mt-1.5 leading-tight">{ticket.title}</h2>
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700 cursor-pointer flex-shrink-0">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 max-h-[75vh] overflow-y-auto">
              {/* Main */}
              <div className="lg:col-span-2 p-6 space-y-6 border-r border-slate-100">
                <div>
                  <p className="eyebrow mb-1.5">Description</p>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{ticket.description}</p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="eyebrow">Attachments ({attData?.attachments.length ?? 0})</p>
                    <label className="text-xs font-semibold text-brand hover:text-brand-700 cursor-pointer">
                      + Add files
                      <input type="file" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) uploadMut.mutate(e.target.files); }} />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(attData?.attachments ?? []).map((a) => <AttachmentChip key={a.id} a={a} />)}
                    {(attData?.attachments.length ?? 0) === 0 && <p className="text-xs text-slate-400">No attachments.</p>}
                  </div>
                </div>

                <div>
                  <p className="eyebrow mb-2">Comments ({commentsData?.comments.length ?? 0})</p>
                  <div className="space-y-3">
                    {(commentsData?.comments ?? []).map((c) => (
                      <div key={c.id} className="flex gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-brand-50 text-brand text-xs font-bold flex items-center justify-center flex-shrink-0">{(c.author?.name ?? '?').charAt(0)}</div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs"><span className="font-semibold text-slate-800">{c.author?.name ?? 'Unknown'}</span> <span className="text-slate-400">· {timeAgo(c.createdAt)}</span></p>
                          <p className="text-sm text-slate-700 whitespace-pre-wrap mt-0.5">{c.content}</p>
                          {c.attachments.length > 0 && <div className="flex flex-wrap gap-2 mt-1.5">{c.attachments.map((a) => <AttachmentChip key={a.id} a={a} />)}</div>}
                        </div>
                      </div>
                    ))}
                    {(commentsData?.comments.length ?? 0) === 0 && <p className="text-xs text-slate-400">No comments yet.</p>}
                  </div>

                  <div className="mt-3 space-y-2">
                    <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} className="input resize-none text-sm" placeholder="Add a comment…" />
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">
                        {files?.length ? `${files.length} file(s)` : 'Attach files'}
                        <input type="file" multiple className="hidden" onChange={(e) => setFiles(e.target.files)} />
                      </label>
                      <GlowButton className="ml-auto py-1.5 px-4 text-xs" disabled={!comment.trim() || commentMut.isPending} loading={commentMut.isPending} onClick={() => commentMut.mutate()}>Comment</GlowButton>
                    </div>
                  </div>
                </div>
              </div>

              {/* Sidebar */}
              <div className="p-6 space-y-5">
                <div className="space-y-2.5 text-xs">
                  {[['Project', ticket.projectName ?? '—'], ['Reporter', ticket.reporter?.name ?? '—'], ['Assignee', ticket.assignee?.name ?? 'Unassigned'],
                    ['SLA', ticket.sla ? `${ticket.sla.name} (${ticket.sla.resolutionTime}${ticket.sla.timeUnit[0]})` : 'None'],
                    ['Branch', ticket.branch ?? '—'], ['On-site', ticket.onSiteSupportRequired ? 'Yes' : 'No'], ['Created', fmtDate(ticket.createdAt)]].map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2"><span className="text-slate-400">{k}</span><span className="font-medium text-slate-700 text-right truncate">{v}</span></div>
                  ))}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="eyebrow">Watchers ({watchers.length})</p>
                    <button type="button" onClick={() => watchMut.mutate()} disabled={watchMut.isPending}
                      className={`text-xs font-semibold cursor-pointer ${isWatching ? 'text-slate-500 hover:text-slate-700' : 'text-brand hover:text-brand-700'}`}>
                      {isWatching ? 'Unwatch' : 'Watch'}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {watchers.map((w) => <span key={w.id} className="px-2 py-0.5 rounded-md text-[11px] font-medium text-slate-600 bg-slate-100">{w.name}</span>)}
                    {watchers.length === 0 && <p className="text-xs text-slate-400">No watchers.</p>}
                  </div>
                </div>

                <div>
                  <p className="eyebrow mb-2">Activity</p>
                  <div className="space-y-2.5">
                    {(activityData?.activity ?? []).map((a) => (
                      <div key={a.id} className="flex gap-2 text-[11px]">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-300 mt-1.5 flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-slate-600">
                            <span className="font-semibold text-slate-700">{a.user?.name ?? 'System'}</span>{' '}
                            {a.description || `${a.type.replace('_', ' ')}${a.field ? ` (${String(a.oldValue ?? '—')} → ${String(a.newValue ?? '—')})` : ''}`}
                          </p>
                          <p className="text-slate-400">{timeAgo(a.createdAt)}</p>
                        </div>
                      </div>
                    ))}
                    {(activityData?.activity.length ?? 0) === 0 && <p className="text-xs text-slate-400">No activity.</p>}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}
