'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuth } from '@/contexts/AuthContext';

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: 'Navigation' | 'Account' | 'Help';
  shortcut?: string;
  action: () => void;
  visible?: () => boolean;
  icon: string; // SVG path data
}

const ICON = {
  dashboard: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  chart:     'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z',
  shield:    'M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z',
  ticket:    'M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 010 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 010-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375z',
  chat:      'M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z',
  services:  'M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z',
  users:     'M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z',
  user:      'M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975m11.963 0a9 9 0 10-11.963 0m11.963 0A8.966 8.966 0 0112 21a8.966 8.966 0 01-5.982-2.275M15 9.75a3 3 0 11-6 0 3 3 0 016 0z',
  logout:    'M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75',
  keyboard:  'M6 6h.008v.008H6V6zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM6 18h12a2.25 2.25 0 002.25-2.25v-7.5A2.25 2.25 0 0018 6H6a2.25 2.25 0 00-2.25 2.25v7.5A2.25 2.25 0 006 18z',
};

export default function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { user, logout } = useAuth();

  const close = useCallback(() => { setOpen(false); setQuery(''); setActiveIndex(0); }, []);

  const commands: Command[] = useMemo(() => {
    const role = user?.role;
    const isAdmin = role === 'ORG_ADMIN' || role === 'SADMIN' || role === 'ADMINISTRATOR';
    const isSaas  = role === 'SADMIN' || role === 'ADMINISTRATOR';

    return [
      { id: 'nav-dashboard', group: 'Navigation', label: 'Go to Dashboard',     shortcut: 'G D', icon: ICON.dashboard, action: () => router.push('/dashboard') },
      { id: 'nav-support',   group: 'Navigation', label: 'Open Support Ticket', shortcut: 'G T', icon: ICON.ticket,    action: () => router.push('/support') },
      { id: 'nav-chat',      group: 'Navigation', label: 'Chat Assistant',      shortcut: 'G C', icon: ICON.chat,      action: () => router.push('/chat') },
      { id: 'nav-services',  group: 'Navigation', label: 'Services',            shortcut: 'G V', icon: ICON.services,  action: () => router.push('/services'),            visible: () => isAdmin },
      { id: 'nav-users',     group: 'Navigation', label: 'Users',               shortcut: 'G U', icon: ICON.users,     action: () => router.push('/users'),               visible: () => isAdmin },
      { id: 'nav-saas',      group: 'Navigation', label: 'Control Plane',       shortcut: 'G S', icon: ICON.shield,    action: () => router.push('/saas-admin'),          visible: () => isSaas },
      { id: 'nav-profile',   group: 'Account',    label: 'My Profile',          icon: ICON.user,   action: () => router.push('/profile') },
      { id: 'account-logout',group: 'Account',    label: 'Sign Out',            icon: ICON.logout, action: async () => { await logout(); router.push('/login'); } },
      { id: 'help-shortcuts',group: 'Help',       label: 'Keyboard Shortcuts',  hint: '⌘K opens this menu', icon: ICON.keyboard, action: () => { /* keep open */ } },
    ];
  }, [router, user, logout]);

  const filtered = useMemo(() => {
    const visible = commands.filter((c) => (c.visible ? c.visible() : true));
    if (!query.trim()) return visible;
    const q = query.toLowerCase();
    return visible.filter((c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }, [commands, query]);

  const grouped = useMemo(() => {
    const groups: Record<string, Command[]> = {};
    filtered.forEach((c) => { groups[c.group] ??= []; groups[c.group]!.push(c); });
    return groups;
  }, [filtered]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
      else if (e.key === 'Escape' && open) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, filtered.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); const cmd = filtered[activeIndex]; if (cmd) { cmd.action(); close(); } }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, activeIndex, filtered, close]);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 50); }, [open]);
  useEffect(() => { setActiveIndex(0); }, [query]);

  let runningIndex = -1;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4"
          onClick={close}
        >
          <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" />

          <motion.div
            initial={{ y: -16, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -16, opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-xl rounded-2xl bg-white border border-slate-200 overflow-hidden shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-slate-100">
              <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Type a command or search…"
                className="flex-1 bg-transparent text-slate-900 placeholder:text-slate-400 focus:outline-none text-sm"
              />
              <span className="kbd">ESC</span>
            </div>

            {/* Results */}
            <div className="max-h-96 overflow-y-auto py-2">
              {filtered.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-slate-400">
                  No commands match <span className="text-slate-700 font-medium">&quot;{query}&quot;</span>
                </div>
              ) : (
                Object.entries(grouped).map(([group, items]) => (
                  <div key={group} className="mb-1.5">
                    <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">{group}</div>
                    {items.map((cmd) => {
                      runningIndex += 1;
                      const isActive = runningIndex === activeIndex;
                      return (
                        <button
                          key={cmd.id}
                          onMouseEnter={() => setActiveIndex(runningIndex)}
                          onClick={() => { cmd.action(); close(); }}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors cursor-pointer ${
                            isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          <svg className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-brand' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d={cmd.icon} />
                          </svg>
                          <span className="flex-1 font-medium">{cmd.label}</span>
                          {cmd.hint && <span className="text-xs text-slate-400">{cmd.hint}</span>}
                          {cmd.shortcut && (
                            <span className="flex gap-1">
                              {cmd.shortcut.split(' ').map((k) => <span key={k} className="kbd">{k}</span>)}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-[11px] text-slate-400">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1.5"><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span>
                <span className="flex items-center gap-1.5"><span className="kbd">↵</span> select</span>
              </div>
              <span>{filtered.length} command{filtered.length !== 1 ? 's' : ''}</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
