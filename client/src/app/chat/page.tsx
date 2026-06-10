'use client';

import { Suspense, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
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
  const searchParams = useSearchParams();
  const resumeId = searchParams.get('session');
  const sessionIdRef = useRef<string | null>(resumeId);

  const { data: org } = useQuery<Customer>({
    queryKey: ['org'],
    queryFn: () => orgsApi.getMe().then((r) => r.data as Customer),
    staleTime: 60_000,
  });

  // When resuming a conversation, load its prior turns to seed the thread.
  const { data: resumed, isLoading: resumeLoading } = useQuery<ChatSessionDetail>({
    queryKey: ['chat-session', resumeId],
    queryFn: () => chatApi.getSession(resumeId!).then((r) => r.data as ChatSessionDetail),
    enabled: !!resumeId,
    staleTime: 0,
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
          onDone: () => resolve(fullReply),
          onError: (msg) => reject(new Error(msg)),
        })
        .catch(reject);
    });
  }

  const initialMessages = resumed?.messages.map((m) => ({
    role: m.role === 'USER' ? ('user' as const) : ('bot' as const),
    content: m.content,
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
                    : 'Ask quick questions, get pointed to the right team, or be guided to file a ticket.'}
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
                  key={resumeId ?? 'new'}
                  userName={user?.name}
                  orgName={org?.name}
                  onUserMessage={handleMessage}
                  initialMessages={initialMessages}
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
