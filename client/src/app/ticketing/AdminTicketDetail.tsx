'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ticketingApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import GlowButton from '@/components/ui/GlowButton';
import {
  Modal, StatusBadge, PriorityBadge, TypeBadge, SlaBar, Avatar, Icons,
  STATUS_OPTIONS, PRIORITY_OPTIONS, fmtDate, timeAgo, AttachmentGrid, Person, ACCEPTED_IMAGE_ACCEPT,
  TicketActionsMenu, EditTicketModal, useDeleteTicket, MentionTextarea, CommentBody,
  useMentionCandidates, useCanEditTicket, useTicketAssignees,
} from './shared';
import type { TicketDTO, TicketComment, TicketAttachment, TicketStatus, TicketPriority } from '@/lib/schemas';


// A single labelled read-only fact (Branch, On Site, Client Name, …).
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <div className="text-sm text-slate-800 mt-0.5 min-w-0 break-words">{value}</div>
    </div>
  );
}

// ─── Admin-only image-matched ticket detail / edit modal ─────────────────────────
export default function AdminTicketDetail({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<FileList | null>(null);
  const [editing, setEditing] = useState(false);
  // Ids chosen from the @ picker. Sent alongside the comment; the server re-checks
  // every one against the roster, so this is convenience, not authority.
  const [mentions, setMentions] = useState<string[]>([]);
  // The pane is showing a ticket that no longer exists, so close it on success.
  const { requestDelete } = useDeleteTicket(onClose);

  const { data: ticket } = useQuery<TicketDTO>({ queryKey: ['ticketing', 'ticket', ticketId], queryFn: () => ticketingApi.getTicket(ticketId).then((r) => r.data as TicketDTO) });
  const { data: commentsData } = useQuery<{ comments: TicketComment[] }>({ queryKey: ['ticketing', 'comments', ticketId], queryFn: () => ticketingApi.getComments(ticketId).then((r) => r.data as { comments: TicketComment[] }) });
  const { data: attData } = useQuery<{ attachments: TicketAttachment[] }>({ queryKey: ['ticketing', 'attachments', ticketId], queryFn: () => ticketingApi.getTicketAttachments(ticketId).then((r) => r.data as { attachments: TicketAttachment[] }) });
  const { data: staff = [] } = useTicketAssignees();
  const { data: mentionCandidates } = useMentionCandidates();

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

  // An escalated ticket arrives unassigned so any administrator can pick it up. The
  // one who opens it takes ownership: /admin/tickets/:id/claim is a first-wins guarded
  // UPDATE, so two admins opening it at once cannot double-assign — the loser's 409 is
  // swallowed and the refetch shows who actually got it.
  // ORG_ADMINs share this modal but see the escalated SOURCE ticket, and /claim is
  // ADMINISTRATOR-only — firing it for them would 403, which the api interceptor turns
  // into a full redirect to /403.
  const { user } = useAuth();
  const claimed = useRef(false);
  useEffect(() => {
    if (!ticket || claimed.current || user?.role !== 'ADMINISTRATOR') return;
    if (ticket.assignee || !ticket.labels.includes('escalated')) return;
    claimed.current = true;
    ticketingApi.claim(ticket.id).then(() => void invalidate()).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket, user?.role]);
  const patchMut = useMutation({
    mutationFn: (payload: Record<string, unknown>) => ticketingApi.updateTicket(ticketId, payload),
    onSuccess: () => void invalidate(),
  });
  const commentMut = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('content', comment.trim());
      mentions.forEach((id) => form.append('mentions', id));
      if (files) Array.from(files).forEach((f) => form.append('files', f));
      return ticketingApi.addComment(ticketId, form);
    },
    onSuccess: () => { setComment(''); setFiles(null); setMentions([]); void invalidate(); },
  });

  const manageDirty = !!ticket && (status !== ticket.status || priority !== ticket.priority || assigneeId !== (ticket.assignee?.id ?? ''));

  // Edit lock: creator + ADMINISTRATOR + ORG_ADMIN. Others can read + comment but
  // every edit control below (menu, manage, resolution write-ups) is disabled.
  const canEdit = useCanEditTicket(ticket, user);

  return (
    <Modal open onClose={onClose} width="max-w-4xl">
      {ticket && <EditTicketModal ticket={ticket} open={editing} onClose={() => setEditing(false)} />}
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
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {canEdit && <TicketActionsMenu
                label={`Actions for ${ticket.ticketNumber}`}
                actions={[
                  { label: 'Edit', onSelect: () => setEditing(true) },
                  { label: 'Delete', onSelect: () => void requestDelete(ticket), danger: true },
                ]}
              />}
              <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700 cursor-pointer">
                <Icons.close className="w-5 h-5" />
              </button>
            </div>
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
                <Fact label="Assigned to" value={
                  <Person person={ticket.assignee} fallback={<span className="text-red-500 font-semibold">Unassigned</span>} />} />
                <Fact label="Client Name" value={ticket.customer?.name || '—'} />
                <Fact label="Client Email" value={
                  <span className="block truncate" title={ticket.customer?.email ?? ''}>{ticket.customer?.email || '—'}</span>} />
                <Fact label="Contact Person" value={ticket.customer?.contactPerson || '—'} />
              </div>

              {/* Attachments */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="eyebrow">Attached Files ({attData?.attachments.length ?? 0})</p>
                </div>
                <AttachmentGrid attachments={attData?.attachments ?? []} />
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
                        <CommentBody content={c.content} names={(mentionCandidates ?? []).map((a) => a.name)} />
                        {c.attachments.length > 0 && <div className="mt-1.5"><AttachmentGrid attachments={c.attachments} size="sm" /></div>}
                      </div>
                    </div>
                  ))}
                  {(commentsData?.comments.length ?? 0) === 0 && <p className="text-xs text-slate-400">No comments yet.</p>}
                </div>
                <div className="mt-3 space-y-2">
                  <MentionTextarea
                    value={comment}
                    onChange={setComment}
                    candidates={mentionCandidates ?? []}
                    onMentionsChange={setMentions}
                    placeholder="Add a comment… use @ to mention a platform colleague"
                  />
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-500 cursor-pointer hover:text-slate-700 inline-flex items-center gap-1">
                      <Icons.paperclip className="w-3.5 h-3.5" />
                      {files?.length ? `${files.length} image(s)` : 'Attach images'}
                      <input type="file" accept={ACCEPTED_IMAGE_ACCEPT} multiple className="hidden" onChange={(e) => setFiles(e.target.files)} />
                    </label>
                    <GlowButton className="ml-auto py-1.5 px-4 text-xs" disabled={!comment.trim() || commentMut.isPending} loading={commentMut.isPending} onClick={() => commentMut.mutate()}>Send</GlowButton>
                  </div>
                </div>
              </div>

              {/* Resolution write-ups — same composer sizing as the comment box above,
                  because they are the same kind of input: free prose an admin types
                  about this ticket, not a sidebar setting. */}
              <div>
                <p className="eyebrow mb-2">Resolved Methods</p>
                {ticket.resolvedMethods && <p className="text-xs text-slate-500 mb-2">Current: <span className="text-slate-700">{ticket.resolvedMethods}</span></p>}
                <textarea value={resolved} onChange={(e) => setResolved(e.target.value)} rows={2} disabled={!canEdit} className="input resize-none text-sm disabled:opacity-60" placeholder="Describe how it was resolved…" />
                <div className="mt-2 flex items-center gap-2">
                  <GlowButton className="ml-auto py-1.5 px-4 text-xs" disabled={!canEdit || resolved === (ticket.resolvedMethods ?? '') || patchMut.isPending}
                    onClick={() => patchMut.mutate({ resolvedMethods: resolved.trim() || null })}>Update</GlowButton>
                </div>
              </div>

              <div>
                <p className="eyebrow mb-2">Reason for Delay</p>
                {ticket.reasonForDelay && <p className="text-xs text-slate-500 mb-2">Current: <span className="text-slate-700">{ticket.reasonForDelay}</span></p>}
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} disabled={!canEdit} className="input resize-none text-sm disabled:opacity-60" placeholder="Why is this taking longer…" />
                <div className="mt-2 flex items-center gap-2">
                  <GlowButton className="ml-auto py-1.5 px-4 text-xs" disabled={!canEdit || reason === (ticket.reasonForDelay ?? '') || patchMut.isPending}
                    onClick={() => patchMut.mutate({ reasonForDelay: reason.trim() || null })}>Save Reason</GlowButton>
                </div>
              </div>
            </div>

            {/* Sidebar — manage + SLA + facts */}
            <div className="p-6 space-y-5 bg-slate-50/40">
              <div className="rounded-xl bg-white ring-1 ring-slate-200/70 p-3.5 space-y-3">
                <p className="eyebrow">Manage</p>
                <label className="block">
                  <span className="block text-[11px] font-medium text-slate-500 mb-1">Status</span>
                  <select value={status} onChange={(e) => setStatus(e.target.value as TicketStatus)} disabled={!canEdit} className="input !py-1.5 text-xs disabled:opacity-60">
                    {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-[11px] font-medium text-slate-500 mb-1">Priority</span>
                  <select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)} disabled={!canEdit} className="input !py-1.5 text-xs disabled:opacity-60">
                    {PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-[11px] font-medium text-slate-500 mb-1">Assignee</span>
                  <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} disabled={!canEdit} className="input !py-1.5 text-xs disabled:opacity-60">
                    <option value="">Unassigned</option>
                    {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <GlowButton className="w-full py-1.5 text-xs" disabled={!canEdit || !manageDirty || patchMut.isPending} loading={patchMut.isPending}
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
                <Fact label="Requested by" value={<Person person={ticket.reporter} />} />
                <Fact label="Created" value={fmtDate(ticket.createdAt)} />
                <Fact label="SLA policy" value={ticket.sla ? `${ticket.sla.name} · ${ticket.sla.responseTime}${ticket.sla.timeUnit[0]}/${ticket.sla.resolutionTime}${ticket.sla.timeUnit[0]}` : 'None'} />
              </div>

              <GlowButton variant="secondary" className="w-full py-1.5 text-xs" onClick={onClose}>Close</GlowButton>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
