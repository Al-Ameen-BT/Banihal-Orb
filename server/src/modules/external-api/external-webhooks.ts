import crypto from 'crypto';
import { prisma } from '../../config/database';
import { audit } from '../../lib/audit';
import { encryptSecret, decryptSecret, maskToken } from '../../config/slackCrypto';
import type { TicketDTO, CommentDTO } from '../ticketing/ticketing.types';

// ─── External ticketing API: webhook delivery ────────────────────────────────
// Consumers (the Slack-bot integration is the first) register a webhook URL per
// API key. On a named event we POST a signed JSON payload to every enabled hook
// of the key subscribed to that event:
//
//   X-Webhook-Signature: sha256=<HMAC-SHA256 over the EXACT body bytes>
//   X-Webhook-Event: ticket.status_changed
//   X-Webhook-Event-Id: <payload eventId>
//   X-Webhook-Key: <the key's clientId>
//
// Delivery is detached: emit*() resolves the recipients and returns immediately,
// delivery happens in the background so a slow endpoint never delays the ticket
// API. 2xx = delivered; network error / timeout / 5xx / 429 retries up to three
// attempts with 5s + 10s gaps; any other 4xx is a consumer bug and is dropped.
// Five consecutive failures disable the webhook (audited).

export const EXTERNAL_WEBHOOK_EVENTS = ['ticket.created', 'ticket.status_changed', 'ticket.comment_added'] as const;
export type ExternalWebhookEvent = (typeof EXTERNAL_WEBHOOK_EVENTS)[number];

const RETRY_DELAYS_MS = [0, 5_000, 10_000];
const DELIVERY_TIMEOUT_MS = 10_000;
const DISABLE_AFTER_FAILURES = 5;

// ─── Payload contract ─────────────────────────────────────────────────────────
// The consumer's work-item snapshot: ids + the display strings people route on.
// ticketNumber is the human key; projectId/customerId are the machine anchors.
export interface WebhookTicketPayload {
  id: string;
  ticketNumber: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  type: string;
  projectId: string;
  projectName: string | null;
  customerId: string | null;
  customerName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  reporterId: string | null;
  storyPoints: number | null;
  branch: string | null;
  labels: string[];
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookCommentPayload {
  id: string;
  content: string;
  authorId: string | null;
  createdAt: string;
}

export interface WebhookEventPayload {
  eventId: string;
  type: ExternalWebhookEvent;
  keyId: string;
  triggeredAt: string;
  data: { ticket: WebhookTicketPayload; comment?: WebhookCommentPayload };
}

export function toWebhookTicket(t: TicketDTO): WebhookTicketPayload {
  return {
    id: t.id,
    ticketNumber: t.ticketNumber,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    type: t.type,
    projectId: t.projectId,
    projectName: t.projectName,
    customerId: t.customer?.id ?? null,
    customerName: t.customer?.name ?? null,
    assigneeId: t.assignee?.id ?? null,
    assigneeName: t.assignee?.name ?? null,
    reporterId: t.reporter?.id ?? null,
    storyPoints: t.storyPoints,
    branch: t.branch,
    labels: t.labels,
    dueDate: t.dueDate,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ─── HTTP delivery (pure — no DB, no clock, so a test bytes-level checks it) ──
export interface WebhookRowLike {
  id: string;
  url: string;
  secretEnc: string;
  key: { clientId: string };
}

export interface DeliveryResult { ok: boolean; attempts: number; status: number | null }

export async function deliverWebhook(
  webhook: WebhookRowLike,
  payload: WebhookEventPayload,
  retryDelaysMs: number[] = RETRY_DELAYS_MS,
): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const secret = decryptSecret(webhook.secretEnc);
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

  let attempts = 0;
  for (const delay of retryDelaysMs) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    attempts += 1;
    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-signature': `sha256=${signature}`,
          'x-webhook-event': payload.type,
          'x-webhook-event-id': payload.eventId,
          'x-webhook-key': webhook.key.clientId,
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true, attempts, status: res.status };
      // Congestion (429) and server errors are worth another shot; a stable 4xx
      // is a bug in the consumer's endpoint and will not fix itself.
      if (res.status >= 500 || res.status === 429) continue;
      return { ok: false, attempts, status: res.status };
    } catch {
      continue; // network error / timeout — retry
    }
  }
  return { ok: false, attempts, status: null };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────
// CLI-driven (scripts/external-api-keys.ts), like the keys themselves.

export interface WebhookDTO {
  id: string;
  keyId: string;
  clientId: string;
  url: string;
  secretHint: string;
  events: string[];
  enabled: boolean;
  lastTriggeredAt: string | null;
  lastDeliveryOk: boolean | null;
  failureCount: number;
  createdAt: string;
}

export interface CreateWebhookInput { url: string; events: ExternalWebhookEvent[]; enabled?: boolean }

export async function createWebhook(
  keyId: string,
  input: CreateWebhookInput,
  actor: { userId: string; customerId: string },
): Promise<{ id: string; secret: string; secretHint: string }> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
  } catch {
    throw Object.assign(new Error('url must be an absolute http(s) URL'), { status: 400, code: 'VALIDATION_ERROR' });
  }
  const secret = `ext_whk_${crypto.randomBytes(32).toString('base64url')}`;
  const row = await prisma.externalWebhook.create({
    data: {
      keyId,
      url: input.url,
      secretEnc: encryptSecret(secret),
      secretHint: maskToken(secret),
      events: input.events,
      enabled: input.enabled ?? true,
    },
    select: { id: true },
  });
  await audit({
    action: 'EXTERNAL_WEBHOOK_CREATED',
    performedById: actor.userId,
    targetId: row.id,
    customerId: actor.customerId,
    metadata: { url: input.url, events: input.events },
  });
  return { id: row.id, secret, secretHint: maskToken(secret) };
}

export async function listWebhooks(keyId?: string): Promise<WebhookDTO[]> {
  const rows = await prisma.externalWebhook.findMany({
    where: keyId ? { keyId } : undefined,
    include: { apiKey: { select: { clientId: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((w) => ({
    id: w.id, keyId: w.keyId, clientId: w.apiKey.clientId, url: w.url,
    secretHint: w.secretHint, events: w.events as string[], enabled: w.enabled,
    lastTriggeredAt: w.lastTriggeredAt?.toISOString() ?? null,
    lastDeliveryOk: w.lastDeliveryOk, failureCount: w.failureCount,
    createdAt: w.createdAt.toISOString(),
  }));
}

export async function removeWebhook(id: string, actor: { userId: string; customerId: string }): Promise<void> {
  const row = await prisma.externalWebhook.findUnique({ where: { id }, select: { url: true, keyId: true } });
  if (!row) throw Object.assign(new Error('Webhook not found'), { status: 404, code: 'NOT_FOUND' });
  await prisma.externalWebhook.delete({ where: { id } });
  await audit({
    action: 'EXTERNAL_WEBHOOK_DELETED',
    performedById: actor.userId,
    targetId: id,
    customerId: actor.customerId,
    metadata: { url: row.url, keyId: row.keyId },
  });
}

// ─── Emission ─────────────────────────────────────────────────────────────────
// Two entry points share one delivery path:
//   emitTicketEvent   — the act is done BY the key (create / external update / comment)
//   emitOrgTicketEvent — the act is done TO the org (platform/Slack approval decisions),
//                        delivered to every enabled key serving that org.
// Both are fire-and-forget: callers `void emit(...).catch(() => undefined)`.

async function emitPayload(payload: WebhookEventPayload, wh: { id: string; url: string; secretEnc: string; key: { clientId: string } }): Promise<void> {
  await prisma.externalWebhook.update({ where: { id: wh.id }, data: { lastTriggeredAt: new Date() } }).catch(() => undefined);
  const { ok } = await deliverWebhook(wh, payload);
  if (ok) {
    await prisma.externalWebhook.update({ where: { id: wh.id }, data: { lastDeliveryOk: true, failureCount: 0 } }).catch(() => undefined);
    return;
  }
  // Failure bookkeeping happens under final error: the LAST emitter to hit a dead
  // hook is the one that bumps the counter, and the disable lives here too.
  const row = await prisma.externalWebhook.findUnique({
    where: { id: wh.id },
    select: { failureCount: true, enabled: true, url: true, keyId: true },
  }).catch(() => null);
  if (!row) return;
  const next = (row.failureCount ?? 0) + 1;
  if (next >= DISABLE_AFTER_FAILURES && row.enabled) {
    await prisma.externalWebhook.update({ where: { id: wh.id }, data: { enabled: false, lastDeliveryOk: false, failureCount: next } }).catch(() => undefined);
    // Audit under the key's first allowed org; admin-store keys have none, so a
    // platform-scoped disable is logged under 'platform'.
    const key = await prisma.externalApiKey.findUnique({
      where: { id: row.keyId },
      select: { customerIds: true },
    }).catch(() => null);
    const customerId = (key?.customerIds as string[] | null | undefined)?.[0] ?? 'platform';
    await audit({
      action: 'EXTERNAL_WEBHOOK_UPDATED',
      performedById: null,
      targetId: wh.id,
      customerId,
      metadata: { url: row.url, failures: next, keyId: row.keyId, disabled: true },
    }).catch(() => undefined);
  } else {
    await prisma.externalWebhook.update({ where: { id: wh.id }, data: { lastDeliveryOk: false, failureCount: next } }).catch(() => undefined);
  }
}

interface EventInput { type: ExternalWebhookEvent; ticket: TicketDTO; comment?: CommentDTO }

type WebhookRecipient = { id: string; url: string; secretEnc: string; keyId: string; key: { clientId: string } };

// The prisma relation is `apiKey`; the delivery contract names it `key`.
const toRecipient = (r: { id: string; url: string; secretEnc: string; keyId: string; apiKey: { clientId: string } }): WebhookRecipient => ({
  id: r.id, url: r.url, secretEnc: r.secretEnc, keyId: r.keyId, key: r.apiKey,
});

async function emitPayloadTo(recipients: WebhookRecipient[], input: EventInput): Promise<void> {
  if (recipients.length === 0) return;
  // keyId declared in the payload is the recipient's OWN key — org-scoped events
  // fan out across several keys and must not impersonate one of them.
  await Promise.all(recipients.map((wh) => emitPayload({
    eventId: crypto.randomUUID(),
    type: input.type,
    keyId: wh.keyId,
    triggeredAt: new Date().toISOString(),
    data: { ticket: toWebhookTicket(input.ticket), ...(input.comment ? { comment: toWebhookComment(input.comment) } : {}) },
  }, wh)));
}

export function toWebhookComment(c: CommentDTO): WebhookCommentPayload {
  return { id: c.id, content: c.content, authorId: c.author?.id ?? null, createdAt: c.createdAt };
}

/** Deliver to every enabled webhook of one key subscribed to the event. */
export async function emitTicketEvent(input: EventInput & { keyId: string }): Promise<void> {
  const recipients = await prisma.externalWebhook.findMany({
    where: { keyId: input.keyId, enabled: true, events: { array_contains: input.type } },
    select: { id: true, url: true, secretEnc: true, keyId: true, apiKey: { select: { clientId: true } } },
  });
  await emitPayloadTo(recipients.map(toRecipient), input);
}

/** Deliver to every enabled webhook of the keys serving an org (default store). */
export async function emitOrgTicketEvent(input: EventInput & { customerId: string }): Promise<void> {
  const keys = await prisma.externalApiKey.findMany({
    where: { ticketStore: 'default', enabled: true, customerIds: { array_contains: input.customerId } },
    select: { id: true },
  });
  if (keys.length === 0) return;
  const recipients = await prisma.externalWebhook.findMany({
    where: { keyId: { in: keys.map((k) => k.id) }, enabled: true, events: { array_contains: input.type } },
    select: { id: true, url: true, secretEnc: true, keyId: true, apiKey: { select: { clientId: true } } },
  });
  await emitPayloadTo(recipients.map(toRecipient), input);
}