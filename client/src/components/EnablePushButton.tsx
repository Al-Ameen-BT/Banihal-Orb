'use client';

import { useEffect, useState, useCallback } from 'react';
import GlowButton from '@/components/ui/GlowButton';
import {
  isPushSupported,
  getPermission,
  enablePush,
  disablePush,
  syncSubscription,
  type PushPermission,
} from '@/lib/push-client';

const VAPID_PUBLIC_KEY = process.env['NEXT_PUBLIC_VAPID_PUBLIC_KEY'] ?? '';

// Desktop Web Push toggle. Covers the four states — unsupported / default /
// granted / denied — and requests permission ONLY inside the click handler.
export default function EnablePushButton() {
  const [permission, setPermission] = useState<PushPermission>('unsupported');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false); // avoids SSR/first-paint flicker

  // Resolve state on mount, and (Safari has no pushsubscriptionchange) keep the
  // server row fresh with an idempotent sync when permission is already granted.
  useEffect(() => {
    setPermission(getPermission());
    setReady(true);
    if (isPushSupported() && Notification.permission === 'granted') {
      void syncSubscription(VAPID_PUBLIC_KEY);
    }
  }, []);

  const onEnable = useCallback(async () => {
    setError('');
    setBusy(true);
    try {
      // Permission is requested inside this user-gesture handler (via enablePush).
      const res = await enablePush(VAPID_PUBLIC_KEY);
      setPermission(getPermission());
      if (!res.ok) {
        if (res.reason === 'denied') setError('Notifications are blocked. Enable them in your browser settings.');
        else if (res.reason === 'no-key') setError('Push is not configured (missing VAPID key).');
        else if (res.reason === 'unsupported') setError('This browser does not support push notifications.');
        else setError(res.message ?? 'Could not enable notifications.');
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const onDisable = useCallback(async () => {
    setError('');
    setBusy(true);
    try {
      const res = await disablePush();
      setPermission(getPermission());
      if (!res.ok) setError(res.message ?? 'Could not disable notifications.');
    } finally {
      setBusy(false);
    }
  }, []);

  // Render nothing decision-worthy until we've read the real permission client-side.
  if (!ready) return null;

  // ── State: unsupported (e.g. Safari < 16.1, or no ServiceWorker/PushManager) ──
  if (permission === 'unsupported') {
    return (
      <div className="text-sm text-slate-500">
        Push notifications aren’t supported in this browser.
      </div>
    );
  }

  // ── State: denied ──
  if (permission === 'denied') {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm font-medium text-red-600">
          <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
          Notifications blocked
        </div>
        <p className="text-xs text-slate-500">
          You’ve blocked notifications for this site. Re-enable them in your browser’s
          site settings, then reload.
        </p>
      </div>
    );
  }

  // ── State: granted ──
  if (permission === 'granted') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-600">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
            Notifications enabled
          </div>
          <GlowButton variant="ghost" onClick={onDisable} loading={busy} disabled={busy} className="py-1.5 px-3 text-xs">
            Turn off
          </GlowButton>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  }

  // ── State: default (not yet asked) ──
  return (
    <div className="space-y-2">
      <GlowButton onClick={onEnable} loading={busy} disabled={busy}>
        {busy ? 'Enabling…' : 'Enable notifications'}
      </GlowButton>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
