'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';

const icons = {
  dashboard: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  saas:      'M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3.75h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008zm0 3h.008v.008h-.008v-.008z',
  support:   'M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 010 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 010-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375z',
  chat:      'M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z',
  services:  'M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z',
  users:     'M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z',
  profile:   'M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975m11.963 0a9 9 0 10-11.963 0m11.963 0A8.966 8.966 0 0112 21a8.966 8.966 0 01-5.982-2.275M15 9.75a3 3 0 11-6 0 3 3 0 016 0z',
  logout:    'M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75',
};

const roleConfig: Record<string, { label: string; badge: string; avatar: string }> = {
  USER:       { label: 'User',        badge: 'text-slate-600 bg-slate-100',  avatar: 'from-slate-400 to-slate-500' },
  ORG_ADMIN:  { label: 'Org Admin',   badge: 'text-violet-700 bg-violet-50', avatar: 'from-violet-400 to-violet-600' },
  SAAS_ADMIN: { label: 'Super Admin', badge: 'text-brand-700 bg-brand-50',   avatar: 'from-brand-400 to-brand-600' },
};

function NavItem({ href, label, icon, active }: { href: string; label: string; icon: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`group relative flex items-center gap-3 mx-2 px-3 py-2 rounded-lg text-sm transition-colors duration-150
        ${active ? 'bg-brand-50 text-brand-700 font-semibold' : 'text-slate-600 font-medium hover:bg-slate-100 hover:text-slate-900'}`}
    >
      {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 rounded-r-full bg-brand" />}
      <svg
        className={`w-5 h-5 flex-shrink-0 transition-colors duration-150 ${active ? 'text-brand' : 'text-slate-400 group-hover:text-slate-600'}`}
        fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d={icon} />
      </svg>
      <span>{label}</span>
    </Link>
  );
}

function SectionDivider({ label }: { label: string }) {
  return (
    <p className="px-5 pt-5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{label}</p>
  );
}

export default function Sidebar() {
  const { user, logout } = useAuth();
  const path = usePathname();

  const isAdmin = user?.role === 'ORG_ADMIN' || user?.role === 'SAAS_ADMIN';
  const isSaas  = user?.role === 'SAAS_ADMIN';
  const roleCfg = roleConfig[user?.role ?? ''] ?? roleConfig['USER']!;

  return (
    <aside className="relative w-60 flex-shrink-0 h-screen flex flex-col bg-white border-r border-slate-200">
      {/* Brand mark */}
      <div className="px-5 py-5 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl overflow-hidden flex items-center justify-center shadow-sm bg-slate-50 border border-slate-100 flex-shrink-0">
            <img src="/Alert.png" alt="Tech Logo" className="w-full h-full object-cover" />
          </div>
          <div className="flex-1 min-w-0 flex items-center">
            <img src="/banihal-logo.png" alt="Banihal Logo" className="max-h-9 w-auto object-contain" />
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 space-y-0.5">
        <SectionDivider label="Workspace" />
        <NavItem href="/dashboard" label="Dashboard" icon={icons.dashboard} active={path === '/dashboard'} />
        <NavItem href="/support"   label="Support"   icon={icons.support}   active={path === '/support'} />
        <NavItem href="/chat"      label="Assistant" icon={icons.chat}      active={path === '/chat'} />
        {isAdmin && (
          <>
            <NavItem href="/services" label="Services" icon={icons.services} active={path === '/services'} />
            <NavItem href="/users"    label="Users"    icon={icons.users}    active={path === '/users'} />
          </>
        )}

        {isSaas && (
          <>
            <SectionDivider label="Platform" />
            <NavItem href="/saas-admin" label="Control Plane" icon={icons.saas} active={path === '/saas-admin'} />
          </>
        )}

        <SectionDivider label="Account" />
        <NavItem href="/profile" label="My Profile" icon={icons.profile} active={path === '/profile'} />
      </nav>

      {/* User identity + controls */}
      <div className="border-t border-slate-100 p-3 space-y-3">
        <div className="flex items-center gap-2.5 px-2">
          <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${roleCfg.avatar} flex items-center justify-center text-xs font-bold text-white flex-shrink-0`}>
            {user?.name?.charAt(0) ?? '?'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-900 truncate leading-tight">{user?.name}</p>
            <p className="text-xs text-slate-400 truncate">{user?.email}</p>
          </div>
        </div>

        <div className="flex items-center justify-between px-2">
          {user?.role && (
            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-[0.08em] ${roleCfg.badge}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
              {roleCfg.label}
            </span>
          )}
          <span className="flex items-center gap-1 text-[10px] text-slate-400">
            <kbd className="kbd">⌘</kbd><kbd className="kbd">K</kbd>
          </span>
        </div>

        <button
          onClick={() => void logout()}
          className="flex w-full items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-red-50 hover:text-red-600 transition-colors duration-150 cursor-pointer"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d={icons.logout} />
          </svg>
          Sign out
        </button>
      </div>
    </aside>
  );
}
