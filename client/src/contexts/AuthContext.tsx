'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api, { authApi } from '@/lib/api';
// api used directly for the initial auth check (validateStatus suppresses 401 console errors)
import type { User } from '@/lib/schemas';

// Step 1 of login either returns an MFA challenge (code emailed) or — on a
// trusted device ("remember this device") — completes the session immediately.
export interface MfaChallenge {
  challengeId: string;
  email: string; // masked, for display (e.g. j***e@acme.com)
}
export type LoginResult =
  | ({ mfaRequired: true } & MfaChallenge)
  | { mfaRequired: false };

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  verifyMfa: (challengeId: string, code: string, rememberDevice?: boolean) => Promise<void>;
  resendMfa: (challengeId: string) => Promise<string>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      let res = await api.get('/users/me', {
        validateStatus: (s) => s < 500, // treat 401 as a normal response, not an error
      });

      // The access cookie only lives 15 minutes; the refresh cookie lives 7 days.
      // On 401, rotate tokens once and retry — otherwise a user with a live
      // session gets bounced to /login and blocked by single-session enforcement.
      if (res.status === 401) {
        const refreshed = await api.post('/auth/refresh', undefined, {
          validateStatus: (s) => s < 500,
        });
        if (refreshed.status === 200) {
          res = await api.get('/users/me', { validateStatus: (s) => s < 500 });
        }
      }

      if (res.status === 200) {
        setUser(res.data as User);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Step 1: exchange credentials for an MFA challenge (a code is emailed) — or,
  // on a trusted device, a completed session (cookies already set).
  const login = async (email: string, password: string): Promise<LoginResult> => {
    const res = await authApi.login({ email, password });
    const data = res.data as { mfaRequired: boolean; challengeId?: string; email?: string };
    if (data.mfaRequired === false) {
      await refresh(); // session cookies are set — load the user
      return { mfaRequired: false };
    }
    return { mfaRequired: true, challengeId: data.challengeId!, email: data.email! };
  };

  // Step 2: verify the emailed code; on success the session cookies are set and
  // we load the user. rememberDevice sets the 7-day trusted-device cookie.
  const verifyMfa = async (challengeId: string, code: string, rememberDevice = false) => {
    await authApi.verifyMfa({ challengeId, code, rememberDevice });
    await refresh();
  };

  const resendMfa = async (challengeId: string): Promise<string> => {
    const res = await authApi.resendMfa({ challengeId });
    return (res.data as { email: string }).email;
  };

  const logout = async () => {
    await authApi.logout();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, verifyMfa, resendMfa, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
