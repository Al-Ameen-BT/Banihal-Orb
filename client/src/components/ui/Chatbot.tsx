'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Message {
  id: string;
  role: 'user' | 'bot';
  content: string;
  timestamp: number;
}

interface ChatbotProps {
  /** Optional — wire to a real backend (LLM, ticketing agent, etc.) later. */
  onUserMessage?: (text: string) => Promise<string>;
  /** Optional — personalize the greeting. */
  userName?: string;
  orgName?: string;
  /** Optional — override the default height. Pass `h-full`, `flex-1`, etc. */
  className?: string;
}

// Keyword-aware canned replies for the demo. Replace with a real LLM call later
// by passing the `onUserMessage` prop.
function pickReply(text: string, fallbackIdx: number): string {
  const t = text.toLowerCase();

  if (/(ticket|request|complaint|incident|issue)/.test(t)) {
    return "Sounds like something we should formalize. Use the **Create Support Ticket** panel on the left — pick the right priority and a CSM engineer will follow up within the SLA tied to your contract.";
  }
  if (/(service|expire|renew|subscri)/.test(t)) {
    return "Your subscribed services and their renewal dates are visible above. Anything tagged \"Expiring Soon\" renews within 30 days — only your Org Admin can confirm renewal pricing with the platform team.";
  }
  if (/(mfa|password|login|reset|access|locked)/.test(t)) {
    return "For account access issues, please contact your Org Admin. If they're unavailable, open a ticket marked HIGH priority and our platform team can assist.";
  }
  if (/(siem|edr|soc|threat|alert|detection)/.test(t)) {
    return "I can point you toward your security telemetry, but I can't query SIEM/EDR data directly. For real-time alerts, check your subscribed SIEM service. For investigations, the SOC-as-a-Service team responds via tickets.";
  }
  if (/(hello|hi|hey|good (morning|afternoon|evening))/.test(t)) {
    return "Hi! I'm the Tech assistant. I can help you understand your subscribed services, route questions to your team, or guide you through creating a ticket. What's on your mind?";
  }
  if (/(thank|thanks|appreciate)/.test(t)) {
    return "You're welcome! Anything else I can help with?";
  }
  if (/(bye|see you|later)/.test(t)) {
    return "Take care. If anything urgent comes up, the ticket form is always available — and a human is on the other end.";
  }

  // Rotation fallback for unknown queries
  const fallbacks = [
    "Got it — I've noted that. I'm a demo assistant, so for anything complex I'd recommend opening a ticket so a security engineer can follow up.",
    "Thanks for the message. For specific questions about your services or account, your Org Admin is your fastest path. For incidents or technical issues, the ticket form is right here.",
    "I'm here to help with quick questions about your dashboard, services, and how to reach your team. For deeper investigation, please use the ticket form.",
  ];
  return fallbacks[fallbackIdx % fallbacks.length]!;
}

// Render bot replies with simple **bold** markdown
function renderContent(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => p.startsWith('**') && p.endsWith('**')
    ? <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong>
    : <span key={i}>{p}</span>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function Chatbot({ onUserMessage, userName, orgName, className }: ChatbotProps) {
  const greeting = useMemo(() => {
    const who = userName ? `, ${userName.split(' ')[0]}` : '';
    const where = orgName ? ` at ${orgName}` : '';
    return `Hi${who}! I'm the Tech security assistant${where ? where : ''}. I can answer quick questions about your services, point you to your Org Admin or CSM team, and help you decide when to open a ticket. What can I help you with?`;
  }, [userName, orgName]);

  const [messages, setMessages] = useState<Message[]>(() => [{
    id: 'bot-greet',
    role: 'bot',
    content: greeting,
    timestamp: Date.now(),
  }]);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const fallbackCounter = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom on new messages or typing indicator
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, typing]);

  async function handleSend() {
    const text = input.trim();
    if (!text || typing) return;

    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', content: text, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setTyping(true);

    // Real backend call if provided, otherwise local canned reply with a small delay
    let replyText: string;
    try {
      if (onUserMessage) {
        replyText = await onUserMessage(text);
      } else {
        await new Promise((r) => setTimeout(r, 700 + Math.random() * 500));
        replyText = pickReply(text, fallbackCounter.current++);
      }
    } catch {
      replyText = "Sorry — I hit an error reaching the assistant. Please try again, or open a ticket if it's urgent.";
    }

    setMessages((prev) => [...prev, { id: `b-${Date.now()}`, role: 'bot', content: replyText, timestamp: Date.now() }]);
    setTyping(false);
    inputRef.current?.focus();
  }

  const quickPrompts = [
    "How do I open a ticket?",
    "What services are expiring?",
    "Who is my CSM?",
  ];

  return (
    <div className={`card flex flex-col overflow-hidden ${className ?? 'h-[640px]'}`}>
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 flex-shrink-0">
        <div className="relative w-10 h-10 rounded-full bg-gradient-to-br from-brand to-violet-600 flex items-center justify-center flex-shrink-0">
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.091 3.091zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
          </svg>
          <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-white animate-pulse-soft" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-slate-900 leading-tight">Tech Assistant</h3>
          <p className="text-xs text-slate-500">Online · usually responds instantly</p>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2 py-1 bg-slate-100 rounded-md">Demo</span>
      </div>

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4 bg-slate-50/40">
        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className={`flex gap-2.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'bot' && (
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand to-violet-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.091 3.091z" />
                  </svg>
                </div>
              )}
              <div className={`max-w-[80%] ${msg.role === 'user' ? 'order-first' : ''}`}>
                <div className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-brand text-white rounded-br-md'
                    : 'bg-white border border-slate-200 text-slate-800 rounded-bl-md shadow-xs'
                }`}>
                  {renderContent(msg.content)}
                </div>
                <p className={`text-[10px] text-slate-400 mt-1 ${msg.role === 'user' ? 'text-right pr-1' : 'pl-1'}`}>
                  {formatTime(msg.timestamp)}
                </p>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Typing indicator */}
        <AnimatePresence>
          {typing && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex gap-2.5 justify-start"
            >
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand to-violet-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.091 3.091z" />
                </svg>
              </div>
              <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-md px-4 py-3 flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Quick prompts (shown only when conversation is just the greeting) */}
      {messages.length === 1 && !typing && (
        <div className="px-5 pb-3 flex flex-wrap gap-2 flex-shrink-0">
          {quickPrompts.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => { setInput(q); inputRef.current?.focus(); }}
              className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-full hover:bg-slate-50 hover:border-slate-300 hover:text-slate-900 transition-colors cursor-pointer"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Input bar */}
      <form
        onSubmit={(e) => { e.preventDefault(); void handleSend(); }}
        className="flex items-center gap-2 px-4 py-3 border-t border-slate-100 bg-white flex-shrink-0"
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question or describe an issue…"
          className="flex-1 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-brand focus:bg-white transition-colors"
          disabled={typing}
          maxLength={500}
        />
        <button
          type="submit"
          disabled={!input.trim() || typing}
          className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-brand text-white hover:bg-brand-700 active:bg-brand-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          aria-label="Send message"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 12L3.269 3.125A59.769 59.769 0 0121.485 12 59.768 59.768 0 013.27 20.875L5.999 12zm0 0h7.5" />
          </svg>
        </button>
      </form>
    </div>
  );
}
