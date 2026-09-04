// Browser-side Web Push helpers. Framework-agnostic; safe to import in a client
// component. Degrades gracefully on browsers without Push/ServiceWorker (e.g.
// Safari < 16.1) — every entry point feature-detects and never throws on those.

const SW_URL = '/sw.js';
const SUBSCRIBE_URL = '/api/push/subscribe';   // same-origin; Next rewrite → API
const UNSUBSCRIBE_URL = '/api/push/unsubscribe';
const KEY_URL = '/api/push/vapid-public-key';

// Persist the applicationServerKey so the service worker can recover it during a
// pushsubscriptionchange (kept in sync with sw.js: same DB/store/key).
const IDB_NAME = 'webpush';
const IDB_STORE = 'kv';
const KEY_APP_SERVER_KEY = 'applicationServerKey';

// ─── Feature detection ───────────────────────────────────────────────────────
// Service workers are gated on a secure context: browsers expose them over
// https:// and on localhost/127.0.0.1 ONLY. Reached over plain http:// on a LAN
// IP or hostname, `navigator.serviceWorker` is simply absent — indistinguishable
// from an old browser unless we check the context separately. Worth separating,
// because "serve it over HTTPS" and "use a different browser" are very different
// instructions to give a user.
export function isSecureContext(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// Current OS/browser permission, or why push can't run at all.
export type PushPermission = 'unsupported' | 'insecure-context' | NotificationPermission;
export function getPermission(): PushPermission {
  if (typeof window === 'undefined') return 'unsupported';
  // Check the context first: an insecure origin strips the very APIs that
  // isPushSupported() looks for, so testing in the other order always reports
  // 'unsupported' and hides the real cause.
  if (!isSecureContext()) return 'insecure-context';
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

// ─── VAPID public key ────────────────────────────────────────────────────────
// Fetched from the API at RUNTIME, deliberately — not read from
// NEXT_PUBLIC_VAPID_PUBLIC_KEY. That value is inlined into the JS bundle at
// `next build`, which put the public half inside the web image while the private
// half lives in the API's env file: two places that drift with nothing able to
// detect it. A web image built without the build arg (or one predating a key
// rotation) served an empty string, so push failed as "not configured" on a
// server that was configured. One source of truth, resolved per page load.
let keyPromise: Promise<string> | null = null;
export function vapidPublicKey(): Promise<string> {
  keyPromise ??= fetch(KEY_URL, { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : { publicKey: null }))
    .then((j: { publicKey?: string | null }) => j.publicKey ?? '')
    .catch(() => '');   // offline / 401 — callers degrade via their 'no-key' path
  return keyPromise;
}

// ─── applicationServerKey conversion (base64url → Uint8Array) ────────────────
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // Back with an explicit ArrayBuffer so the result satisfies BufferSource
  // (applicationServerKey rejects SharedArrayBuffer-backed views under strict DOM types).
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

// ─── IndexedDB (store the VAPID public key for the SW) ────────────────────────
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key: string, value: string): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(value, key);
      tx.onsuccess = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* non-fatal: pushsubscriptionchange also tries oldSubscription's key */
  }
}
async function idbDel(key: string): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).delete(key);
      tx.onsuccess = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* non-fatal */
  }
}

// ─── Service worker registration ─────────────────────────────────────────────
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  const reg = existing ?? (await navigator.serviceWorker.register(SW_URL));
  await navigator.serviceWorker.ready;
  return reg;
}

// Serialize a PushSubscription into the API's expected body shape.
function serialize(sub: PushSubscription): { endpoint: string; keys: { p256dh: string; auth: string }; userAgent: string } {
  const json = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };
}

async function postSubscription(sub: PushSubscription): Promise<void> {
  const res = await fetch(SUBSCRIBE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(serialize(sub)),
  });
  if (!res.ok) throw new Error(`Failed to save subscription (${res.status})`);
}

// ─── enablePush: request permission (must be called from a click handler) ────
export interface EnableResult {
  ok: boolean;
  reason?: 'unsupported' | 'insecure-context' | 'denied' | 'no-key' | 'error';
  message?: string;
}

export async function enablePush(): Promise<EnableResult> {
  if (!isSecureContext()) return { ok: false, reason: 'insecure-context' };
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

  try {
    // Permission FIRST, then the key. requestPermission() must be reached inside
    // the caller's click handler, and an await before it costs the user gesture
    // in Safari — so the network fetch cannot come first.
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: 'denied' };

    const key = await vapidPublicKey();
    if (!key) return { ok: false, reason: 'no-key', message: 'Missing VAPID public key' };

    const reg = await registerServiceWorker();
    if (!reg) return { ok: false, reason: 'unsupported' };

    const applicationServerKey = urlBase64ToUint8Array(key) as BufferSource;
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? (await reg.pushManager.subscribe({
      userVisibleOnly: true,             // required on every subscribe
      applicationServerKey,
    }));

    await idbSet(KEY_APP_SERVER_KEY, key); // let the SW recover it later
    await postSubscription(sub);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'error', message: (err as Error).message };
  }
}

// ─── disablePush: unsubscribe locally + remove the server row ────────────────
export async function disablePush(): Promise<{ ok: boolean; message?: string }> {
  if (!isPushSupported()) return { ok: true };
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      await fetch(UNSUBSCRIBE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ endpoint }),
      }).catch(() => {});
    }
    await idbDel(KEY_APP_SERVER_KEY);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

// ─── syncSubscription: idempotent refresh (Safari has no pushsubscriptionchange)
// Call on app load when permission is already granted: re-POST the current
// subscription (upsert), or create one if the browser dropped it. Safe to call
// repeatedly; no-op when unsupported or permission isn't granted.
export async function syncSubscription(): Promise<{ ok: boolean; synced: boolean; message?: string }> {
  if (!isPushSupported()) return { ok: true, synced: false };
  if (Notification.permission !== 'granted') return { ok: true, synced: false };

  try {
    const key = await vapidPublicKey();
    if (!key) return { ok: true, synced: false };

    const reg = await registerServiceWorker();
    if (!reg) return { ok: true, synced: false };

    const applicationServerKey = urlBase64ToUint8Array(key) as BufferSource;
    const sub = (await reg.pushManager.getSubscription())
      ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));

    await idbSet(KEY_APP_SERVER_KEY, key);
    await postSubscription(sub);
    return { ok: true, synced: true };
  } catch (err) {
    return { ok: false, synced: false, message: (err as Error).message };
  }
}
