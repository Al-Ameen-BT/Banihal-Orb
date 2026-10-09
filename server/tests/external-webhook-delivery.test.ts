import { describe, it, expect, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import crypto from 'crypto';
import { encryptSecret } from '../src/config/slackCrypto';
import { deliverWebhook, type WebhookEventPayload, type DeliveryResult } from '../src/modules/external-api/external-webhooks';

// Bytes-level check of the delivery contract (no database — a fabricated
// webhook row + a local HTTP sink): the HMAC must cover the EXACT body bytes
// sent, the event headers must be present, transient errors retry, and a stable
// 4xx (a consumer bug) is dropped without retrying.

const payload: WebhookEventPayload = {
  eventId: 'evt-1',
  type: 'ticket.created',
  keyId: 'key-1',
  triggeredAt: '2026-09-16T00:00:00.000Z',
  data: {
    ticket: {
      id: 't-1', ticketNumber: 'A-1', title: 'hello', description: 'world',
      status: 'todo', priority: 'high', type: 'task',
      projectId: 'p-1', projectName: 'Proj', customerId: null, customerName: null,
      assigneeId: null, assigneeName: null, reporterId: null,
      storyPoints: null, branch: null, labels: [], dueDate: null,
      createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z',
    },
  },
};

const secret = 'test-secret';
const webhook = { id: 'wh-1', url: '', secretEnc: encryptSecret(secret), key: { clientId: 'ext_ck_x' } };

interface Recorded { raw: Buffer; headers: http.IncomingHttpHeaders }

let server: http.Server;
let port: number;
const history: Recorded[] = [];

const expectSignature = (r: Recorded) =>
  `sha256=${crypto.createHmac('sha256', secret).update(r.raw).digest('hex')}`;

function start(statuses: number[]): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        history.push({ raw: Buffer.concat(chunks), headers: req.headers });
        res.writeHead(statuses[Math.min(history.length, statuses.length) - 1] ?? 200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
}

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('deliverWebhook', () => {
  it('signs the exact body bytes and carries the event headers (2xx = delivered)', async () => {
    history.length = 0;
    await start([200]);
    webhook.url = `http://127.0.0.1:${port}/hook`;
    const res: DeliveryResult = await deliverWebhook(webhook, payload, [0]);

    expect(res).toEqual({ ok: true, attempts: 1, status: 200 });
    const hit = history[0]!;
    expect(hit.headers['x-webhook-signature']).toBe(expectSignature(hit));
    expect(hit.headers['x-webhook-event']).toBe('ticket.created');
    expect(hit.headers['x-webhook-event-id']).toBe('evt-1');
    expect(hit.headers['x-webhook-key']).toBe('ext_ck_x');
    expect(hit.headers['content-type']).toContain('application/json');
    expect(JSON.parse(hit.raw.toString('utf8'))).toEqual(payload);
  });

  it('retries through transient 5xx failures and succeeds once the sink recovers', async () => {
    history.length = 0;
    await start([500, 500, 200]);
    webhook.url = `http://127.0.0.1:${port}/hook`;
    const res: DeliveryResult = await deliverWebhook(webhook, payload, [0, 0, 0]);

    expect(res).toEqual({ ok: true, attempts: 3, status: 200 });
    expect(history).toHaveLength(3);
  });

  it('does NOT retry a stable 4xx — the consumer endpoint is broken, not transient', async () => {
    history.length = 0;
    await start([410]);
    webhook.url = `http://127.0.0.1:${port}/hook`;
    const res: DeliveryResult = await deliverWebhook(webhook, payload, [0, 0]);

    expect(res).toEqual({ ok: false, attempts: 1, status: 410 });
    expect(history).toHaveLength(1);
  });

  it('gives up after exhausting retries on a network error', async () => {
    // Nothing is listening → every attempt rejects immediately.
    const res: DeliveryResult = await deliverWebhook({ ...webhook, url: 'http://127.0.0.1:1/hook' }, payload, [0, 0]);

    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(2);
    expect(res.status).toBeNull();
  });
});