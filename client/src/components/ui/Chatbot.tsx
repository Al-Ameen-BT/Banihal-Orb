'use client';

import { useState, useRef, useEffect, useMemo, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Message {
  id: string;
  role: 'user' | 'bot';
  content: string;
  timestamp: number;
}

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatbotProps {
  /**
   * Wire to a real backend. Receives prior turns for context.
   * If onToken is provided, the component renders tokens progressively as they arrive.
   */
  onUserMessage?: (
    text: string,
    history: ChatTurn[],
    onToken?: (token: string) => void,
  ) => Promise<string>;
  /** Seed the thread with a resumed conversation; replaces the greeting when non-empty. */
  initialMessages?: Array<{ role: 'user' | 'bot'; content: string }>;
  userName?: string;
  orgName?: string;
  className?: string;
}

// Keyword-aware canned replies for demo/offline mode (no onUserMessage prop)
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

  const fallbacks = [
    "Got it — I've noted that. I'm a demo assistant, so for anything complex I'd recommend opening a ticket so a security engineer can follow up.",
    "Thanks for the message. For specific questions about your services or account, your Org Admin is your fastest path. For incidents or technical issues, the ticket form is right here.",
    "I'm here to help with quick questions about your dashboard, services, and how to reach your team. For deeper investigation, please use the ticket form.",
  ];
  return fallbacks[fallbackIdx % fallbacks.length]!;
}

// ─── Lightweight markdown renderer for assistant replies ────────────────────
// Supports fenced ```code blocks```, inline `code`, **bold**, and numbered /
// bulleted lists — enough to match the agent's formatted output without a dep.

// Inline: **bold** and `code`, keeping plain text between.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => {
    if (!p) return null;
    if (p.startsWith('**') && p.endsWith('**')) {
      return <strong key={`${keyPrefix}-b${i}`} className="font-semibold">{p.slice(2, -2)}</strong>;
    }
    if (p.startsWith('`') && p.endsWith('`')) {
      return (
        <code key={`${keyPrefix}-c${i}`} className="px-1 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono text-[0.85em] text-slate-800">
          {p.slice(1, -1)}
        </code>
      );
    }
    return <span key={`${keyPrefix}-t${i}`}>{p}</span>;
  });
}

const ORDERED = /^\s*(\d+)\.\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;

// The agent often emits the whole answer on one line (steps and code fences
// inline). Insert line breaks so the structure parser can see lists/code blocks.
function normalizeMarkdown(text: string): string {
  let t = text.replace(/\r\n/g, '\n');
  // Put fenced-code delimiters on their own lines (keep the language on the opener).
  t = t.replace(/```([a-zA-Z0-9+#.\-]*)/g, '\n```$1\n');
  // Break inline numbered steps ("… 2. Foo") onto their own lines.
  t = t.replace(/([^\n])\s+(\d+\.\s+)/g, '$1\n$2');
  // Break inline " - " bullets onto their own lines (dashes inside words are safe).
  t = t.replace(/([^\n])\s+([-*]\s+)/g, '$1\n$2');
  return t.replace(/\n{3,}/g, '\n\n');
}

function renderContent(text: string): ReactNode[] {
  const lines = normalizeMarkdown(text).split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      i++; // skip opening fence (language hint ignored — no syntax highlighting)
      const codeLines: string[] = [];
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
        codeLines.push(lines[i] ?? '');
        i++;
      }
      i++; // skip closing fence
      const code = codeLines.join('\n').replace(/^\n+|\n+$/g, '');
      if (code.trim()) {
        out.push(
          <pre key={`code${k++}`} className="my-2 p-3 rounded-lg bg-slate-50 border border-slate-200 overflow-x-auto">
            <code className="font-mono text-xs text-slate-800 whitespace-pre-wrap break-words">{code}</code>
          </pre>,
        );
      }
      continue;
    }

    // Ordered list — preserve the real numbers so they stay correct even if a
    // code block interrupts the sequence.
    let om = line.match(ORDERED);
    if (om) {
      const items: Array<{ n: string; text: string }> = [];
      while (om) {
        items.push({ n: om[1] ?? '', text: om[2] ?? '' });
        i++;
        om = i < lines.length ? (lines[i] ?? '').match(ORDERED) : null;
      }
      out.push(
        <div key={`ol${k++}`} className="my-1.5 space-y-1.5">
          {items.map((it, j) => (
            <div key={j} className="flex gap-2">
              <span className="font-semibold text-slate-500 tabular-nums flex-shrink-0">{it.n}.</span>
              <span className="flex-1">{renderInline(it.text, `ol${k}i${j}`)}</span>
            </div>
          ))}
        </div>,
      );
      continue;
    }

    // Bulleted list
    let bm = line.match(BULLET);
    if (bm) {
      const items: string[] = [];
      while (bm) {
        items.push(bm[1] ?? '');
        i++;
        bm = i < lines.length ? (lines[i] ?? '').match(BULLET) : null;
      }
      out.push(
        <ul key={`ul${k++}`} className="list-disc pl-5 my-1.5 space-y-1">
          {items.map((it, j) => <li key={j}>{renderInline(it, `ul${k}i${j}`)}</li>)}
        </ul>,
      );
      continue;
    }

    if (!line.trim()) { i++; continue; }

    // Paragraph — gather consecutive plain lines.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (!l.trim() || l.trimStart().startsWith('```') || ORDERED.test(l) || BULLET.test(l)) break;
      para.push(l);
      i++;
    }
    out.push(
      <p key={`p${k++}`} className="my-1 first:mt-0 last:mb-0 leading-relaxed">
        {para.map((pl, j) => <span key={j}>{renderInline(pl, `p${k}l${j}`)}{j < para.length - 1 ? <br /> : null}</span>)}
      </p>,
    );
  }

  return out;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function Chatbot({ onUserMessage, initialMessages, userName, orgName, className }: ChatbotProps) {
  const greeting = useMemo(() => {
    const who = userName ? `, ${userName.split(' ')[0]}` : '';
    const where = orgName ? ` at ${orgName}` : '';
    return `Hi${who}! I'm the Tech security assistant${where ? where : ''}. I can answer quick questions about your services, point you to your Org Admin or CSM team, and help you decide when to open a ticket. What can I help you with?`;
  }, [userName, orgName]);

  const [messages, setMessages] = useState<Message[]>(() => {
    if (initialMessages && initialMessages.length > 0) {
      return initialMessages.map((m, i) => ({
        id: `seed-${i}`,
        role: m.role,
        content: m.content,
        timestamp: Date.now(),
      }));
    }
    return [{ id: 'bot-greet', role: 'bot', content: greeting, timestamp: Date.now() }];
  });
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const fallbackCounter = useRef(0);
  const streamingIdRef = useRef<string>('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

    const history: ChatTurn[] = messages
      .filter((m) => m.id !== 'bot-greet')
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

    try {
      if (onUserMessage) {
        let firstToken = true;

        await onUserMessage(text, history, (token) => {
          if (firstToken) {
            firstToken = false;
            const id = `b-${Date.now()}`;
            streamingIdRef.current = id;
            setStreamingMsgId(id);
            setMessages((prev) => [...prev, { id, role: 'bot', content: token, timestamp: Date.now() }]);
            setTyping(false);
          } else {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingIdRef.current ? { ...m, content: m.content + token } : m,
              ),
            );
          }
        });

        // Handle non-streaming fallback: onUserMessage resolved but no tokens were fired
        if (firstToken) {
          setMessages((prev) => [...prev, {
            id: `b-${Date.now()}`,
            role: 'bot',
            content: "Sorry — the assistant returned an empty response. Please try again.",
            timestamp: Date.now(),
          }]);
          setTyping(false);
        }
      } else {
        // Demo/offline mode
        await new Promise((r) => setTimeout(r, 700 + Math.random() * 500));
        const replyText = pickReply(text, fallbackCounter.current++);
        setMessages((prev) => [...prev, { id: `b-${Date.now()}`, role: 'bot', content: replyText, timestamp: Date.now() }]);
        setTyping(false);
      }
    } catch {
      const errMsg = "Sorry — I hit an error reaching the assistant. Please try again, or open a ticket if it's urgent.";
      if (streamingIdRef.current) {
        setMessages((prev) =>
          prev.map((m) => m.id === streamingIdRef.current ? { ...m, content: errMsg } : m),
        );
      } else {
        setMessages((prev) => [...prev, { id: `b-${Date.now()}`, role: 'bot', content: errMsg, timestamp: Date.now() }]);
        setTyping(false);
      }
    } finally {
      setStreamingMsgId(null);
      streamingIdRef.current = '';
      inputRef.current?.focus();
    }
  }

  const quickPrompts = [
    "How do I open a ticket?",
    "What services are expiring?",
    "Who is my CSM?",
  ];

  const isLive = !!onUserMessage;

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
        {isLive ? (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 px-2 py-1 bg-emerald-50 rounded-md">Live</span>
        ) : (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2 py-1 bg-slate-100 rounded-md">Demo</span>
        )}
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
                  {/* Blinking cursor while this message is still streaming */}
                  {streamingMsgId === msg.id && (
                    <span className="inline-block w-0.5 h-3.5 bg-slate-400 opacity-75 animate-pulse ml-0.5 align-middle rounded-full" />
                  )}
                </div>
                <p className={`text-[10px] text-slate-400 mt-1 ${msg.role === 'user' ? 'text-right pr-1' : 'pl-1'}`}>
                  {formatTime(msg.timestamp)}
                </p>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Typing indicator — shown while waiting for the first token */}
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

      {/* Quick prompts — shown only on the initial greeting */}
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
          disabled={typing || !!streamingMsgId}
          maxLength={500}
        />
        <button
          type="submit"
          disabled={!input.trim() || typing || !!streamingMsgId}
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
