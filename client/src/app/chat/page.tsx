'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { orgsApi, chatApi, type ChatTurn } from '@/lib/api';
import RoleGuard from '@/components/guards/RoleGuard';
import Sidebar from '@/components/ui/Sidebar';
import Chatbot from '@/components/ui/Chatbot';
import { useAuth } from '@/contexts/AuthContext';
import type { Customer, ChatSessionDetail } from '@/lib/schemas';

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
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let fullReply = '';
      chatApi
        .stream(text, history, {
          sessionId: sessionIdRef.current ?? undefined,
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
            <div className="max-w-[900px] mx-auto w-full">
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
                <p className="text-sm text-slate-500 mb-1">AI Assistant</p>
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">Tech Assistant</h1>
                <p className="mt-1 text-sm text-slate-500">
                  {resumeId
                    ? 'Resuming a saved conversation — your messages continue to be saved to history.'
                    : 'Describe an IT issue — printer, AD, proxy, VPN — or ask anything; conversations are saved to your history.'}
                </p>
              </motion.div>
            </div>
          </div>

          {/* Chatbot fills remaining height */}
          <div className="flex-1 overflow-hidden px-8 pb-8">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: 0.04 }}
              className="max-w-[900px] mx-auto w-full h-full"
            >
              {resumeId && resumeLoading ? (
                <div className="card h-full flex items-center justify-center text-sm text-slate-500">
                  Loading conversation…
                </div>
              ) : (
                <Chatbot
                  key={`${resumeId ?? 'new'}-${chatEpoch}`}
                  userName={user?.name}
                  orgName={org?.name}
                  userRole={user?.role}
                  onUserMessage={handleMessage}
                  initialMessages={initialMessages}
                  onNewChat={startNewChat}
                  className="h-full"
                />
              )}
            </motion.div>
          </div>
        </main>
      </div>
    </RoleGuard>
  );
}
