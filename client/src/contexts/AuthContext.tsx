'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api, { authApi } from '@/lib/api';
// api used directly for the initial auth check (validateStatus suppresses 401 console errors)
import type { User } from '@/lib/schemas';

// Step 1 of login returns an MFA challenge — the session is only established
// after the emailed code is verified.
export interface MfaChallenge {
  challengeId: string;
  email: string; // masked, for display (e.g. j***e@acme.com)
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<MfaChallenge>;
  verifyMfa: (challengeId: string, code: string) => Promise<void>;
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

  // Step 1: exchange credentials for an MFA challenge (a code is emailed). No
  // session yet — the caller must collect the code and call verifyMfa.
  const login = async (email: string, password: string): Promise<MfaChallenge> => {
    const res = await authApi.login({ email, password });
    const data = res.data as { challengeId: string; email: string };
    return { challengeId: data.challengeId, email: data.email };
  };

  // Step 2: verify the emailed code; on success the session cookies are set and
  // we load the user.
  const verifyMfa = async (challengeId: string, code: string) => {
    await authApi.verifyMfa({ challengeId, code });
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
