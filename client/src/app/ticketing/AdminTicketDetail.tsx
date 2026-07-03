'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ticketingApi } from '@/lib/api';
import GlowButton from '@/components/ui/GlowButton';
import {
  Modal, StatusBadge, PriorityBadge, TypeBadge, SlaBar, Avatar, Icons,
  STATUS_OPTIONS, PRIORITY_OPTIONS, fmtDate, timeAgo,
} from './shared';
import type { TicketDTO, TicketComment, TicketAttachment, TicketStatus, TicketPriority } from '@/lib/schemas';

type Staff = { id: string; name: string; email: string; role: string };

function formatBytes(n: number | null): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function openAttachment(id: string, name: string, mode: 'preview' | 'download') {
  const { data } = await ticketingApi.downloadAttachment(id);
  const url = URL.createObjectURL(data as Blob);
  if (mode === 'preview') {
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } else {
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  }
}

// A single labelled read-only fact (Branch, On Site, Client Name, …).
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <div className="text-sm text-slate-800 mt-0.5 break-words">{value}</div>
    </div>
  );
}

// ─── Admin-only image-matched ticket detail / edit modal ─────────────────────────
export default function AdminTicketDetail({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<FileList | null>(null);

  const { data: ticket } = useQuery<TicketDTO>({ queryKey: ['ticketing', 'ticket', ticketId], queryFn: () => ticketingApi.getTicket(ticketId).then((r) => r.data as TicketDTO) });
  const { data: commentsData } = useQuery<{ comments: TicketComment[] }>({ queryKey: ['ticketing', 'comments', ticketId], queryFn: () => ticketingApi.getComments(ticketId).then((r) => r.data as { comments: TicketComment[] }) });
  const { data: attData } = useQuery<{ attachments: TicketAttachment[] }>({ queryKey: ['ticketing', 'attachments', ticketId], queryFn: () => ticketingApi.getTicketAttachments(ticketId).then((r) => r.data as { attachments: TicketAttachment[] }) });
  const { data: staffData } = useQuery<{ assignees: Staff[] }>({ queryKey: ['ticketing', 'assignees'], queryFn: () => ticketingApi.listAssignees().then((r) => r.data as { assignees: Staff[] }), staleTime: 60_000 });

  // Manage (status / priority / assignee)
  const [status, setStatus] = useState<TicketStatus>('todo');
  const [priority, setPriority] = useState<TicketPriority>('medium');
  const [assigneeId, setAssigneeId] = useState('');
  const [resolved, setResolved] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!ticket) return;
    setStatus(ticket.status); setPriority(ticket.priority); setAssigneeId(ticket.assignee?.id ?? '');
    setResolved(ticket.resolvedMethods ?? ''); setReason(ticket.reasonForDelay ?? '');
  }, [ticket]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ticketing'] });
  const patchMut = useMutation({
    mutationFn: (payload: Record<string, unknown>) => ticketingApi.updateTicket(ticketId, payload),
    onSuccess: () => void invalidate(),
  });
  const commentMut = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('content', comment.trim());
      if (files) Array.from(files).forEach((f) => form.append('files', f));
      return ticketingApi.addComment(ticketId, form);
    },
    onSuccess: () => { setComment(''); setFiles(null); void invalidate(); },
  });

  const manageDirty = !!ticket && (status !== ticket.status || priority !== ticket.priority || assigneeId !== (ticket.assignee?.id ?? ''));

  return (
    <Modal open onClose={onClose} width="max-w-4xl">
      {!ticket ? (
        <div className="py-16 text-center text-sm text-slate-400">Loading…</div>
      ) : (
        <div className="-m-6">
          {/* Header */}
          <div className="px-6 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-xs font-bold text-slate-400">{ticket.ticketNumber}</span>
                <StatusBadge status={ticket.status} /><PriorityBadge priority={ticket.priority} /><TypeBadge type={ticket.type} />
                {ticket.labels.includes('escalated') && (
                  <span className="text-[10px] font-bold text-amber-700 bg-amber-50 ring-1 ring-inset ring-amber-600/15 px-1.5 py-0.5 rounded">ESCALATED</span>
                )}
              </div>
              <h2 className="text-lg font-bold text-slate-900 mt-1.5 leading-tight">{ticket.title}</h2>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700 cursor-pointer flex-shrink-0">
              <Icons.close className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 max-h-[75vh] overflow-y-auto">
            {/* Main */}
            <div className="lg:col-span-2 p-6 space-y-6 lg:border-r border-slate-100">
              <div>
                <p className="eyebrow mb-1.5">Description</p>
                <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{ticket.description}</p>
              </div>

              {/* Client / logistics facts */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 rounded-xl bg-slate-50 ring-1 ring-slate-200/70 p-4">
                <Fact label="Branch" value={ticket.branch || '—'} />
                <Fact label="On Site Required" value={ticket.onSiteSupportRequired ? 'Yes' : 'No'} />
                <Fact label="Assigned to" value={ticket.assignee
                  ? <span className="inline-flex items-center gap-1.5"><Avatar name={ticket.assignee.name} size="xs" />{ticket.assignee.name}{ticket.assignee.email && <span className="text-slate-400 text-xs"> · {ticket.assignee.email}</span>}</span>
                  : <span className="text-red-500 font-semibold">Unassigned</span>} />
                <Fact label="Client Name" value={ticket.customer?.name || '—'} />
                <Fact label="Client Email" value={ticket.customer?.email || '—'} />
                <Fact label="Contact Person" value={ticket.customer?.contactPerson || '—'} />
              </div>

              {/* Attachments */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="eyebrow">Attached Files ({attData?.attachments.length ?? 0})</p>
                </div>
                <div className="space-y-1.5">
                  {(attData?.attachments ?? []).map((a) => (
                    <div key={a.id} className="flex items-center gap-2 rounded-lg bg-slate-50 ring-1 ring-slate-200/70 px-2.5 py-1.5">
                      <Icons.paperclip className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      <span className="text-xs font-medium text-slate-700 truncate flex-1">{a.originalName}</span>
                      <span className="text-[10px] text-slate-400">{formatBytes(a.size)}</span>
                      <button type="button" onClick={() => void openAttachment(a.id, a.originalName ?? 'file', 'preview')} className="text-[11px] font-semibold text-brand hover:text-brand-700 cursor-pointer">Preview</button>
                      <button type="button" onClick={() => void openAttachment(a.id, a.originalName ?? 'file', 'download')} className="text-[11px] font-semibold text-slate-500 hover:text-slate-800 cursor-pointer">Download</button>
                    </div>
                  ))}
                  {(attData?.attachments.length ?? 0) === 0 && <p className="text-xs text-slate-400">No attachments.</p>}
                </div>
              </div>

              {/* Comments */}
              <div>
                <p className="eyebrow mb-2">Comments ({commentsData?.comments.length ?? 0})</p>
                <div className="space-y-3">
                  {(commentsData?.comments ?? []).map((c) => (
                    <div key={c.id} className="flex gap-2.5">
                      <Avatar name={c.author?.name} size="md" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs"><span className="font-semibold text-slate-800">{c.author?.name ?? 'Unknown'}</span> <span className="text-slate-400">· {timeAgo(c.createdAt)}</span></p>
                        <p className="text-sm text-slate-700 whitespace-pre-wrap mt-0.5">{c.content}</p>
                      </div>
                    </div>
                  ))}
                  {(commentsData?.comments.length ?? 0) === 0 && <p className="text-xs text-slate-400">No comments yet.</p>}
                </div>
                <div className="mt-3 space-y-2">
                  <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} className="input resize-none text-sm" placeholder="Add a comment…" />
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-500 cursor-pointer hover:text-slate-700 inline-flex items-center gap-1">
                      <Icons.paperclip className="w-3.5 h-3.5" />
                      {files?.length ? `${files.length} file(s)` : 'Attach files'}
                      <input type="file" multiple className="hidden" onChange={(e) => setFiles(e.target.files)} />
                    </label>
                    <GlowButton className="ml-auto py-1.5 px-4 text-xs" disabled={!comment.trim() || commentMut.isPending} loading={commentMut.isPending} onClick={() => commentMut.mutate()}>Send</GlowButton>
                  </div>
                </div>
              </div>
            </div>

            {/* Sidebar — manage + SLA + resolution */}
            <div className="p-6 space-y-5 bg-slate-50/40">
              <div className="rounded-xl bg-white ring-1 ring-slate-200/70 p-3.5 space-y-3">
                <p className="eyebrow">Manage</p>
                <label className="block">
                  <span className="block text-[11px] font-medium text-slate-500 mb-1">Status</span>
                  <select value={status} onChange={(e) => setStatus(e.target.value as TicketStatus)} className="input !py-1.5 text-xs">
                    {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-[11px] font-medium text-slate-500 mb-1">Priority</span>
                  <select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)} className="input !py-1.5 text-xs">
                    {PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-[11px] font-medium text-slate-500 mb-1">Assignee</span>
                  <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className="input !py-1.5 text-xs">
                    <option value="">Unassigned</option>
                    {(staffData?.assignees ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <GlowButton className="w-full py-1.5 text-xs" disabled={!manageDirty || patchMut.isPending} loading={patchMut.isPending}
                  onClick={() => patchMut.mutate({
                    ...(status !== ticket.status ? { status } : {}),
                    ...(priority !== ticket.priority ? { priority } : {}),
                    ...(assigneeId !== (ticket.assignee?.id ?? '') ? { assigneeId: assigneeId || null } : {}),
                  })}>
                  {patchMut.isPending ? 'Saving…' : manageDirty ? 'Save changes' : 'No changes'}
                </GlowButton>
              </div>

              {/* Dual SLA */}
              <div className="space-y-3">
                <SlaBar label="Response" evaluation={ticket.responseSla} />
                <SlaBar label="Resolution" evaluation={ticket.resolutionSla} />
              </div>

              <div className="space-y-2.5 text-xs">
                <Fact label="Created by" value={ticket.reporter?.name ?? '—'} />
                <Fact label="Created" value={fmtDate(ticket.createdAt)} />
                <Fact label="SLA policy" value={ticket.sla ? `${ticket.sla.name} · ${ticket.sla.responseTime}${ticket.sla.timeUnit[0]}/${ticket.sla.resolutionTime}${ticket.sla.timeUnit[0]}` : 'None'} />
              </div>

              {/* Resolved methods */}
              <div className="rounded-xl bg-white ring-1 ring-slate-200/70 p-3.5 space-y-2">
                <p className="eyebrow">Resolved Methods</p>
                {ticket.resolvedMethods && <p className="text-xs text-slate-500">Current: <span className="text-slate-700">{ticket.resolvedMethods}</span></p>}
                <textarea value={resolved} onChange={(e) => setResolved(e.target.value)} rows={2} className="input resize-none text-xs" placeholder="Describe how it was resolved…" />
                <GlowButton className="w-full py-1.5 text-xs" disabled={resolved === (ticket.resolvedMethods ?? '') || patchMut.isPending}
                  onClick={() => patchMut.mutate({ resolvedMethods: resolved.trim() || null })}>Update</GlowButton>
              </div>

              {/* Reason for delay */}
              <div className="rounded-xl bg-white ring-1 ring-slate-200/70 p-3.5 space-y-2">
                <p className="eyebrow">Reason for Delay</p>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="input resize-none text-xs" placeholder="Why is this taking longer…" />
                <GlowButton className="w-full py-1.5 text-xs" disabled={reason === (ticket.reasonForDelay ?? '') || patchMut.isPending}
                  onClick={() => patchMut.mutate({ reasonForDelay: reason.trim() || null })}>Save Reason</GlowButton>
              </div>

              <GlowButton variant="secondary" className="w-full py-1.5 text-xs" onClick={onClose}>Close</GlowButton>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
