import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { prisma } from '../src/config/database';
import { createTestOrg, createTestUser, cleanDb, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { createKey } from '../src/modules/external-api/external-keys';
import { createWebhook, emitTicketEvent, emitOrgTicketEvent } from '../src/modules/external-api/external-webhooks';
import type { TicketDTO } from '../src/modules/ticketing/ticketing.types';

// Security surface of the webhook delivery (Phase 5):
//   - a webhook only receives the events it subscribed to;
//   - an org-scoped event reaches ONLY keys serving that org (cross-org isolation);
//   - the payload's keyId is the RECIPIENT's own key, never a forgery;
//   - createWebhook rejects non-http(s) URLs (SSRF starts with a valid scheme);
//   - five consecutive failures disable the hook and are audited.

const ready = ticketTestDbReady();

/** Minimal TicketDTO — only the fields toWebhookTicket reads. */
const ticket = (id: string): TicketDTO =>
  ({
    id,
    ticketNumber: `T-${id}`,
    title: 'webhook-sec',
    description: 'x',
    status: 'todo',
    priority: 'high',
    type: 'task',
    projectId: 'p-1',
    projectName: null,
    reporter: null,
    assignee: null,
    customer: null,
    storyPoints: null,
    dueDate: null,
    labels: [],
    branch: null,
    onSiteSupportRequired: false,
    reasonForDelay: null,
    resolvedMethods: null,
    resolvedAt: null,
    sla: null,
    slaStatus: 'not_set',
    slaRemainingSeconds: null,
    slaDeadline: null,
    responseSla: { status: 'not_set', severity: 'ok', label: '', elapsed: null, responseTime: null },
    resolutionSla: { status: 'not_set', severity: 'ok', label: '', elapsed: null, resolutionTime: null },
    pausedTime: null,
    totalPausedTime: 0,
    counts: { comments: 0, attachments: 0, watchers: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as unknown as TicketDTO;

interface Recorded { raw: Buffer; headers: http.IncomingHttpHeaders }

// One sink; /fail answers 410 (a stable consumer-misbehaviour error → single
// attempt, no 5s/10s retry gaps), everything else 200.
let server: http.Server;
let port: number;
const history: Recorded[] = [];

function start(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        history.push({ raw: Buffer.concat(chunks), headers: req.headers });
        const fail = req.url?.startsWith('/fail');
        res.writeHead(fail ? 410 : 200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
}

describe.skipIf(!ready)(`webhook security${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, () => {
  beforeEach(async () => {
    await cleanDb();
    await prisma.externalWebhook.deleteMany();
    await prisma.externalApiKey.deleteMany();
    history.length = 0;
    await start();
  });
  afterAll(async () => {
    await cleanDb();
    if (server) await new Promise((r) => server.close(r));
    await prisma.$disconnect();
  });

  it('delivers precisely the subscribed events — an unsubscribed event never fires the hook', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const org = await createTestOrg('Webhook Filter Org');
    const user = await createTestUser(org.id, `filt-${now}@example.com`, 'ORG_ADMIN');
    const actor = { userId: user.id, customerId: org.id };
    const key = await createKey({ name: 'filter-key', scopes: ['tickets.write'], ticketStore: 'default', customerIds: [org.id] }, actor);
    const wh = await createWebhook(key.id, {
      url: `http://127.0.0.1:${port}/ok`,
      events: ['ticket.created'], // ONLY created
    }, actor);

    await emitTicketEvent({ keyId: key.id, type: 'ticket.status_changed', ticket: ticket('f1') });
    await emitTicketEvent({ keyId: key.id, type: 'ticket.comment_added', ticket: ticket('f1'), comment: { id: 'c1', content: 'hi', authorId: null, createdAt: new Date().toISOString() } });
    expect(history, 'an unsubscribed event must not reach the webhook').toHaveLength(0);

    await emitTicketEvent({ keyId: key.id, type: 'ticket.created', ticket: ticket('f1') });
    expect(history).toHaveLength(1);
    expect(history[0]!.headers['x-webhook-event']).toBe('ticket.created');

    // Signed with the hook's OWN secret — the secretHint is only for matching.
    const row = await prisma.externalWebhook.findUnique({ where: { id: wh.id }, select: { failureCount: true } });
    expect(row!.failureCount).toBe(0);
  });

  it('org-scoped events reach ONLY the keys serving that org (cross-org isolation)', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const orgA = await createTestOrg('Webhook Org A');
    const orgB = await createTestOrg('Webhook Org B');
    const userA = await createTestUser(orgA.id, `wa-${now}@example.com`, 'ORG_ADMIN');
    const userB = await createTestUser(orgB.id, `wb-${now}@example.com`, 'ORG_ADMIN');
    const keyA = await createKey({ name: 'key-a', scopes: ['tickets.write'], ticketStore: 'default', customerIds: [orgA.id] }, { userId: userA.id, customerId: orgA.id });
    const keyB = await createKey({ name: 'key-b', scopes: ['tickets.write'], ticketStore: 'default', customerIds: [orgB.id] }, { userId: userB.id, customerId: orgB.id });
    await createWebhook(keyA.id, { url: `http://127.0.0.1:${port}/ok`, events: ['ticket.created'] }, { userId: userA.id, customerId: orgA.id });
    await createWebhook(keyB.id, { url: `http://127.0.0.1:${port}/ok`, events: ['ticket.created'] }, { userId: userB.id, customerId: orgB.id });

    // A ticket event FOR orgA must fan out to keyA's hook only.
    await emitOrgTicketEvent({ customerId: orgA.id, type: 'ticket.created', ticket: ticket('a1') });
    expect(history, 'only the org-serving key may be notified').toHaveLength(1);
    expect(history[0]!.headers['x-webhook-key']).toBe(keyA.clientId);

    // keyB's delivery carries keyB's OWN identity — a fan-out can never forge
    // another key's clientId in the payload.
    await emitOrgTicketEvent({ customerId: orgB.id, type: 'ticket.created', ticket: ticket('b1') });
    const sec = history[1]!;
    expect(sec.headers['x-webhook-key']).toBe(keyB.clientId);
    const body = JSON.parse(sec.raw.toString('utf8'));
    // The payload's keyId is the key's DB row id — the recipient's OWN key, so an
    // org-scoped fan-out can never masquerade as another key (headers carry the
    // clientId as a separate axis).
    expect(body.keyId).toBe(keyB.id);
  });

  it('rejects a webhook URL that is not an absolute http(s) URL', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const org = await createTestOrg('Webhook URL Org');
    const user = await createTestUser(org.id, `url-${now}@example.com`, 'ORG_ADMIN');
    const actor = { userId: user.id, customerId: org.id };
    const key = await createKey({ name: 'url-key', scopes: ['tickets.write'], ticketStore: 'default', customerIds: [org.id] }, actor);

    for (const bad of ['file:///etc/passwd', 'ftp://example.com/hook', 'javascript:alert(1)', 'not-a-url', '//host/hook']) {
      await expect(createWebhook(key.id, { url: bad, events: ['ticket.created'] }, actor)).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    }
    const good = await createWebhook(key.id, { url: 'https://consumer.example/hook', events: ['ticket.created'] }, actor);
    expect(good.secretHint).toBeTruthy();
  });

  it('disables a webhook after five consecutive failures and audits it', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const org = await createTestOrg('Webhook Fail Org');
    const user = await createTestUser(org.id, `fail-${now}@example.com`, 'ORG_ADMIN');
    const actor = { userId: user.id, customerId: org.id };
    const key = await createKey({ name: 'fail-key', scopes: ['tickets.write'], ticketStore: 'default', customerIds: [org.id] }, actor);
    const wh = await createWebhook(key.id, { url: `http://127.0.0.1:${port}/fail`, events: ['ticket.created'] }, actor);

    for (let i = 1; i <= 4; i++) {
      await emitTicketEvent({ keyId: key.id, type: 'ticket.created', ticket: ticket(`x${i}`) });
      expect((await prisma.externalWebhook.findUniqueOrThrow({ where: { id: wh.id } })).failureCount).toBe(i);
    }
    // Still enabled after 4 — the FIFTH failure flips it off.
    await emitTicketEvent({ keyId: key.id, type: 'ticket.created', ticket: ticket('x5') });
    const row = await prisma.externalWebhook.findUniqueOrThrow({ where: { id: wh.id } });
    expect(row.enabled).toBe(false);
    expect(row.failureCount).toBe(5);

    // The auto-disable is audited, and the disabled hook now gets NO further deliveries.
    const audited = await prisma.auditLog.findFirst({
      where: { action: 'EXTERNAL_WEBHOOK_UPDATED', targetId: wh.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audited, 'the disable itself must be in the audit log').toBeDefined();
    expect(audited!.metadata).toMatchObject({ disabled: true, failures: 5 });
    const before = history.length;
    await emitTicketEvent({ keyId: key.id, type: 'ticket.created', ticket: ticket('x6') });
    expect(history.length, 'a disabled hook must not receive further delivery attempts').toBe(before);
  });
});