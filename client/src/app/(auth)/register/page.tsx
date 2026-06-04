'use client';

import { useState } from 'react';
import UserRegister from './UserRegister';
import OrgRegister from './OrgRegister';
import SaasRegister from './SaasRegister';

export default function RegisterPage() {
  const [tab, setTab] = useState<'user' | 'org' | 'saas'>('user');

  return (
    <div className="relative min-h-screen">
      {/* Premium Floating Tabs Selector */}
      <div className="absolute top-6 left-1/2 -translate-x-1/2 z-10 flex p-1 bg-slate-100/80 backdrop-blur-md rounded-full border border-slate-200 shadow-sm">
        <button
          onClick={() => setTab('user')}
          className={`px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
            tab === 'user' ? 'bg-white text-brand shadow-sm' : 'text-slate-500 hover:text-slate-900'
          }`}
        >
          User
        </button>
        <button
          onClick={() => setTab('org')}
          className={`px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
            tab === 'org' ? 'bg-white text-brand shadow-sm' : 'text-slate-500 hover:text-slate-900'
          }`}
        >
          Organization
        </button>
        <button
          onClick={() => setTab('saas')}
          className={`px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
            tab === 'saas' ? 'bg-white text-brand shadow-sm' : 'text-slate-500 hover:text-slate-900'
          }`}
        >
          Administrator
        </button>
      </div>

      {tab === 'user' && <UserRegister />}
      {tab === 'org' && <OrgRegister />}
      {tab === 'saas' && <SaasRegister />}
    </div>
  );
}
