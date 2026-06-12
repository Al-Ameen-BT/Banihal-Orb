'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api, { authApi } from '@/lib/api';
// api used directly for the initial auth check (validateStatus suppresses 401 console errors)
import type { User } from '@/lib/schemas';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
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

  const login = async (email: string, password: string) => {
    await authApi.login({ email, password });
    await refresh();
  };

  const logout = async () => {
    await authApi.logout();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
