'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import api, { authApi } from '@/lib/api';
import { notify } from '@/lib/toast-bus';
import { syncSubscription } from '@/lib/push-client';
import { sessionEnded } from '@/lib/session-bus';
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
  /** Does the signed-in user hold this platform permission? */
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  // One QueryClient lives for the whole SPA session (app/providers.tsx), so without
  // this the previous account's cached data outlives them. That is not merely stale:
  // the ticketing module serves an ADMINISTRATOR from b2b_ticketing_admin and everyone
  // else from b2b_ticket, so signing out of one role and into another in the same tab
  // leaves the new user holding the OTHER database's project / assignee / customer ids
  // — and posting one of those back returns "Project not found".
  const resetCache = useCallback(() => queryClient.clear(), [queryClient]);

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
        } else if ((res.data as { code?: string } | undefined)?.code === 'SESSION_REVOKED') {
          // The dialog is raised from the axios error interceptor — but
          // `validateStatus` above makes a 401 a SUCCESS, so that interceptor
          // never sees this one. This is the commonest path by far (every page
          // load and refresh goes through AuthContext first), so without raising
          // it here an administrator changing someone's role produced a silent
          // bounce to /login instead of the explanation.
          sessionEnded();
        }
      }

      // 429 is a transient throttle, NOT a sign-out. Because validateStatus above
      // swallows non-5xx, the axios interceptor never sees it — without this branch a
      // rate-limited user is silently treated as logged out and bounced to /login with
      // no explanation. Surface it and keep whatever session we already have.
      if (res.status === 429) {
        notify('Too many requests — please wait a moment and try again.', 'error');
        return;
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

  // Re-POST the browser's push subscription once a session exists. Safari has no
  // pushsubscriptionchange, and a subscription the server drops on a 410 is never
  // recreated — previously only /profile did this, so a user who never went back
  // there silently stopped receiving notifications. No-ops unless permission is
  // already granted, so it never prompts.
  useEffect(() => {
    if (user) void syncSubscription();
  }, [user]);

  // Step 1: exchange credentials for an MFA challenge (a code is emailed) — or,
  // on a trusted device, a completed session (cookies already set).
  // A UX affordance, not a security boundary: it decides what the interface
  // offers, while every route stays independently enforced on the server. Falls
  // closed — an unresolved user or a customer account (whose `permissions` is
  // always empty) holds nothing.
  const can = (permission: string): boolean => user?.permissions?.includes(permission) ?? false;

  const login = async (email: string, password: string): Promise<LoginResult> => {
    const res = await authApi.login({ email, password });
    const data = res.data as { mfaRequired: boolean; challengeId?: string; email?: string };
    if (data.mfaRequired === false) {
      resetCache();    // drop whoever was signed in here before
      await refresh(); // session cookies are set — load the user
      return { mfaRequired: false };
    }
    return { mfaRequired: true, challengeId: data.challengeId!, email: data.email! };
  };

  // Step 2: verify the emailed code; on success the session cookies are set and
  // we load the user. rememberDevice sets the 7-day trusted-device cookie.
  const verifyMfa = async (challengeId: string, code: string, rememberDevice = false) => {
    await authApi.verifyMfa({ challengeId, code, rememberDevice });
    resetCache();
    await refresh();
  };

  const resendMfa = async (challengeId: string): Promise<string> => {
    const res = await authApi.resendMfa({ challengeId });
    return (res.data as { email: string }).email;
  };

  const logout = async () => {
    await authApi.logout();
    setUser(null);
    // Also on the way out, so a signed-out browser holds nothing to leak into the
    // next session (or to flash on screen before the next user's data loads).
    resetCache();
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, verifyMfa, resendMfa, logout, refresh, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
