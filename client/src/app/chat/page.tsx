'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { orgsApi, chatApi, type ChatTurn } from '@/lib/api';
import { timeAgo } from '@/lib/display';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar, { icons } from '@/components/ui/Sidebar';
import { PageHeader } from '@/components/ui/PageHeader';
import Chatbot from '@/components/ui/Chatbot';
import { ShimmerRow } from '@/components/ui/Shimmer';
import { useAuth } from '@/contexts/AuthContext';
import type { Customer, ChatSessionDetail, ChatSessionSummary } from '@/lib/schemas';


// ─── Saved conversations ─────────────────────────────────────────────────────
// Every role that can reach /chat gets its history here. The list is scoped to
// the caller server-side (chat.service listSessions filters on userId), so this
// is the same component for a USER and an ADMINISTRATOR — no role branching.
function ChatHistoryRail({ activeId, onNewChat, onDeletedActive }: {
  activeId: string | null;
  onNewChat: () => void;
  onDeletedActive: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ sessions: ChatSessionSummary[] }>({
    queryKey: ['chat-sessions'],
    queryFn: () => chatApi.listSessions().then((r) => r.data as { sessions: ChatSessionSummary[] }),
    staleTime: 15_000,
  });
  const sessions = data?.sessions ?? [];

  async function remove(s: ChatSessionSummary) {
    const ok = await confirm({
      title: 'Delete conversation',
      message: <>&ldquo;{s.title ?? 'Untitled conversation'}&rdquo; and its {s.messageCount} message{s.messageCount === 1 ? '' : 's'} will be permanently deleted. This cannot be undone.</>,
      confirmText: 'Delete',
      variant: 'danger',
      // Ticking the box here skips the prompt for chat deletions only.
      rememberKey: 'chat-session-delete',
    });
    if (!ok) return;
    setBusyId(s.id);
    try {
      await chatApi.deleteSession(s.id);
      await queryClient.invalidateQueries({ queryKey: ['chat-sessions'] });
      // The open conversation just vanished — drop back to a fresh thread rather
      // than leaving the composer pointed at a session the server no longer has.
      if (s.id === activeId) onDeletedActive();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <aside className="hidden lg:flex w-72 flex-shrink-0 flex-col card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-900">Saved chats</h2>
        <button type="button" onClick={onNewChat}
          className="text-xs font-semibold text-brand hover:text-brand-700 transition-colors cursor-pointer">
          + New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {isLoading ? (
          <div className="space-y-2 p-2">{Array.from({ length: 4 }).map((_, i) => <ShimmerRow key={i} />)}</div>
        ) : sessions.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-slate-400">
            No saved conversations yet. Anything you ask is kept here until you delete it.
          </p>
        ) : (
          sessions.map((s) => {
            const active = s.id === activeId;
            return (
              <div key={s.id}
                className={`group flex items-start gap-1 rounded-lg px-2.5 py-2 transition-colors ${active ? 'bg-brand-50' : 'hover:bg-slate-50'}`}>
                <button type="button" onClick={() => router.push(`/chat?session=${s.id}`)}
                  className="min-w-0 flex-1 text-left cursor-pointer">
                  <p className={`truncate text-[13px] font-medium leading-snug ${active ? 'text-brand-700' : 'text-slate-800'}`}>
                    {s.title ?? 'Untitled conversation'}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400">{s.messageCount} messages · {timeAgo(s.updatedAt)}</p>
                </button>
                <button type="button" aria-label={`Delete ${s.title ?? 'conversation'}`}
                  disabled={busyId === s.id} onClick={() => void remove(s)}
                  className="mt-0.5 flex-shrink-0 rounded p-1 text-slate-300 opacity-0 transition-all hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40 cursor-pointer">
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatPageInner />
    </Suspense>
  );
}

function ChatPageInner() {
  const { user } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const resumeId = searchParams.get('session');
  const sessionIdRef = useRef<string | null>(resumeId);
  // Bumped by "New chat" so the Chatbot remounts fresh even when the URL is already /chat.
  const [chatEpoch, setChatEpoch] = useState(0);

  // Keep the active session in sync with the URL. Without this, navigating from
  // /chat?session=X to /chat keeps appending new messages to session X.
  useEffect(() => {
    sessionIdRef.current = resumeId;
  }, [resumeId]);

  const { data: org } = useQuery<Customer>({
    queryKey: ['org'],
    queryFn: () => orgsApi.getMe().then((r) => r.data as Customer),
    staleTime: 60_000,
  });

  // When resuming a conversation, load its prior turns to seed the thread.
  // gcTime: 0 — the Chatbot copies these into local state once at mount, so a
  // cached (stale) result would silently show an outdated transcript.
  const { data: resumed, isLoading: resumeLoading } = useQuery<ChatSessionDetail>({
    queryKey: ['chat-session', resumeId],
    queryFn: () => chatApi.getSession(resumeId!).then((r) => r.data as ChatSessionDetail),
    enabled: !!resumeId,
    staleTime: 0,
    gcTime: 0,
  });

  async function handleMessage(
    text: string,
    history: ChatTurn[],
    onToken?: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let fullReply = '';
      chatApi
        .stream(text, history, {
          sessionId: sessionIdRef.current ?? undefined,
          ...(signal ? { signal } : {}),
          onToken: (token) => {
            fullReply += token;
            onToken?.(token);
          },
          onSession: (id) => { sessionIdRef.current = id; },
          onDone: () => {
            // Keep the dashboard's Chat History fresh: the sessions list and this
            // session's cached transcript both changed with this turn.
            void queryClient.invalidateQueries({ queryKey: ['chat-sessions'] });
            if (sessionIdRef.current) {
              void queryClient.invalidateQueries({ queryKey: ['chat-session', sessionIdRef.current] });
            }
            resolve(fullReply);
          },
          onError: (msg) => reject(new Error(msg)),
        })
        .catch(reject);
    });
  }

  function startNewChat() {
    sessionIdRef.current = null;
    setChatEpoch((e) => e + 1);
    if (resumeId) router.replace('/chat');
  }

  const initialMessages = resumed?.messages.map((m) => ({
    role: m.role === 'USER' ? ('user' as const) : ('bot' as const),
    content: m.content,
    timestamp: new Date(m.createdAt).getTime(),
  }));

  return (
    <RoleGuard allowedRoles={['USER', 'ORG_ADMIN', 'ADMINISTRATOR']}>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <Sidebar />
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="px-8 pt-8 pb-4 flex-shrink-0">
            <div className="max-w-[1200px] mx-auto w-full">
              <PageHeader eyebrow="AI Assistant" title="Tech Assistant" icon={icons.chat}
                subtitle={resumeId
                  ? 'Resuming a saved conversation — your messages continue to be saved to history.'
                  : 'Describe an IT issue — printer, AD, proxy, VPN — or ask anything; conversations are saved to your history.'} />
            </div>
          </div>

          {/* History rail + chatbot fill the remaining height */}
          <div className="flex-1 overflow-hidden px-8 pb-8">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: 0.04 }}
              className="max-w-[1200px] mx-auto w-full h-full flex gap-6"
            >
              <ChatHistoryRail activeId={resumeId} onNewChat={startNewChat} onDeletedActive={startNewChat} />
              <div className="flex-1 min-w-0 h-full">
              {resumeId && resumeLoading ? (
                <div className="card h-full flex items-center justify-center text-sm text-slate-500">
                  Loading conversation…
                </div>
              ) : (
                <Chatbot
                  key={`${resumeId ?? 'new'}-${chatEpoch}`}
                  userName={user?.name}
                  orgName={org?.name}
                  onUserMessage={handleMessage}
                  initialMessages={initialMessages}
                  onNewChat={startNewChat}
                  className="h-full"
                />
              )}
              </div>
            </motion.div>
          </div>
        </main>
      </div>
    </RoleGuard>
  );
}
