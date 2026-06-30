'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ticketingApi } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import GlowButton from '@/components/ui/GlowButton';
import {
  StatusBadge, PriorityBadge, SlaBadge, TypeBadge, Avatar, Drawer, Icons,
  STATUS_OPTIONS, PRIORITY_OPTIONS, fmtDate, timeAgo,
} from './shared';
import type {
  TicketDTO, TicketComment, TicketActivity, TicketAttachment, TicketProject,
  PersonRef, TicketStatus, TicketPriority,
} from '@/lib/schemas';

type Staff = { id: string; name: string; email: string; role: string };

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
      <Icons.paperclip className="w-3.5 h-3.5 text-slate-400" />
      {a.originalName} <span className="text-slate-400">{formatBytes(a.size)}</span>
    </button>
  );
}

// ─── Staff quick-edit row ───────────────────────────────────────────────────────
function QuickEdit({ ticket }: { ticket: TicketDTO }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<TicketStatus>(ticket.status);
  const [priority, setPriority] = useState<TicketPriority>(ticket.priority);
  const [assigneeId, setAssigneeId] = useState(ticket.assignee?.id ?? '');
  const [projectId, setProjectId] = useState(ticket.projectId);

  useEffect(() => {
    setStatus(ticket.status); setPriority(ticket.priority);
    setAssigneeId(ticket.assignee?.id ?? ''); setProjectId(ticket.projectId);
  }, [ticket]);

  const { data: projectsData } = useQuery<{ projects: TicketProject[] }>({
    queryKey: ['ticketing', 'projects'], queryFn: () => ticketingApi.listProjects().then((r) => r.data as { projects: TicketProject[] }), staleTime: 60_000,
  });
  const { data: staffData } = useQuery<{ assignees: Staff[] }>({
    queryKey: ['ticketing', 'assignees'], queryFn: () => ticketingApi.listAssignees().then((r) => r.data as { assignees: Staff[] }), staleTime: 60_000,
  });

  const mut = useMutation({
    mutationFn: (payload: unknown) => ticketingApi.updateTicket(ticket.id, payload),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ticketing'] }); },
  });

  const dirty = status !== ticket.status || priority !== ticket.priority
    || assigneeId !== (ticket.assignee?.id ?? '') || projectId !== ticket.projectId;

  return (
    <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200/70 p-3.5 space-y-3">
      <p className="eyebrow">Manage</p>
      <div className="grid grid-cols-2 gap-3">
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
        <label className="block">
          <span className="block text-[11px] font-medium text-slate-500 mb-1">Project</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input !py-1.5 text-xs">
            {(projectsData?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      <GlowButton className="w-full py-1.5 text-xs" disabled={!dirty || mut.isPending} loading={mut.isPending}
        onClick={() => mut.mutate({
          ...(status !== ticket.status ? { status } : {}),
          ...(priority !== ticket.priority ? { priority } : {}),
          ...(assigneeId !== (ticket.assignee?.id ?? '') ? { assigneeId: assigneeId || null } : {}),
          ...(projectId !== ticket.projectId ? { projectId } : {}),
        })}>
        {mut.isPending ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
      </GlowButton>
    </div>
  );
}

export default function TicketDetail({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isStaff = user?.role === 'ORG_ADMIN' || user?.role === 'ADMINISTRATOR';
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
    <Drawer open onClose={onClose} width="max-w-3xl">
      {!ticket ? (
        <div className="p-12 text-center text-sm text-slate-400">Loading…</div>
      ) : (
        <>
          {/* Sticky header */}
          <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-slate-100 px-6 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs font-bold text-slate-400">{ticket.ticketNumber}</span>
                  <StatusBadge status={ticket.status} /><PriorityBadge priority={ticket.priority} />
                  <SlaBadge status={ticket.slaStatus} remainingSeconds={ticket.slaRemainingSeconds} /><TypeBadge type={ticket.type} />
                </div>
                <h2 className="text-lg font-bold text-slate-900 mt-1.5 leading-tight">{ticket.title}</h2>
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700 cursor-pointer flex-shrink-0">
                <Icons.close className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3">
            {/* Main */}
            <div className="lg:col-span-2 p-6 space-y-6 lg:border-r border-slate-100">
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
                      <Avatar name={c.author?.name} size="md" />
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
                    <label className="text-xs text-slate-500 cursor-pointer hover:text-slate-700 inline-flex items-center gap-1">
                      <Icons.paperclip className="w-3.5 h-3.5" />
                      {files?.length ? `${files.length} file(s)` : 'Attach files'}
                      <input type="file" multiple className="hidden" onChange={(e) => setFiles(e.target.files)} />
                    </label>
                    <GlowButton className="ml-auto py-1.5 px-4 text-xs" disabled={!comment.trim() || commentMut.isPending} loading={commentMut.isPending} onClick={() => commentMut.mutate()}>Comment</GlowButton>
                  </div>
                </div>
              </div>
            </div>

            {/* Sidebar */}
            <div className="p-6 space-y-5 bg-slate-50/40">
              {isStaff && <QuickEdit ticket={ticket} />}

              <div className="space-y-2.5 text-xs">
                {([['Project', ticket.projectName ?? '—'], ['Reporter', ticket.reporter?.name ?? '—'], ['Assignee', ticket.assignee?.name ?? 'Unassigned'],
                  ['SLA', ticket.sla ? `${ticket.sla.name} (${ticket.sla.resolutionTime}${ticket.sla.timeUnit[0]})` : 'None'],
                  ['Branch', ticket.branch ?? '—'], ['On-site', ticket.onSiteSupportRequired ? 'Yes' : 'No'], ['Created', fmtDate(ticket.createdAt)]] as [string, string][]).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2"><span className="text-slate-400">{k}</span><span className="font-medium text-slate-700 text-right truncate">{v}</span></div>
                ))}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="eyebrow inline-flex items-center gap-1.5"><Icons.eye className="w-3.5 h-3.5" />Watchers ({watchers.length})</p>
                  <button type="button" onClick={() => watchMut.mutate()} disabled={watchMut.isPending}
                    className={`text-xs font-semibold cursor-pointer ${isWatching ? 'text-slate-500 hover:text-slate-700' : 'text-brand hover:text-brand-700'}`}>
                    {isWatching ? 'Unwatch' : 'Watch'}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {watchers.map((w) => <span key={w.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium text-slate-600 bg-white ring-1 ring-slate-200"><Avatar name={w.name} size="xs" />{w.name}</span>)}
                  {watchers.length === 0 && <p className="text-xs text-slate-400">No watchers.</p>}
                </div>
              </div>

              <div>
                <p className="eyebrow mb-2">Activity</p>
                <div className="relative space-y-3 before:absolute before:left-[3px] before:top-1 before:bottom-1 before:w-px before:bg-slate-200">
                  {(activityData?.activity ?? []).map((a) => (
                    <div key={a.id} className="relative flex gap-2.5 text-[11px] pl-0">
                      <span className="w-[7px] h-[7px] rounded-full bg-slate-300 ring-2 ring-slate-50 mt-1 flex-shrink-0 relative z-10" />
                      <div className="min-w-0">
                        <p className="text-slate-600">
                          <span className="font-semibold text-slate-700">{a.user?.name ?? 'System'}</span>{' '}
                          {a.description || `${a.type.replace('_', ' ')}${a.field ? ` (${String(a.oldValue ?? '—')} → ${String(a.newValue ?? '—')})` : ''}`}
                        </p>
                        <p className="text-slate-400">{timeAgo(a.createdAt)}</p>
                      </div>
                    </div>
                  ))}
                  {(activityData?.activity.length ?? 0) === 0 && <p className="text-xs text-slate-400 pl-4">No activity.</p>}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </Drawer>
  );
}
