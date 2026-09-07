'use client';

import { useState, useRef, useEffect, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ticketingApi } from '@/lib/api';
import { useTicketProjects } from '@/app/ticketing/shared';
import type { TicketType, TicketPriority, TicketDTO } from '@/lib/schemas';

interface TicketMeta {
  ticketNumber: string;
  title: string;
  priority: string;
  type: string;
  projectName: string | null;
}

interface Message {
  id: string;
  role: 'user' | 'bot';
  content: string;
  timestamp: number;
  ticketMeta?: TicketMeta;
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
    signal?: AbortSignal,
  ) => Promise<string>;
  /** Seed the thread with a resumed conversation; replaces the greeting when non-empty. */
  initialMessages?: Array<{ role: 'user' | 'bot'; content: string; timestamp?: number }>;
  /** Called when the user clicks "New chat" in the header. */
  onNewChat?: () => void;
  userName?: string;
  orgName?: string;
  className?: string;
}

// Server-side limits on POST /api/chat — exceeding either returns 400.
const MAX_HISTORY_TURNS = 20;
const MAX_TURN_CHARS = 2000;

// ─── Common IT-issue quick prompts (auto-send on click) ──────────────────────
const QUICK_PROMPTS: Array<{ label: string; text: string; dot: string }> = [
  { label: 'Printer not working',  dot: 'bg-rose-500',
    text: 'My printer is not working — it shows offline and nothing prints. How do I fix it?' },
  { label: 'AD account issue',     dot: 'bg-violet-500',
    text: 'I have an Active Directory issue — my AD account appears locked and I cannot sign in to the domain.' },
  { label: 'Proxy issues',         dot: 'bg-cyan-500',
    text: 'I am having proxy issues — websites are not loading through the company proxy.' },
  { label: 'VPN keeps dropping',   dot: 'bg-amber-500',
    text: 'My VPN keeps disconnecting every few minutes. What should I check?' },
  { label: 'Outlook not syncing',  dot: 'bg-emerald-500',
    text: 'Outlook is not syncing new emails on my system. How can I resolve this?' },
];

// ─── Ticket form option sets ─────────────────────────────────────────────────
const TK_TYPES: { value: TicketType; label: string }[] = [
  { value: 'task', label: 'Task' }, { value: 'bug', label: 'Bug' },
  { value: 'story', label: 'Story' }, { value: 'feature', label: 'Feature' },
];
const TK_PRIORITIES: { value: TicketPriority; label: string }[] = [
  { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' },
];
const TK_PRI_CLS: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600 ring-slate-500/15',
  medium: 'bg-cyan-50 text-cyan-700 ring-cyan-600/15',
  high: 'bg-amber-50 text-amber-700 ring-amber-600/15',
  urgent: 'bg-red-50 text-red-700 ring-red-600/15',
};
const TK_PRI_DOT: Record<string, string> = {
  low: 'bg-slate-400', medium: 'bg-cyan-500', high: 'bg-amber-500', urgent: 'bg-red-500',
};

// Keyword-aware canned replies for demo/offline mode (no onUserMessage prop)
function pickReply(text: string, fallbackIdx: number): string {
  const t = text.toLowerCase();

  if (/(printer|printing|print job)/.test(t)) {
    return "Let's get the printer back online: 1. Power-cycle the printer and check the network/USB cable. 2. On your PC open **Settings → Devices → Printers**, remove any stuck jobs in the queue. 3. Set the correct printer as default — \"offline\" usually clears after a queue reset. If it stays offline, open a **MEDIUM** ticket with the printer name and our IT team will re-add the driver remotely.";
  }
  if (/(active directory|\bad\b|account locked|domain login|domain account)/.test(t)) {
    return "AD sign-in issues are usually a locked or expired account. 1. Wait 15 minutes — standard lockout auto-releases. 2. If you recently changed your password, update it everywhere it's saved (phone mail, mapped drives) — stale credentials re-lock the account. 3. Still locked? Your Org Admin can unlock it, or open a **HIGH** ticket and our team will reset it within the SLA.";
  }
  if (/(proxy|blocked site|sites? not loading|firewall)/.test(t)) {
    return "For proxy problems: 1. Check **Settings → Network → Proxy** matches your company-issued PAC/proxy address. 2. Try a known-internal site — if internal works but external doesn't, it's a proxy rule, not your machine. 3. Note the exact error (407 = auth, timeout = reachability) and open a ticket with the failing URL; the network team can whitelist or fix the rule.";
  }
  if (/(vpn|tunnel|anyconnect|globalprotect)/.test(t)) {
    return "VPN drops are commonly local network or client-version issues: 1. Switch networks (hotspot test) to rule out your router/ISP. 2. Update the VPN client — old versions drop on token refresh. 3. If it drops at a fixed interval, that's a session timeout policy — open a ticket with the timestamp pattern and we'll check the gateway logs.";
  }
  if (/(outlook|email|mailbox|exchange)/.test(t)) {
    return "For Outlook sync issues: 1. Check the status bar — \"Working Offline\" gets toggled by accident more than you'd think. 2. **Send/Receive → Update Folder**, then restart Outlook. 3. If webmail shows the new mail but Outlook doesn't, rebuild the OST: ticket it as **MEDIUM** and IT will guide you through the profile reset.";
  }
  if (/(ticket|request|complaint|incident|issue)/.test(t)) {
    return "Sounds like something we should formalize. Use the **Support** page to create a ticket — pick the right priority and an engineer will follow up within the SLA tied to your contract.";
  }
  if (/(service|expire|renew|subscri)/.test(t)) {
    return "Your subscribed services and their renewal dates are visible on the dashboard. Anything tagged \"Expiring Soon\" renews within 30 days — only your Org Admin can confirm renewal pricing with the platform team.";
  }
  if (/(mfa|password|login|reset|access|locked)/.test(t)) {
    return "For account access issues, please contact your Org Admin. If they're unavailable, open a ticket marked HIGH priority and our platform team can assist.";
  }
  if (/(hello|hi|hey|good (morning|afternoon|evening))/.test(t)) {
    return "Hi! I'm the Tech IT assistant. Tell me what's broken — printer, AD sign-in, proxy, VPN, email — or ask about your services and tickets. What's going on?";
  }
  if (/(thank|thanks|appreciate)/.test(t)) {
    return "You're welcome! Anything else I can help with?";
  }
  if (/(bye|see you|later)/.test(t)) {
    return "Take care. If anything urgent comes up, the Ticketing page is always available — and a human is on the other end.";
  }

  const fallbacks = [
    "Got it — I've noted that. I'm a demo assistant, so for anything complex I'd recommend opening a ticket so an engineer can follow up.",
    "Thanks for the message. For specific questions about your services or account, your Org Admin is your fastest path. For incidents or technical issues, the Ticketing page is right there.",
    "I'm here to help with quick IT questions — printers, AD, proxy, VPN, email — plus your services and tickets. For deeper investigation, please use the ticket form.",
  ];
  return fallbacks[fallbackIdx % fallbacks.length]!;
}

// ─── Lightweight markdown renderer for assistant replies ────────────────────
// Supports fenced ```code blocks```, inline `code`, **bold**, and numbered /
// bulleted lists — enough to match the agent's formatted output without a dep.

// Inline: **bold** and `code`, keeping plain text between.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g).map((p, i) => {
    if (!p) return null;
    // [label](url) — the agent links to docs; a raw markdown link in the bubble is
    // something the reader has to copy by hand, so make it clickable.
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
    if (link) {
      return (
        <a key={`${keyPrefix}-l${i}`} href={link[2]} target="_blank" rel="noreferrer noopener"
          className="font-medium text-brand underline underline-offset-2 hover:text-brand-700">
          {link[1]}
        </a>
      );
    }
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
const BULLET = /^(\s*)[-*]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
// A bullet indented by two or more spaces belongs to the step above it — that is
// exactly the shape the agent emits ("1. **Check cables:**" then "    * …").
const isNested = (line: string): boolean => {
  const m = BULLET.exec(line);
  return !!m && (m[1] ?? '').length >= 2;
};

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

    // Heading — rendered as a strong line, not an <h*>: these sit inside a chat
    // bubble, where a 24px document heading looks broken.
    const hm = line.match(HEADING);
    if (hm) {
      out.push(
        <p key={`h${k++}`} className="mt-2.5 mb-1 first:mt-0 text-[13px] font-semibold text-slate-900">
          {renderInline(hm[1] ?? '', `h${k}`)}
        </p>,
      );
      i++;
      continue;
    }

    // Ordered list — preserve the real numbers so they stay correct even if a
    // code block interrupts the sequence.
    let om = line.match(ORDERED);
    if (om) {
      const items: Array<{ n: string; text: string; sub: string[] }> = [];
      while (om) {
        const sub: string[] = [];
        items.push({ n: om[1] ?? '', text: om[2] ?? '', sub });
        i++;
        // Pull the step's own indented bullets in with it, so they render under
        // the number instead of breaking the list into a separate flat one.
        while (i < lines.length && isNested(lines[i] ?? '')) {
          sub.push(BULLET.exec(lines[i] ?? '')?.[2] ?? '');
          i++;
        }
        om = i < lines.length ? (lines[i] ?? '').match(ORDERED) : null;
      }
      out.push(
        <div key={`ol${k++}`} className="my-1.5 space-y-2">
          {items.map((it, j) => (
            <div key={j} className="flex gap-2">
              <span className="font-semibold text-slate-500 tabular-nums flex-shrink-0">{it.n}.</span>
              <div className="flex-1 min-w-0">
                <span>{renderInline(it.text, `ol${k}i${j}`)}</span>
                {it.sub.length > 0 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 marker:text-slate-300">
                    {it.sub.map((sb, m) => <li key={m}>{renderInline(sb, `ol${k}i${j}s${m}`)}</li>)}
                  </ul>
                )}
              </div>
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
        items.push(bm[2] ?? '');
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
      if (!l.trim() || l.trimStart().startsWith('```') || ORDERED.test(l) || BULLET.test(l) || HEADING.test(l)) break;
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

function BotAvatar({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const wrap = size === 'md' ? 'w-10 h-10' : 'w-7 h-7 mt-0.5';
  const icon = size === 'md' ? 'w-5 h-5' : 'w-3.5 h-3.5';
  return (
    <div className={`relative ${wrap} rounded-full bg-gradient-to-br from-brand to-violet-600 flex items-center justify-center flex-shrink-0`}>
      <svg className={`${icon} text-white`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.091 3.091z" />
      </svg>
      {size === 'md' && <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-white animate-pulse-soft" />}
    </div>
  );
}

// ─── Ticket confirmation card (shown inline in the chat thread) ──────────────
function TicketCreatedCard({ meta }: { meta: TicketMeta }) {
  const priCls = TK_PRI_CLS[meta.priority] ?? TK_PRI_CLS['medium']!;
  const priDot = TK_PRI_DOT[meta.priority] ?? TK_PRI_DOT['medium']!;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-emerald-600">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        </svg>
        <span className="text-xs font-bold uppercase tracking-wider">Ticket Created</span>
      </div>
      <div className="rounded-lg bg-slate-50/80 border border-slate-200 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs font-bold text-brand">{meta.ticketNumber}</span>
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold ring-1 ring-inset ${priCls}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${priDot}`} />
            {meta.priority.charAt(0).toUpperCase() + meta.priority.slice(1)}
          </span>
        </div>
        <p className="text-sm font-semibold text-slate-800 leading-snug">{meta.title}</p>
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 font-semibold text-slate-600">
            {meta.type.charAt(0).toUpperCase() + meta.type.slice(1)}
          </span>
          {meta.projectName && <span className="truncate">· {meta.projectName}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── "Thinking" pill ─────────────────────────────────────────────────────────
// The agent answers in one shot, so this owns the whole wait — now bounded by the
// 15s server deadline. Deliberately small: an icon, one word, and a stop. A big
// skeleton block over-promises ("your answer is nearly rendered") for something
// that is really just a request in flight, and a ticking seconds counter makes the
// reader watch the clock, which is the opposite of what this is for.
const THINKING_STAGES: { at: number; label: string; icon: ReactNode }[] = [
  {
    at: 0, label: 'Thinking',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2m9-9h-2M5 12H3m14.5-6.5-1.4 1.4M7.9 16.1l-1.4 1.4m11.2 0-1.4-1.4M7.9 7.9 6.5 6.5" />,
  },
  {
    at: 2_000, label: 'Searching',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z" />,
  },
  {
    at: 5_000, label: 'Checking docs',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.25C10.5 5 8.5 4.75 6 5.25v12c2.5-.5 4.5-.25 6 1 1.5-1.25 3.5-1.5 6-1v-12c-2.5-.5-4.5-.25-6 1.5Zm0 0v12" />,
  },
  {
    at: 9_000, label: 'Writing',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 4.5a2.12 2.12 0 0 1 3 3L8 19l-4 1 1-4 11.5-11.5Z" />,
  },
  {
    at: 13_000, label: 'Almost there',
    icon: <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l3.5 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
  },
];

function ThinkingPill({ onStop }: { onStop: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Date.now() - started), 300);
    return () => window.clearInterval(id);
  }, []);

  const stage = THINKING_STAGES.filter((st) => elapsed >= st.at).pop() ?? THINKING_STAGES[0]!;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: reduce ? 0 : 0.15 }}
      className="flex gap-2.5 justify-start"
    >
      <BotAvatar />
      <div className="inline-flex items-center gap-2 self-center rounded-full border border-slate-200 bg-white px-3 py-1.5 shadow-sm">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={stage.label}
            initial={{ opacity: 0, y: reduce ? 0 : 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : -5 }}
            transition={{ duration: reduce ? 0 : 0.18 }}
            className="inline-flex items-center gap-1.5"
          >
            <svg className={`h-3.5 w-3.5 text-brand ${reduce ? '' : 'animate-pulse-soft'}`} fill="none"
              stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden="true">
              {stage.icon}
            </svg>
            {/* aria-live: the stage word is the status, so a screen reader hears it too */}
            <span className="text-[12px] font-medium text-slate-600" aria-live="polite">{stage.label}</span>
          </motion.span>
        </AnimatePresence>

        <span className="flex gap-0.5" aria-hidden="true">
          <span className="h-1 w-1 rounded-full bg-brand/60 animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="h-1 w-1 rounded-full bg-brand/60 animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="h-1 w-1 rounded-full bg-brand/60 animate-bounce" style={{ animationDelay: '300ms' }} />
        </span>

        <button type="button" onClick={onStop}
          className="ml-0.5 border-l border-slate-200 pl-2 text-[11px] font-semibold text-slate-400 transition-colors hover:text-red-600 cursor-pointer">
          Stop
        </button>
      </div>
    </motion.div>
  );
}

export default function Chatbot({ onUserMessage, initialMessages, onNewChat, userName, orgName, className }: ChatbotProps) {
  const queryClient = useQueryClient();

  const greeting = useMemo(() => {
    const who = userName ? `, ${userName.split(' ')[0]}` : '';
    const where = orgName ? ` at ${orgName}` : '';
    return `Hi${who}! I'm the Tech IT assistant${where}. Tell me what's broken — printer, AD sign-in, proxy, VPN, email — or ask about your services and tickets. What can I help you with?`;
  }, [userName, orgName]);

  const [messages, setMessages] = useState<Message[]>(() => {
    if (initialMessages && initialMessages.length > 0) {
      return initialMessages.map((m, i) => ({
        id: `seed-${i}`,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp ?? Date.now(),
      }));
    }
    return [{ id: 'bot-greet', role: 'bot', content: greeting, timestamp: Date.now() }];
  });
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const fallbackCounter = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const revealRef = useRef<number | null>(null);
  const fullTextRef = useRef('');
  const streamingIdRef = useRef<string>('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Reply reveal ─────────────────────────────────────────────────────────
  // The agent returns the entire answer in ONE frame — its connection guide is
  // explicit that there is nothing to stream — so the reveal is built here, which
  // is what the guide tells integrators to do. Chunks are sized to finish in about
  // a second whatever the length, so a long answer is not slower to read than a
  // short one; the point is that the first line is in front of the reader while
  // the rest lands, instead of a wall of text appearing at once.
  function stopReveal(flushInto?: string): void {
    if (revealRef.current !== null) {
      window.clearInterval(revealRef.current);
      revealRef.current = null;
    }
    if (flushInto) {
      const full = fullTextRef.current;
      setMessages((prev) => prev.map((m) => (m.id === flushInto ? { ...m, content: full } : m)));
    }
  }

  function startReveal(id: string): void {
    stopReveal();
    let shown = 0;
    revealRef.current = window.setInterval(() => {
      const full = fullTextRef.current;
      // Split on whitespace but KEEP it, so the joined prefix is the original text.
      const words = full.split(/(\s+)/);
      shown += Math.max(2, Math.ceil(words.length / 40));
      const done = shown >= words.length;
      const text = done ? full : words.slice(0, shown).join('');
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: text } : m)));
      if (done) stopReveal();
    }, 25);
  }

  // Never leave an interval running behind a closed chat.
  useEffect(() => () => stopReveal(), []);

  // ── Ticket form state ────────────────────────────────────────────────────
  const [showTicketForm, setShowTicketForm] = useState(false);
  const [tkTitle, setTkTitle] = useState('');
  const [tkDesc, setTkDesc] = useState('');
  const [tkProjectId, setTkProjectId] = useState('');
  const [tkType, setTkType] = useState<TicketType>('task');
  const [tkPriority, setTkPriority] = useState<TicketPriority>('medium');
  const [tkSubmitting, setTkSubmitting] = useState(false);
  const [tkError, setTkError] = useState<string | null>(null);

  // Fetch projects on-demand when the ticket form opens. Shares the ['ticketing',
  // 'projects'] cache entry with the ticketing views, so it MUST go through the same
  // hook — an inline query here with a different shape is what emptied their project
  // pickers.
  const { data: tkProjects } = useTicketProjects(showTicketForm);

  // The org/user queries usually resolve after first paint — refresh the greeting
  // in place so it doesn't permanently miss the org name.
  useEffect(() => {
    setMessages((prev) =>
      prev.length === 1 && prev[0]?.id === 'bot-greet' && prev[0].content !== greeting
        ? [{ ...prev[0], content: greeting }]
        : prev,
    );
  }, [greeting]);

  // Instant scroll while tokens stream (smooth scrolling lags behind), smooth otherwise.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: streamingMsgId ? 'auto' : 'smooth' });
    }
  }, [messages, typing, streamingMsgId]);

  // Restore focus once the input is re-enabled (focusing a disabled input is a no-op).
  useEffect(() => {
    if (!typing && !streamingMsgId) inputRef.current?.focus();
  }, [typing, streamingMsgId]);

  const busy = typing || !!streamingMsgId || tkSubmitting;

  async function sendText(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;

    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', content: text, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setTyping(true);

    // Cap to the server's limits (20 turns × 2000 chars) — exceeding either 400s.
    const history: ChatTurn[] = messages
      .filter((m) => m.id !== 'bot-greet' && m.content.trim().length > 0 && !m.ticketMeta)
      .map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.content.slice(0, MAX_TURN_CHARS),
      }))
      .slice(-MAX_HISTORY_TURNS);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      if (onUserMessage) {
        let firstToken = true;

        await onUserMessage(text, history, (token) => {
          if (firstToken) {
            firstToken = false;
            const id = `b-${Date.now()}`;
            streamingIdRef.current = id;
            setStreamingMsgId(id);
            fullTextRef.current = token;
            setMessages((prev) => [...prev, { id, role: 'bot', content: '', timestamp: Date.now() }]);
            setTyping(false);
            startReveal(id);
          } else {
            // A genuinely streaming transport would land here; grow the target and
            // let the same reveal loop keep pace with it.
            fullTextRef.current += token;
            if (revealRef.current === null) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === streamingIdRef.current ? { ...m, content: fullTextRef.current } : m,
                ),
              );
            }
          }
        }, controller.signal);

        // Stopped by the user: keep whatever arrived, say so if nothing did.
        if (controller.signal.aborted) {
          setTyping(false);
          if (firstToken) {
            setMessages((prev) => [...prev, {
              id: `b-${Date.now()}`, role: 'bot',
              content: "Stopped. Ask me again whenever you're ready.",
              timestamp: Date.now(),
            }]);
          }
        } else if (firstToken) {
          // Non-streaming fallback: onUserMessage resolved but no tokens were fired
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
    } catch (err) {
      stopReveal();
      // Prefer the server's own words: "took longer than 15s to answer" tells the
      // user what to do next, where a generic failure line does not.
      const detail = err instanceof Error ? err.message.trim() : '';
      const errMsg = detail
        ? `${detail}. If it keeps happening, open a ticket and a person will pick it up.`
        : "Sorry — I hit an error reaching the assistant. Please try again, or open a ticket if it's urgent.";
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
      abortRef.current = null;
    }
  }

  // The reply can legitimately run for minutes; the user must be able to bail out
  // of one without reloading the page. Aborting ends the stream quietly — the
  // request is cancelled client-side, and the turn already saved server-side stays
  // in history, so the conversation is still resumable.
  function stopReply() {
    abortRef.current?.abort();
    // Mid-reveal, "Stop" means "don't make me wait for the animation" — flush the
    // text that already arrived rather than freezing it half-written.
    if (revealRef.current !== null && streamingIdRef.current) stopReveal(streamingIdRef.current);
  }

  // ── Ticket form handlers ─────────────────────────────────────────────────
  function openTicketForm() {
    // Pre-populate description from recent chat context so the support team
    // has visibility into what was discussed before the ticket was raised.
    const recent = messages.filter((m) => m.id !== 'bot-greet' && !m.ticketMeta).slice(-4);
    if (recent.length > 0) {
      const context = recent
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 300)}`)
        .join('\n\n');
      setTkDesc(`Chat context:\n${context}`);
    } else {
      setTkDesc('');
    }
    setTkTitle('');
    setTkProjectId('');
    setTkType('task');
    setTkPriority('medium');
    setTkError(null);
    setShowTicketForm(true);
  }

  function closeTicketForm() {
    setShowTicketForm(false);
    setTkError(null);
  }

  // The ticket form is a modal: lock body scroll while open and close on Escape.
  useEffect(() => {
    if (!showTicketForm) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeTicketForm(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTicketForm]);

  async function handleCreateTicket(e: React.FormEvent | React.MouseEvent) {
    e.preventDefault();
    if (!tkTitle.trim() || !tkDesc.trim() || !tkProjectId || tkSubmitting) return;
    setTkSubmitting(true);
    setTkError(null);
    try {
      const payload: Record<string, unknown> = {
        title: tkTitle.trim(),
        description: tkDesc.trim(),
        projectId: tkProjectId,
        type: tkType,
        priority: tkPriority,
      };
      // ORG_ADMIN and ADMINISTRATOR can set status; default to 'todo' for in-chat tickets.
      const { data } = await ticketingApi.createTicket(payload);
      const ticket = data as TicketDTO;

      // Insert a ticket confirmation card as a bot message.
      setMessages((prev) => [...prev, {
        id: `tk-${Date.now()}`,
        role: 'bot',
        content: `Ticket ${ticket.ticketNumber} created.`,
        timestamp: Date.now(),
        ticketMeta: {
          ticketNumber: ticket.ticketNumber,
          title: ticket.title,
          priority: ticket.priority,
          type: ticket.type,
          projectName: ticket.projectName,
        },
      }]);

      // Close the form.
      setShowTicketForm(false);

      // Invalidate ticketing cache so the Ticketing page reflects the new ticket.
      await queryClient.invalidateQueries({ queryKey: ['ticketing'] });
    } catch {
      setTkError('Could not create the ticket. Please try again.');
    } finally {
      setTkSubmitting(false);
    }
  }

  const isLive = !!onUserMessage;
  const showPrompts = messages.length === 1 && messages[0]?.id === 'bot-greet' && !typing;
  const inConversation = messages.some((m) => m.id !== 'bot-greet');

  return (
    <div className={`card flex flex-col overflow-hidden ${className ?? 'h-[640px]'}`}>
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 flex-shrink-0">
        <BotAvatar size="md" />
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-slate-900 leading-tight">Tech Assistant</h3>
          <p className="text-xs text-slate-500">IT support &amp; quick answers · responds instantly</p>
        </div>
        {onNewChat && inConversation && (
          <button
            type="button"
            onClick={onNewChat}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-600 bg-slate-50 border border-slate-200 hover:bg-slate-100 hover:text-slate-900 transition-colors cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            New chat
          </button>
        )}
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
              {msg.role === 'bot' && <BotAvatar />}
              <div className={`max-w-[80%] ${msg.role === 'user' ? 'order-first' : ''}`}>
                <div className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-brand text-white rounded-br-md'
                    : 'bg-white border border-slate-200 text-slate-800 rounded-bl-md shadow-xs'
                }`}>
                  {msg.ticketMeta ? (
                    <TicketCreatedCard meta={msg.ticketMeta} />
                  ) : (
                    <>
                      {renderContent(msg.content)}
                      {/* Blinking cursor while this message is still streaming */}
                      {streamingMsgId === msg.id && (
                        <span className="inline-block w-0.5 h-3.5 bg-slate-400 opacity-75 animate-pulse ml-0.5 align-middle rounded-full" />
                      )}
                    </>
                  )}
                </div>
                <p className={`text-[10px] text-slate-400 mt-1 ${msg.role === 'user' ? 'text-right pr-1' : 'pl-1'}`}>
                  {formatTime(msg.timestamp)}
                </p>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Common IT issues — shown only on the initial greeting, auto-send on click */}
        {showPrompts && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: 0.1 }} className="pl-9">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400 mb-2">Common IT issues</p>
            <div className="flex flex-wrap gap-2">
              {QUICK_PROMPTS.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => void sendText(q.text)}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-full hover:bg-slate-50 hover:border-slate-300 hover:text-slate-900 transition-colors cursor-pointer"
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${q.dot}`} />
                  {q.label}
                </button>
              ))}
            </div>
          </motion.div>
        )}

        {/* Typing indicator — shown while waiting for the first token */}
        <AnimatePresence>
          {typing && <ThinkingPill onStop={stopReply} />}
        </AnimatePresence>
      </div>

      {/* ── Ticket creation modal (pops over the app) ─────────────────────────── */}
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {showTicketForm && (
            <motion.div
              className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={closeTicketForm} aria-hidden="true" />
              <motion.div
                role="dialog" aria-modal="true" aria-labelledby="chat-tk-heading"
                initial={{ opacity: 0, scale: 0.97, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: 8 }}
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                className="relative w-full max-w-lg max-h-[92vh] overflow-y-auto bg-white shadow-2xl ring-1 ring-slate-900/5 rounded-t-2xl sm:rounded-2xl"
              >
                {/* Header */}
                <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-4 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 ring-1 ring-brand-200/60 flex items-center justify-center flex-shrink-0">
                      <svg className="w-5 h-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 0 1 0 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 0 1 0-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375Z" />
                      </svg>
                    </div>
                    <div>
                      <h4 id="chat-tk-heading" className="text-base font-bold text-slate-900 leading-tight">Create Ticket</h4>
                      <span className="text-[11px] text-slate-400 font-medium">from this conversation</span>
                    </div>
                  </div>
                  <button type="button" onClick={closeTicketForm}
                    className="text-slate-400 hover:text-slate-600 cursor-pointer p-1.5 rounded-lg hover:bg-slate-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40" aria-label="Close ticket form">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                <form onSubmit={handleCreateTicket} className="px-5 py-4 space-y-4">
                  {/* Title */}
                  <div>
                    <label htmlFor="chat-tk-title" className="block text-xs font-medium text-slate-600 mb-1.5">Title <span className="text-red-500">*</span></label>
                    <input
                      id="chat-tk-title"
                      value={tkTitle}
                      onChange={(e) => setTkTitle(e.target.value)}
                      maxLength={255}
                      placeholder="Brief summary of the issue"
                      className="w-full px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 border border-slate-200 rounded-lg bg-slate-50 focus:bg-white focus:border-brand focus:ring-2 focus:ring-brand/20 focus:outline-none transition-colors"
                      autoFocus
                    />
                  </div>

                  {/* Project / Type / Priority row */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label htmlFor="chat-tk-project" className="block text-xs font-medium text-slate-600 mb-1.5">Project <span className="text-red-500">*</span></label>
                      <select
                        id="chat-tk-project"
                        value={tkProjectId}
                        onChange={(e) => setTkProjectId(e.target.value)}
                        className="w-full px-3 py-2 text-sm text-slate-700 border border-slate-200 rounded-lg bg-slate-50 focus:bg-white focus:border-brand focus:ring-2 focus:ring-brand/20 focus:outline-none transition-colors cursor-pointer"
                      >
                        <option value="">Select…</option>
                        {(tkProjects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="chat-tk-type" className="block text-xs font-medium text-slate-600 mb-1.5">Type</label>
                      <select
                        id="chat-tk-type"
                        value={tkType}
                        onChange={(e) => setTkType(e.target.value as TicketType)}
                        className="w-full px-3 py-2 text-sm text-slate-700 border border-slate-200 rounded-lg bg-slate-50 focus:bg-white focus:border-brand focus:ring-2 focus:ring-brand/20 focus:outline-none transition-colors cursor-pointer"
                      >
                        {TK_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="chat-tk-priority" className="block text-xs font-medium text-slate-600 mb-1.5">Priority</label>
                      <select
                        id="chat-tk-priority"
                        value={tkPriority}
                        onChange={(e) => setTkPriority(e.target.value as TicketPriority)}
                        className="w-full px-3 py-2 text-sm text-slate-700 border border-slate-200 rounded-lg bg-slate-50 focus:bg-white focus:border-brand focus:ring-2 focus:ring-brand/20 focus:outline-none transition-colors cursor-pointer"
                      >
                        {TK_PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Description */}
                  <div>
                    <label htmlFor="chat-tk-desc" className="block text-xs font-medium text-slate-600 mb-1.5">Description <span className="text-red-500">*</span></label>
                    <textarea
                      id="chat-tk-desc"
                      value={tkDesc}
                      onChange={(e) => setTkDesc(e.target.value)}
                      rows={5}
                      maxLength={10_000}
                      placeholder="Describe the issue, error messages, affected systems…"
                      className="w-full px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 border border-slate-200 rounded-lg bg-slate-50 focus:bg-white focus:border-brand focus:ring-2 focus:ring-brand/20 focus:outline-none transition-colors resize-none"
                    />
                  </div>

                  {tkError && (
                    <p className="flex items-center gap-1.5 text-xs text-red-600">
                      <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                      </svg>
                      {tkError}
                    </p>
                  )}
                </form>

                {/* Actions (sticky footer) */}
                <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-100 bg-slate-50/60 sticky bottom-0">
                  {!tkError && (!tkTitle.trim() || !tkDesc.trim() || !tkProjectId) && (
                    <span className="mr-auto text-[11px] text-slate-400">Title, project &amp; description required</span>
                  )}
                  <button type="button" onClick={closeTicketForm}
                    className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
                    disabled={tkSubmitting}>
                    Cancel
                  </button>
                  <button type="button" onClick={handleCreateTicket}
                    disabled={!tkTitle.trim() || !tkDesc.trim() || !tkProjectId || tkSubmitting}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-brand rounded-lg hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2">
                    {tkSubmitting ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Creating…
                      </>
                    ) : 'Create Ticket'}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}

      {/* Input bar */}
      <form
        onSubmit={(e) => { e.preventDefault(); void sendText(input); }}
        className="flex items-center gap-2 px-4 py-3 border-t border-slate-100 bg-white flex-shrink-0"
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Describe your issue — printer, AD, proxy, VPN…"
          className="flex-1 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-brand focus:bg-white transition-colors"
          disabled={busy}
          maxLength={MAX_TURN_CHARS}
        />
        {/* Create Ticket button */}
        <button
          type="button"
          onClick={openTicketForm}
          disabled={busy || showTicketForm}
          className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-slate-400 hover:text-brand hover:bg-brand-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          aria-label="Create ticket"
          title="Create a ticket from this conversation"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 0 1 0 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 0 1 0-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375Z" />
          </svg>
        </button>
        {/* Send button */}
        <button
          type="submit"
          disabled={!input.trim() || busy}
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
