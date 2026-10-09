import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import {
  createTestOrg, createTestUser, loginAs, cleanDb,
  ticketTestDbReady, ticketDbSkipReason, app, request,
} from './helpers';
import { prisma } from '../src/config/database';
import { encryptSecret, hashApiKey } from '../src/config/slackCrypto';
import { approveTicket, declineTicket } from '../src/modules/ticketing/ticketing.service';
import { getOrCreateSquidBotUser } from '../src/modules/squid/squid.service';
import { syncBotChangeRequests } from '../src/modules/squid/squidBot.service';
import { notifyApprovalCardForSquidChange } from '../src/modules/slack-bots/slackApprovals';

// Approval cards are asserted against a captured WebClient: the card poster must
// hand the DECRYPTED bot token to Slack (botTokenEnc is AES-GCM ciphertext), so
// the capture doubles as a regression test for the decrypt fix. Per-file module
// registry — nothing else in this suite talks to Slack anyway.
const slackMock = vi.hoisted(() => ({
  postMessage: vi.fn(async (_args: { channel?: string }) => ({ ok: true })),
  tokens: [] as string[],
}));

vi.mock('@slack/web-api', () => ({
  WebClient: class {
    token: string;
    chat: { postMessage: (args: { channel?: string }) => Promise<unknown> };
    constructor(token: string) {
      this.token = token;
      this.chat = {
        postMessage: (args) => { slackMock.tokens.push(token); return slackMock.postMessage(args); },
      };
    }
  },
}));

// ─── Squid host bot seam (plan v2) ───────────────────────────────────────────
// The bot is the executor, the platform is the system of record: /request
// latches a pending-approval ticket + change request, the /state poll detects
// the ticket decision (approval anywhere), dispatches exactly one command into
// the ledger, and only the bot's /command-result ack reaches APPLIED.
//
// Two suites: the dialect gates + state machine touch only the main DB; the
// request→approval→execution loop needs the ticket stores (skip with a reason).

function hmacSig(rawKey: string, method: string, url: string, ts: string, rawBody: Buffer): string {
  const sha = crypto.createHash('sha256').update(rawBody).digest('hex');
  const canonical = `${ts}\n${method}\n${url}\n${sha}`;
  return crypto.createHmac('sha256', rawKey).update(canonical).digest('hex');
}

/** POST to a /api/bot-worker path exactly the way the host bot signs it. */
function workerPost(path: string, rawKey: string, body?: object) {
  const ts = String(Date.now());
  const raw = body === undefined ? '' : JSON.stringify(body);
  const sig = hmacSig(rawKey, 'POST', path, ts, Buffer.from(raw));
  const req = request(app).post(path).set('X-Worker-Timestamp', ts).set('Authorization', `Bearer ${sig}`);
  return body === undefined ? req : req.send(body);
}

const stateBody = (instanceId: string, extra: Record<string, unknown> = {}) => ({
  instanceId, status: 'CONNECTED', socketConnected: true, ...extra,
});

async function orgFixture(name: string, email: string) {
  const org = await createTestOrg(name);
  const user = await createTestUser(org.id, email, 'ORG_ADMIN');
  const cookies = await loginAs(email);
  return { org, user, cookies };
}

async function squidBotFixture(mode: 'SQUID_BOT' | 'SLACK_THIN' = 'SQUID_BOT') {
  const slug = `squid-bot-${Math.random().toString(36).slice(2, 8)}`;
  const bot = await prisma.slackBot.create({
    data: {
      name: 'Squid Host Bot', slug,
      botTokenEnc: encryptSecret('xoxb-squid-token'),
      executionOwner: 'HOST_WORKER',
      workerMode: mode,
    },
  });
  const raw = `wrk_${crypto.randomBytes(32).toString('hex')}`;
  await prisma.slackBot.update({
    where: { id: bot.id },
    data: { workerKeyHash: hashApiKey(raw), workerKeyEnc: encryptSecret(raw), workerKeyHint: raw.slice(0, 5) },
  });
  return { bot, key: raw };
}

async function proxyFixture(orgId: string, name = 'managed') {
  return prisma.squidProxy.create({ data: { customerId: orgId, name, status: 'PENDING' } });
}

async function linkBot(botId: string, customerId: string, squidProxyId: string | null = null) {
  // approvalChannelId stays null in tests: the card path is best-effort and
  // would otherwise attempt a live Slack post per approval ticket.
  return prisma.slackBotOrg.create({
    data: { botId, customerId, squidProxyId, approvalChannelId: null },
  });
}

const allowBody = {
  type: 'allow',
  payload: { ip: '10.0.0.5', domain: 'example.com', hours: 24 },
  requester: { slackUserId: 'U-ALICE', slackUserName: 'alice', channelId: 'C-OPS' },
};

describe('Squid host bot — dialect gates and state machine', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it('SQUID_BOT cannot provision/heartbeat; SLACK_THIN cannot request/state/command-result', async () => {
    const squid = await squidBotFixture('SQUID_BOT');
    const prov = await workerPost(`/api/bot-worker/${squid.bot.id}/provision`, squid.key, { instanceId: 'host-0001' });
    expect(prov.status).toBe(409);
    expect(prov.body.code).toBe('BOT_MODE_SQUID');
    const hb = await workerPost(`/api/bot-worker/${squid.bot.id}/heartbeat`, squid.key, { status: 'CONNECTED', instanceId: 'host-0001' });
    expect(hb.status).toBe(409);
    expect(hb.body.code).toBe('BOT_MODE_SQUID');

    const thin = await squidBotFixture('SLACK_THIN');
    for (const route of ['request', 'state', 'command-result']) {
      const res = await workerPost(`/api/bot-worker/${thin.bot.id}/${route}`, thin.key, {});
      expect(res.status, route).toBe(409);
      expect(res.body.code, route).toBe('BOT_MODE_SLACK_THIN');
    }
  });

  it('free text is rejected for squid bots while forwarded block_actions still resolve', async () => {
    const { bot, key } = await squidBotFixture('SQUID_BOT');

    const free = await workerPost(`/api/bot-worker/${bot.id}/message`, key,
      { type: 'message', user: 'U01', channel: 'C01', text: 'hello there' });
    expect(free.status).toBe(409);
    expect(free.body.code).toBe('BOT_MODE_SQUID');

    // The approval-card click path must keep working (D3) — same platform
    // resolution as the thin worker, unlinked Slack user → guidance, not a 500.
    const click = await workerPost(`/api/bot-worker/${bot.id}/message`, key, {
      type: 'block_actions', user: 'U01', channel: 'C01',
      actions: [{ action_id: 'approve', value: 'ticket-1', type: 'button' }],
      response_url: 'https://hooks.slack.com/actions/T1/12345/abc',
    });
    expect(click.status).toBe(200);
    expect(click.body.updateCard).toContain('No platform account found');
  });

  it('/state enforces the instance lease, upserts latest telemetry, mirrors rules, audits transitions only', async () => {
    const { org } = await orgFixture('State Org', 'state@test.dev');
    const proxy = await proxyFixture(org.id);
    const { bot, key } = await squidBotFixture();
    await linkBot(bot.id, org.id, proxy.id);
    const path = `/api/bot-worker/${bot.id}/state`;

    const first = await workerPost(path, key, stateBody('host-0001'));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, command: null, commands: [], heartbeatIntervalMs: 30_000 });

    let row = await prisma.slackBot.findUnique({ where: { id: bot.id } });
    expect(row?.status).toBe('CONNECTED');
    expect(row?.activeInstance).toBe('host-0001');
    const stateRow = await prisma.squidBotState.findUnique({ where: { botId: bot.id } });
    expect(stateRow?.status).toBe('CONNECTED');
    expect(stateRow?.proxyId).toBe(proxy.id);

    // Transition audited exactly once — never per poll (30s × bots would flood).
    expect(await prisma.auditLog.count({ where: { action: 'SQUID_BOT_STATE' } })).toBe(1);
    await workerPost(path, key, stateBody('host-0001'));
    expect(await prisma.auditLog.count({ where: { action: 'SQUID_BOT_STATE' } })).toBe(1);

    // A second instance is told to die and writes nothing.
    const dup = await workerPost(path, key, stateBody('host-0002'));
    expect(dup.body.command).toBe('disable');
    row = await prisma.slackBot.findUnique({ where: { id: bot.id } });
    expect(row?.activeInstance).toBe('host-0001');

    // Rules: full snapshot replaces, a delta removes (host-side expiry path).
    const expires = Math.floor(Date.now() / 1000) + 5 * 3600;
    const snap = await workerPost(path, key, stateBody('host-0001', {
      rules: [{ ip: '10.0.0.5', domain: 'example.com', expires }],
    }));
    expect(snap.status).toBe(200);
    expect(await prisma.squidBotRule.count({ where: { botId: bot.id } })).toBe(1);
    const delta = await workerPost(path, key, stateBody('host-0001', {
      rulesDelta: [{ op: 'down', ip: '10.0.0.5', domain: 'example.com' }],
    }));
    expect(delta.status).toBe(200);
    expect(await prisma.squidBotRule.count({ where: { botId: bot.id } })).toBe(0);

    // Disabled → disable, still no writes.
    await prisma.slackBot.update({ where: { id: bot.id }, data: { enabled: false } });
    const dis = await workerPost(path, key, stateBody('host-0001'));
    expect(dis.body.command).toBe('disable');
    expect(dis.body.commands).toEqual([]);
  });

  it('an unlinked bot reports health but never crashes on scope errors (D10 tolerance)', async () => {
    const { bot, key } = await squidBotFixture();
    const res = await workerPost(`/api/bot-worker/${bot.id}/state`, key, stateBody('host-0001'));
    expect(res.status).toBe(200);
    expect(res.body.command).toBeNull();
    // No customerId anywhere → no state row and no transition audit…
    expect(await prisma.squidBotState.findUnique({ where: { botId: bot.id } })).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'SQUID_BOT_STATE' } })).toBe(0);
    // …but the health columns still update.
    const row = await prisma.slackBot.findUnique({ where: { id: bot.id } });
    expect(row?.status).toBe('CONNECTED');
  });

  it('five bad signatures on /request auto-disable the bot; a valid key then gets BOT_DISABLED', async () => {
    const { bot, key } = await squidBotFixture();
    const { org } = await orgFixture('Brute Org', 'brute@test.dev');
    await linkBot(bot.id, org.id, null); // linked → every failed signature audits
    const path = `/api/bot-worker/${bot.id}/request`;
    const body = { type: 'allow', payload: { ip: '10.0.0.5', domain: 'example.com' }, requester: { slackUserId: 'U-BRUTE' } };

    for (let i = 0; i < 5; i++) {
      const bad = await workerPost(path, `${key}tampered`, body);
      expect(bad.status).toBe(401);
    }
    expect((await prisma.slackBot.findUnique({ where: { id: bot.id } }))?.enabled).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'WORKER_AUTH_FAILED' } })).toBe(5);

    // The key itself is fine now — the disable is what refuses the request,
    // proving the gate is the bot state and not a corrupted signature.
    const after = await workerPost(path, key, body);
    expect(after.status).toBe(409);
    expect(after.body.code).toBe('BOT_DISABLED');
    expect(await prisma.squidChangeRequest.count()).toBe(0);
  });

  it('the ops snapshot route is session-authed, admin-only, and 404s unknown bots', async () => {
    const { org } = await orgFixture('Ops Org', 'ops-orgadmin@test.dev');
    await createTestUser(org.id, 'ops-admin@test.dev', 'ADMINISTRATOR', 'administration');
    const proxy = await proxyFixture(org.id);
    const { bot } = await squidBotFixture();
    await linkBot(bot.id, org.id, proxy.id);

    // Seed the snapshot directly — this test is about the route, not the poll.
    const cr = await prisma.squidChangeRequest.create({
      data: {
        proxyId: proxy.id, customerId: org.id, source: 'SLACK', action: 'BOT_ALLOW',
        summary: 'ops fixture', details: {}, status: 'DISPATCHED',
      },
    });
    await prisma.squidBotCommand.create({
      data: {
        botId: bot.id, customerId: org.id, proxyId: proxy.id, changeRequestId: cr.id,
        type: 'ALLOW', payload: { ip: '10.0.0.9', domain: 'ops.example.com' }, status: 'DISPATCHED',
      },
    });
    await prisma.squidBotState.create({
      data: {
        botId: bot.id, customerId: org.id, proxyId: proxy.id,
        instanceId: 'host-0009', status: 'CONNECTED', raw: { note: 'raw-snapshot' },
      },
    });

    const path = `/api/bot-worker/${bot.id}/status`;
    expect((await request(app).get(path)).status).toBe(401);           // no session
    const orgC = await loginAs('ops-orgadmin@test.dev');
    expect((await request(app).get(path).set('Cookie', orgC)).status).toBe(403); // customer roles never see ops
    const adminC = await loginAs('ops-admin@test.dev');
    const ok = await request(app).get(path).set('Cookie', adminC);
    expect(ok.status).toBe(200);
    expect(ok.body.bot).toMatchObject({ id: bot.id, workerMode: 'SQUID_BOT', enabled: true });
    expect(ok.body.state.raw.note).toBe('raw-snapshot');
    expect(ok.body.commands).toHaveLength(1);
    expect(ok.body.commands[0]).toMatchObject({ status: 'DISPATCHED', type: 'ALLOW' });

    const missing = await request(app).get('/api/bot-worker/no-such-bot/status').set('Cookie', adminC);
    expect(missing.status).toBe(404);
  });

  it('approval cards skip without a channel and otherwise post with the DECRYPTED token', async () => {
    const { org } = await orgFixture('Card Org', 'card@test.dev');
    const proxy = await proxyFixture(org.id);
    const { bot } = await squidBotFixture();
    await linkBot(bot.id, org.id, proxy.id); // approvalChannelId null
    const dto = {
      id: 'ticket-card-1', ticketNumber: 'T-42', title: 'Squid Config: BOT_ALLOW',
      description: 'allow 10.0.0.5', priority: 'medium', type: 'task',
    } as unknown as Parameters<typeof notifyApprovalCardForSquidChange>[0];

    // No approval channel → nothing reaches Slack (linkBot's default in tests).
    await notifyApprovalCardForSquidChange(dto, org.id, proxy.id);
    expect(slackMock.postMessage).not.toHaveBeenCalled();

    // With a channel → posted once, to that channel, with the decrypted token —
    // NOT the stored AES-GCM ciphertext.
    await prisma.slackBotOrg.update({
      where: { botId_customerId: { botId: bot.id, customerId: org.id } },
      data: { approvalChannelId: 'C-CARD' },
    });
    await notifyApprovalCardForSquidChange(dto, org.id, proxy.id);
    expect(slackMock.postMessage).toHaveBeenCalledTimes(1);
    expect(slackMock.tokens[0]).toBe('xoxb-squid-token');
    expect(slackMock.postMessage.mock.calls[0]![0].channel).toBe('C-CARD');
  });
});

const ready = ticketTestDbReady();

describe.skipIf(!ready)(`Squid host bot — request → approval → execution${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, () => {
  beforeEach(cleanDb);
  afterAll(async () => { await cleanDb(); await prisma.$disconnect(); });

  async function fixture() {
    const { org, user, cookies } = await orgFixture('Bot Seam Org', 'seam@test.dev');
    const proxy = await proxyFixture(org.id);
    const { bot, key } = await squidBotFixture();
    await linkBot(bot.id, org.id, proxy.id);
    return { org, user, cookies, proxy, bot, key };
  }

  const requestPath = (botId: string) => `/api/bot-worker/${botId}/request`;
  const statePath = (botId: string) => `/api/bot-worker/${botId}/state`;

  it('/request latches a pending approval ticket + change request + audit', async () => {
    const { bot, key, proxy } = await fixture();
    const res = await workerPost(requestPath(bot.id), key, allowBody);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending_approval' });
    expect(res.body.ticketNumber).toBeTruthy();
    expect(res.body.webUrl).toMatch(/^\/tickets\//);

    const cr = await prisma.squidChangeRequest.findUnique({ where: { id: res.body.changeRequestId } });
    expect(cr).toMatchObject({
      status: 'PENDING_APPROVAL', action: 'BOT_ALLOW', source: 'SLACK',
      proxyId: proxy.id, ticketId: expect.any(String),
    });
    const details = cr!.details as Record<string, any>;
    expect(details.requester).toMatchObject({ kind: 'slack', slackUserId: 'U-ALICE', channelId: 'C-OPS' });
    expect(details.via).toBe('slack-host-worker');
    expect(details.isDestIp).toBe(false);
    expect(cr!.summary).toBe('[ALLOW] 10.0.0.5 → example.com (24h) — @alice (Slack)');
    expect(await prisma.auditLog.count({ where: { action: 'SQUID_CHANGE_REQUESTED' } })).toBe(1);

    // Shared validation — rejects exactly what the bot's own parser rejects.
    const cases = [
      { type: 'extend', payload: { ip: '10.0.0.5', domain: 'example.com' } },            // extend needs hours
      { type: 'deny', payload: { ip: '10.0.0.5', domain: 'example.com', hours: 3 } },    // deny takes no hours
      { type: 'allow', payload: { ip: 'not-an-ip', domain: 'example.com' } },            // bad client IP
      { type: 'allow', payload: { ip: '10.0.0.5' } },                                    // allow needs a target
      { type: 'allow', payload: { ip: '10.0.0.5', domain: '10.0.0.0/24' } },             // CIDR never slips through
    ];
    for (const body of cases) {
      const bad = await workerPost(requestPath(bot.id), key, { ...body, requester: { slackUserId: 'U-ALICE' } });
      expect(bad.status, JSON.stringify(body)).toBe(400);
      expect(bad.body.code).toBe('VALIDATION_ERROR');
    }
    // Rejected requests latch nothing.
    expect(await prisma.squidChangeRequest.count()).toBe(1);
  });

  it('D10 scope: 0 links / >1 links / ambiguous proxy are 409, never a guess', async () => {
    const { bot, key } = await squidBotFixture();
    const body = { type: 'full-net', payload: { ip: '10.1.1.1' }, requester: { slackUserId: 'U-X' } };

    const unlinked = await workerPost(requestPath(bot.id), key, body);
    expect(unlinked.status).toBe(409);
    expect(unlinked.body.code).toBe('bot_org_not_linked');

    const a = await orgFixture('Scope A', 'scope-a@test.dev');
    const b = await orgFixture('Scope B', 'scope-b@test.dev');
    await linkBot(bot.id, a.org.id, null);
    await linkBot(bot.id, b.org.id, null);
    const doubled = await workerPost(requestPath(bot.id), key, body);
    expect(doubled.status).toBe(409);
    expect(doubled.body.code).toBe('bot_org_misconfigured');

    // One link, but the org owns two proxies and the link names none.
    await prisma.slackBotOrg.deleteMany({ where: { botId: bot.id } });
    await proxyFixture(a.org.id, 'office-one');
    await proxyFixture(a.org.id, 'office-two');
    await linkBot(bot.id, a.org.id, null);
    const ambiguous = await workerPost(requestPath(bot.id), key, body);
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.code).toBe('bot_proxy_ambiguous');
    expect(await prisma.squidChangeRequest.count()).toBe(0);
  });

  it('approval anywhere dispatches exactly once; the ack finalizes idempotently', async () => {
    const { bot, key } = await fixture();
    const req = await workerPost(requestPath(bot.id), key, allowBody);
    expect(req.status).toBe(201);
    const crId = req.body.changeRequestId as string;
    const pendingRow = await prisma.squidChangeRequest.findUnique({ where: { id: crId } });
    const ticketId = pendingRow!.ticketId!;

    await approveTicket(ticketId, await getOrCreateSquidBotUser());

    // The very next poll syncs the approval AND delivers the command —
    // zero added latency, no separate approval callback.
    const s1 = await workerPost(statePath(bot.id), key, stateBody('host-0001'));
    expect(s1.status).toBe(200);
    expect(s1.body.commands).toHaveLength(1);
    const cmd = s1.body.commands[0];
    expect(cmd).toMatchObject({
      type: 'allow',
      payload: { ip: '10.0.0.5', domain: 'example.com', is_dest_ip: false, hours: 24 },
    });
    expect((await prisma.squidChangeRequest.findUnique({ where: { id: crId } }))?.status).toBe('DISPATCHED');
    const ledger = await prisma.squidBotCommand.findUnique({ where: { changeRequestId: crId } });
    expect(ledger?.status).toBe('DISPATCHED');
    expect(await prisma.auditLog.count({ where: { action: 'SQUID_CHANGE_APPROVED' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'SQUID_BOT_COMMAND_SENT' } })).toBe(1);

    // At-least-once delivery: unacked commands ride every poll, one row only.
    const s2 = await workerPost(statePath(bot.id), key, stateBody('host-0001'));
    expect(s2.body.commands).toHaveLength(1);
    expect(s2.body.commands[0].id).toBe(cmd.id);
    expect(await prisma.squidBotCommand.count({ where: { botId: bot.id } })).toBe(1);

    // Ack flips BOTH sides and comments the receipt onto the ticket.
    const ack = await workerPost(`/api/bot-worker/${bot.id}/command-result`, key,
      { commandId: cmd.id, ok: true, detail: 'squid reloaded' });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ ok: true, late: false, commandStatus: 'ACKED' });
    expect((await prisma.squidChangeRequest.findUnique({ where: { id: crId } }))?.status).toBe('APPLIED');
    expect((await prisma.squidBotCommand.findUnique({ where: { id: cmd.id } }))?.status).toBe('ACKED');

    // Repeated acks are idempotent: no state change, no double audit.
    const again = await workerPost(`/api/bot-worker/${bot.id}/command-result`, key, { commandId: cmd.id, ok: true });
    expect(again.status).toBe(200);
    expect(again.body.commandStatus).toBe('ACKED');
    expect((await prisma.squidChangeRequest.findUnique({ where: { id: crId } }))?.status).toBe('APPLIED');
    expect(await prisma.auditLog.count({ where: { action: 'SQUID_CHANGE_APPLIED' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'SQUID_BOT_COMMAND_SENT' } })).toBe(1);

    // Inbox empty afterwards.
    const s3 = await workerPost(statePath(bot.id), key, stateBody('host-0001'));
    expect(s3.body.commands).toEqual([]);
  });

  it('a declined ticket never dispatches', async () => {
    const { bot, key } = await fixture();
    const req = await workerPost(requestPath(bot.id), key, {
      type: 'deny', payload: { ip: '10.0.0.7', domain: 'bad.example.com' },
      requester: { slackUserId: 'U-BOB' },
    });
    expect(req.status).toBe(201);
    const crId = req.body.changeRequestId as string;
    const cr = await prisma.squidChangeRequest.findUnique({ where: { id: crId } });
    await declineTicket(cr!.ticketId!, await getOrCreateSquidBotUser(), 'not today');

    const s = await workerPost(statePath(bot.id), key, stateBody('host-0001'));
    expect(s.body.commands).toEqual([]);
    expect((await prisma.squidChangeRequest.findUnique({ where: { id: crId } }))?.status).toBe('REJECTED');
    expect(await prisma.squidBotCommand.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'SQUID_CHANGE_REJECTED' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'SQUID_BOT_COMMAND_SENT' } })).toBe(0);
  });

  it('the web door shares the core: 201 receipt, list syncs approval, status endpoint reports the bot', async () => {
    const { org, user, cookies, proxy, bot } = await fixture();

    const res = await request(app).post(`/api/squid/${proxy.id}/change-requests`).set('Cookie', cookies)
      .send({ action: 'allow', ip: '10.9.9.9', domain: 'wiki.example.com', hours: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending_approval' });
    expect(res.body.ticketNumber).toBeTruthy();
    const crId = res.body.changeRequestId as string;

    const cr = await prisma.squidChangeRequest.findUnique({ where: { id: crId } });
    expect(cr).toMatchObject({ source: 'WEB', action: 'BOT_ALLOW', actorId: user.id });
    const details = cr!.details as Record<string, any>;
    expect(details.via).toBe('web-app');
    expect(details.requester).toMatchObject({ kind: 'web', userId: user.id });
    expect(cr!.summary).toContain('(web)');

    // Same shared validation on the web door.
    const bad = await request(app).post(`/api/squid/${proxy.id}/change-requests`).set('Cookie', cookies)
      .send({ action: 'lock-net', ip: '10.9.9.9', domain: 'x.example.com' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');

    // A plain member cannot write.
    await createTestUser(org.id, 'seam-member@test.dev', 'USER');
    const memberC = await loginAs('seam-member@test.dev');
    const denied = await request(app).post(`/api/squid/${proxy.id}/change-requests`).set('Cookie', memberC)
      .send({ action: 'allow', ip: '10.9.9.9', domain: 'a.example.com' });
    expect(denied.status).toBe(403);

    // Cross-tenant aim at another org's proxy → 404, never a write.
    const other = await orgFixture('Other Tenant', 'other-tenant@test.dev');
    const otherProxy = await proxyFixture(other.org.id, 'theirs');
    const cross = await request(app).post(`/api/squid/${otherProxy.id}/change-requests`).set('Cookie', cookies)
      .send({ action: 'allow', ip: '10.9.9.9', domain: 'a.example.com' });
    expect(cross.status).toBe(404);

    // Approving on the web (ticket UI door) → the LIST endpoint itself syncs
    // the decision into a dispatched command.
    const approved = await prisma.squidChangeRequest.findUnique({ where: { id: crId } });
    await approveTicket(approved!.ticketId!, await getOrCreateSquidBotUser());
    const list = await request(app).get(`/api/squid/${proxy.id}/change-requests`).set('Cookie', cookies);
    expect(list.status).toBe(200);
    expect(list.body.changeRequests.find((c: { id: string }) => c.id === crId)?.status).toBe('DISPATCHED');

    // Dashboard status endpoint: bot health + ledger + rules summary.
    const status = await request(app).get(`/api/squid/${proxy.id}/status`).set('Cookie', cookies);
    expect(status.status).toBe(200);
    expect(status.body.linked).toBe(true);
    expect(status.body.bot.id).toBe(bot.id);
    expect(status.body.commands.dispatched).toBe(1);
    expect(status.body.rules).toEqual({ active: 0, expiringIn24h: 0 });

    // Unlinked proxy → linked:false rather than a 404-shaped hole.
    const loneProxy = await proxyFixture(org.id, 'unmanaged');
    const unlinked = await request(app).get(`/api/squid/${loneProxy.id}/status`).set('Cookie', cookies);
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.linked).toBe(false);
  });

  it('a locked proxy refuses both doors with 423 SQUID_LOCKED', async () => {
    const { org, cookies, proxy, bot, key } = await fixture();
    const svc = await prisma.customerService.create({
      data: { customerId: org.id, name: 'Squid License', monthlyPrice: 0, endDate: new Date(Date.now() - 1000) },
    });
    await prisma.squidProxy.update({ where: { id: proxy.id }, data: { customerServiceId: svc.id, status: 'PENDING' } });

    const slack = await workerPost(requestPath(bot.id), key,
      { type: 'lock-net', payload: { ip: '10.2.2.2' }, requester: { slackUserId: 'U-C' } });
    expect(slack.status).toBe(423);
    expect(slack.body.code).toBe('SQUID_LOCKED');

    const web = await request(app).post(`/api/squid/${proxy.id}/change-requests`).set('Cookie', cookies)
      .send({ action: 'lock-net', ip: '10.2.2.2' });
    expect(web.status).toBe(423);
    expect(web.body.code).toBe('SQUID_LOCKED');

    // Nothing latched while read-only.
    expect(await prisma.squidChangeRequest.count()).toBe(0);
  });

  it('an unacked dispatch times out into a failed CR — and a late ok recovers it', async () => {
    const { bot, key } = await fixture();
    const req = await workerPost(requestPath(bot.id), key, allowBody);
    const crId = req.body.changeRequestId as string;
    const row = await prisma.squidChangeRequest.findUnique({ where: { id: crId } });
    await approveTicket(row!.ticketId!, await getOrCreateSquidBotUser());

    const s1 = await workerPost(statePath(bot.id), key, stateBody('host-0001'));
    expect(s1.body.commands).toHaveLength(1);
    const cmdId = s1.body.commands[0].id as string;

    // Pretend 16 minutes of silence (window is 15).
    await prisma.squidBotCommand.update({
      where: { id: cmdId },
      data: { dispatchedAt: new Date(Date.now() - 16 * 60_000) },
    });

    const s2 = await workerPost(statePath(bot.id), key, stateBody('host-0001'));
    expect(s2.body.commands).toEqual([]); // a timed-out command is never redelivered
    const cmd = await prisma.squidBotCommand.findUnique({ where: { id: cmdId } });
    expect(cmd?.status).toBe('TIMED_OUT');
    const cr = await prisma.squidChangeRequest.findUnique({ where: { id: crId } });
    expect(cr?.status).toBe('FAILED');
    expect(cr?.error).toContain('15 minutes');
    const failedAudit = await prisma.auditLog.findMany({ where: { action: 'SQUID_CHANGE_FAILED' } });
    expect(failedAudit).toHaveLength(1);
    expect((failedAudit[0]!.metadata as Record<string, unknown>).reason).toBe('dispatch-timeout');

    // The host WAS just slow: a late ok lifts the stale failure (FAILED → APPLIED).
    const late = await workerPost(`/api/bot-worker/${bot.id}/command-result`, key, { commandId: cmdId, ok: true });
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ ok: true, late: true, commandStatus: 'ACKED' });
    expect((await prisma.squidChangeRequest.findUnique({ where: { id: crId } }))?.status).toBe('APPLIED');
  });

  it('concurrent approval syncs create exactly one command (P2002-tolerant ledger)', async () => {
    const { bot, key, proxy } = await fixture();
    const req = await workerPost(requestPath(bot.id), key, allowBody);
    const crId = req.body.changeRequestId as string;
    const row = await prisma.squidChangeRequest.findUnique({ where: { id: crId } });
    await approveTicket(row!.ticketId!, await getOrCreateSquidBotUser());

    await Promise.all([
      syncBotChangeRequests({ proxyId: proxy.id }),
      syncBotChangeRequests({ proxyId: proxy.id }),
      syncBotChangeRequests({ proxyId: proxy.id }),
    ]);

    expect(await prisma.squidBotCommand.count({ where: { botId: bot.id } })).toBe(1);
    expect((await prisma.squidChangeRequest.findUnique({ where: { id: crId } }))?.status).toBe('DISPATCHED');
    expect(await prisma.auditLog.count({ where: { action: 'SQUID_BOT_COMMAND_SENT' } })).toBe(1);
  });

  it('acks may ride /state via requestContext instead of a separate round trip', async () => {
    const { bot, key } = await fixture();
    const req = await workerPost(requestPath(bot.id), key, allowBody);
    const crId = req.body.changeRequestId as string;
    const row = await prisma.squidChangeRequest.findUnique({ where: { id: crId } });
    await approveTicket(row!.ticketId!, await getOrCreateSquidBotUser());

    const s1 = await workerPost(statePath(bot.id), key, stateBody('host-0001'));
    expect(s1.body.commands).toHaveLength(1);
    const cmdId = s1.body.commands[0].id as string;

    // Piggybacked ack is processed BEFORE the inbox is claimed, so the acked
    // command never rides the same response it is confirming.
    const s2 = await workerPost(statePath(bot.id), key,
      stateBody('host-0001', { requestContext: { commandIdAcked: cmdId } }));
    expect(s2.status).toBe(200);
    expect(s2.body.commands).toEqual([]);
    expect((await prisma.squidBotCommand.findUnique({ where: { id: cmdId } }))?.status).toBe('ACKED');
    expect((await prisma.squidChangeRequest.findUnique({ where: { id: crId } }))?.status).toBe('APPLIED');
  });
});
