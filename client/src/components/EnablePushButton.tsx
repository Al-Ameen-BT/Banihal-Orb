'use client';

import { useEffect, useState, useCallback } from 'react';
import GlowButton from '@/components/ui/GlowButton';
import {
  isPushSupported,
  getPermission,
  enablePush,
  disablePush,
  syncSubscription,
  vapidPublicKey,
  type PushPermission,
} from '@/lib/push-client';

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
    if (!isPushSupported()) return;
    // Warm the memoized key fetch now, so the click handler below doesn't spend
    // a round-trip between granting permission and subscribing.
    void vapidPublicKey();
    if (Notification.permission === 'granted') void syncSubscription();
  }, []);

  const onEnable = useCallback(async () => {
    setError('');
    setBusy(true);
    try {
      // Permission is requested inside this user-gesture handler (via enablePush).
      const res = await enablePush();
      setPermission(getPermission());
      if (!res.ok) {
        if (res.reason === 'denied') setError('Notifications are blocked. Enable them in your browser settings.');
        else if (res.reason === 'no-key') setError('Push is not configured (missing VAPID key).');
        else if (res.reason === 'unsupported') setError('This browser does not support push notifications.');
        else if (res.reason === 'insecure-context') setError('Desktop notifications require an https:// connection.');
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

  // ── State: insecure context (http:// on a LAN IP/hostname, or a private window) ──
  // The browser is capable; the page just isn't served over a secure origin, so it
  // hides the service-worker API. Say that, rather than blaming the browser.
  if (permission === 'insecure-context') {
    return (
      <div className="space-y-1">
        <div className="text-sm font-medium text-amber-600">Not available on this connection</div>
        <p className="text-xs text-slate-500">
          Desktop notifications need a secure connection. Open the app over{' '}
          <span className="font-medium">https://</span> (or on{' '}
          <span className="font-medium">localhost</span>) and this option will appear.
        </p>
      </div>
    );
  }

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
