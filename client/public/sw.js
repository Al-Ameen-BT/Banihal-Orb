/* Web Push service worker (RFC 8030). Served at the origin root: /sw.js
 * Handles: push (show notification), notificationclick (focus/open), and
 * pushsubscriptionchange (re-subscribe + re-POST). Plain JS — no build step.
 */

'use strict';

// Where the browser POSTs a (re)subscription. Relative + same-origin so the auth
// cookie is sent first-party; the Next rewrite proxies /api to the API server.
const SUBSCRIBE_URL = '/api/push/subscribe';

// Small IndexedDB store so the SW can recover the applicationServerKey during a
// pushsubscriptionchange when the browser doesn't hand back oldSubscription.
const IDB_NAME = 'webpush';
const IDB_STORE = 'kv';
const KEY_APP_SERVER_KEY = 'applicationServerKey';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      tx.onsuccess = () => resolve(tx.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return undefined;
  }
}

// base64url VAPID key → Uint8Array (applicationServerKey), mirrors the client helper.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

function subscriptionToJson(sub) {
  const json = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys && json.keys.p256dh, auth: json.keys && json.keys.auth },
  };
}

// Activate immediately so a freshly-installed worker controls the page/push.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ─── push: render the OS notification ────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payloads still surface something rather than being dropped.
    payload = { title: 'Notification', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Notification';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/banihal-logo.png',
    badge: payload.badge || '/banihal-logo.png',
    tag: payload.tag || undefined,
    renotify: Boolean(payload.tag),
    data: { url: payload.url || '/', ...(payload.data || {}) },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ─── notificationclick: focus an existing tab for the URL, else open one ─────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL(
    (event.notification.data && event.notification.data.url) || '/',
    self.location.origin,
  );

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    // 1) Same path already open → just focus it.
    for (const client of windows) {
      const url = new URL(client.url);
      if (url.origin === targetUrl.origin && url.pathname === targetUrl.pathname && 'focus' in client) {
        return client.focus();
      }
    }
    // 2) Any tab of this app open → focus it and navigate there.
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        await client.focus();
        if ('navigate' in client) { try { return await client.navigate(targetUrl.href); } catch { /* ignore */ } }
        return;
      }
    }
    // 3) Nothing open → open a new window.
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl.href);
  })());
});

// ─── pushsubscriptionchange: the browser rotated the endpoint → re-subscribe ─
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    // Prefer the key the browser hands back; fall back to the one we stashed.
    let appServerKey = event.oldSubscription
      && event.oldSubscription.options
      && event.oldSubscription.options.applicationServerKey;

    if (!appServerKey) {
      const stored = await idbGet(KEY_APP_SERVER_KEY);
      if (stored) appServerKey = urlBase64ToUint8Array(stored);
    }
    if (!appServerKey) return; // nothing we can do without the server key

    try {
      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey,
      });
      await fetch(SUBSCRIBE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(subscriptionToJson(newSub)),
      });
    } catch {
      // Best-effort: a failed re-subscribe simply means the user re-enables later.
    }
  })());
});
