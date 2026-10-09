import webpush from 'web-push';
import type { PushSubscription as PushSubscriptionRow } from '@prisma/client';
import { prisma } from '../config/database';
import { env } from '../config/env';

// ─── Web Push (RFC 8030) sending via VAPID (RFC 8292) ────────────────────────
// One standard path for every desktop browser (Chromium / Firefox / Safari 16.1+).
// The VAPID private key is a secret: it is read from env, handed only to the
// web-push library, and NEVER returned to a client or written to a log.

// The JSON body delivered to the service worker's `push` handler.
export interface PushPayload {
  title: string;
  body?: string;
  url?: string;          // where notificationclick should navigate/focus
  icon?: string;
  badge?: string;
  tag?: string;          // coalesces notifications with the same tag
  data?: Record<string, unknown>;
}

// The subset of a stored subscription web-push needs to deliver a message.
type Deliverable = Pick<PushSubscriptionRow, 'endpoint' | 'p256dh' | 'auth'>;

export type SendOutcome =
  | { endpoint: string; status: 'sent' }
  | { endpoint: string; status: 'gone' }   // 404/410 → subscription row deleted
  | { endpoint: string; status: 'error'; statusCode?: number; message: string };

export class PushNotConfiguredError extends Error {
  code = 'PUSH_NOT_CONFIGURED';
  statusCode = 503;
  constructor() {
    super('Web Push is not configured: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.');
    this.name = 'PushNotConfiguredError';
  }
}

// True when VAPID keys are present, so callers can degrade instead of throwing.
export function isPushConfigured(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

// setVapidDetails is idempotent but we only want to call it once, after verifying
// the keys exist. Throws PushNotConfiguredError when keys are missing.
let vapidReady = false;
function ensureVapid(): void {
  if (vapidReady) return;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new PushNotConfiguredError();
  // NOTE: never log the arguments below — the second/third are the VAPID keys.
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  vapidReady = true;
}

// Deliver one notification. On a 404/410 (the push service reports the endpoint
// is gone), the matching row is deleted so we stop sending to dead devices.
export async function sendToSubscription(sub: Deliverable, payload: PushPayload): Promise<SendOutcome> {
  ensureVapid();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 60 },
    );
    // Best-effort freshness bump; never fail the send because this update failed.
    await prisma.pushSubscription
      .updateMany({ where: { endpoint: sub.endpoint }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
    return { endpoint: sub.endpoint, status: 'sent' };
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      await prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } }).catch(() => {});
      return { endpoint: sub.endpoint, status: 'gone' };
    }
    // Do NOT include the error's config/keys — only its message + status.
    return { endpoint: sub.endpoint, status: 'error', statusCode, message: (err as Error).message };
  }
}

export interface SendToUserArgs {
  userId: string;
  tenantId: string;
  payload: PushPayload;
}

export interface SendToUserResult {
  total: number;
  sent: number;
  removed: number;   // dead endpoints cleaned up (404/410)
  failed: number;
  outcomes: SendOutcome[];
}

// Fan out to every subscription a user has in this tenant. Uses Promise.allSettled
// so one failing/dead device can never abort delivery to the others.
export async function sendToUser({ userId, tenantId, payload }: SendToUserArgs): Promise<SendToUserResult> {
  ensureVapid();
  const subs = await prisma.pushSubscription.findMany({ where: { userId, tenantId } });

  const settled = await Promise.allSettled(subs.map((s) => sendToSubscription(s, payload)));

  const outcomes: SendOutcome[] = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { endpoint: subs[i]!.endpoint, status: 'error', message: (r.reason as Error)?.message ?? 'Unknown send error' },
  );

  return {
    total: outcomes.length,
    sent: outcomes.filter((o) => o.status === 'sent').length,
    removed: outcomes.filter((o) => o.status === 'gone').length,
    failed: outcomes.filter((o) => o.status === 'error').length,
    outcomes,
  };
}
