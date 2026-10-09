import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import { createTestOrg, createTestUser, loginAs, cleanDb, app, request } from './helpers';
import { prisma } from '../src/config/database';
import { encryptSecret, hashApiKey } from '../src/config/slackCrypto';

// ─── Remote Slack host-worker control API (ADR-002) ─────────────────────────
// A worker on client infrastructure signs every call with its `wrk_` key over
// `${ts}\nMETHOD\npath\nsha256(rawBody)` — the same canonical string the squid
// agent protocol uses. Exercises: one-time provisioning, instance lease/commands,
// message routing, and the admin key lifecycle.

function hmacSig(rawKey: string, method: string, url: string, ts: string, rawBody: Buffer): string {
  const sha = crypto.createHash('sha256').update(rawBody).digest('hex');
  const canonical = `${ts}\n${method}\n${url}\n${sha}`;
  return crypto.createHmac('sha256', rawKey).update(canonical).digest('hex');
}

/** POST to a /api/bot-worker path exactly the way a host worker would sign it. */
function workerPost(path: string, rawKey: string, body?: object) {
  const ts = String(Date.now());
  const raw = body === undefined ? '' : JSON.stringify(body);
  const sig = hmacSig(rawKey, 'POST', path, ts, Buffer.from(raw));
  const req = request(app).post(path).set('X-Worker-Timestamp', ts).set('Authorization', `Bearer ${sig}`);
  return body === undefined ? req : req.send(body);
}

async function staffFixture() {
  const org = await createTestOrg('Platform Vendor');
  await createTestUser(org.id, 'boss@example.com', 'ADMINISTRATOR', 'administration');
  const cookies = await loginAs('boss@example.com');
  return { org, cookies };
}

async function botFixture(name = 'Host Bot', executionOwner: 'PLATFORM' | 'HOST_WORKER' = 'HOST_WORKER') {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.slackBot.create({
    data: {
      name, slug,
      botTokenEnc: encryptSecret('xoxb-test-token'),
      appTokenEnc: encryptSecret('xapp-test-token'),
      executionOwner,
    },
  });
}

/** Provision a wrk_ key straight at the row (bypasses the admin surface). */
async function grantWorkerKey(botId: string): Promise<string> {
  const raw = `wrk_${crypto.randomBytes(32).toString('hex')}`;
  await prisma.slackBot.update({
    where: { id: botId },
    data: { workerKeyHash: hashApiKey(raw), workerKeyEnc: encryptSecret(raw), workerKeyHint: raw.slice(0, 5) },
  });
  return raw;
}

describe('Slack host-worker control API (ADR-002)', () => {
  beforeEach(cleanDb);
  afterAll(async () => { await prisma.$disconnect(); });

  it('mints a wrk_ key and provisions the bot once (same-instance retry recovers)', async () => {
    const { cookies } = await staffFixture();
    const bot = await botFixture();

    const mint = await request(app).post(`/api/slack-bots/${bot.id}/worker-key`).set('Cookie', cookies);
    expect(mint.status).toBe(200);
    expect(mint.body.workerKey).toMatch(/^wrk_/);
    expect(mint.body.workerKeyHint).toMatch(/^wrk_/);

    const path = `/api/bot-worker/${bot.id}/provision`;
    const first = await workerPost(path, mint.body.workerKey, { instanceId: 'host-a-0001' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ botId: bot.id, botToken: 'xoxb-test-token', appToken: 'xapp-test-token', instanceId: 'host-a-0001' });

    // A second, distinct host instance must be refused.
    const second = await workerPost(path, mint.body.workerKey, { instanceId: 'host-b-0002' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ALREADY_PROVISIONED');

    // Same instance re-provisions after a lost response.
    const retry = await workerPost(path, mint.body.workerKey, { instanceId: 'host-a-0001' });
    expect(retry.status).toBe(200);

    const row = await prisma.slackBot.findUnique({ where: { id: bot.id } });
    expect(row?.workerProvisionedAt).not.toBeNull();
    expect(row?.activeInstance).toBe('host-a-0001');
  });

  it('rejects unsigned, mis-signed, stale, and unset-key requests without leaking state', async () => {
    const bot = await botFixture();
    const path = `/api/bot-worker/${bot.id}/heartbeat`;

    const noKey = await workerPost(path, 'wrk_00000000000000000000000000000000', { status: 'CONNECTED', instanceId: 'x-1' });
    expect(noKey.status).toBe(401);
    expect(noKey.body.code).toBe('WORKER_KEY_NOT_SET');

    const key = await grantWorkerKey(bot.id);

    // wrong signature / wrong key
    const badSig = await workerPost(path, `${key}ff`, { status: 'CONNECTED', instanceId: 'x-2' });
    expect(badSig.status).toBe(401);

    // stale timestamp outside the 5-minute window
    const ts = String(Date.now() - 600_000);
    const raw = JSON.stringify({ status: 'CONNECTED', instanceId: 'x-3' });
    const stale = await request(app)
      .post(path).set('X-Worker-Timestamp', ts)
      .set('Authorization', `Bearer ${hmacSig(key, 'POST', path, ts, Buffer.from(raw))}`)
      .send({ status: 'CONNECTED', instanceId: 'x-3' });
    expect(stale.status).toBe(401);

    // unknown bot id (signature can't even be verified)
    const ghost = await workerPost('/api/bot-worker/does-not-exist/heartbeat', key, { status: 'CONNECTED', instanceId: 'x-4' });
    expect(ghost.status).toBe(401);

    // a failed signature must NOT have flipped the bot's health.
    const row = await prisma.slackBot.findUnique({ where: { id: bot.id } });
    expect(row?.lastCheckedAt).toBeNull();
    expect(row?.activeInstance).toBeNull();
  });

  it('heartbeat writes status + instance lease and returns lifecycle commands', async () => {
    const bot = await botFixture();
    const key = await grantWorkerKey(bot.id);
    const path = `/api/bot-worker/${bot.id}/heartbeat`;

    const ok = await workerPost(path, key, { status: 'CONNECTED', socketConnected: true, instanceId: 'host-1', msgCount: 12 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, command: null, heartbeatIntervalMs: 30000 });
    let row = await prisma.slackBot.findUnique({ where: { id: bot.id } });
    expect(row?.status).toBe('CONNECTED');
    expect(row?.activeInstance).toBe('host-1');
    expect(row?.lastError).toBeNull();

    // a different instance gets told to die; the lease is untouched.
    const dup = await workerPost(path, key, { status: 'CONNECTED', instanceId: 'host-2' });
    expect(dup.status).toBe(200);
    expect(dup.body.command).toBe('disable');
    row = await prisma.slackBot.findUnique({ where: { id: bot.id } });
    expect(row?.activeInstance).toBe('host-1');

    // Slack tokens rotated → the live worker is told to re-provision.
    await prisma.slackBot.update({ where: { id: bot.id }, data: { workerRotationPending: true } });
    const rot = await workerPost(path, key, { status: 'CONNECTED', instanceId: 'host-1' });
    expect(rot.body.command).toBe('rotated');

    // ERROR persists lastError for the dashboard.
    await prisma.slackBot.update({ where: { id: bot.id }, data: { workerRotationPending: false } });
    const err = await workerPost(path, key, { status: 'ERROR', instanceId: 'host-1', lastError: 'socket died' });
    expect(err.status).toBe(200);
    expect(err.body.command).toBeNull();
    row = await prisma.slackBot.findUnique({ where: { id: bot.id } });
    expect(row?.status).toBe('ERROR');
    expect(row?.lastError).toBe('socket died');

    // disabled bot → disable.
    await prisma.slackBot.update({ where: { id: bot.id }, data: { enabled: false } });
    const dis = await workerPost(path, key, { status: 'CONNECTED', instanceId: 'host-1' });
    expect(dis.body.command).toBe('disable');

    // ownership handed back to the platform → disable; no stale status write.
    await prisma.slackBot.update({ where: { id: bot.id }, data: { enabled: true, executionOwner: 'PLATFORM' } });
    const plat = await workerPost(path, key, { status: 'CONNECTED', instanceId: 'host-1' });
    expect(plat.body.command).toBe('disable');
    row = await prisma.slackBot.findUnique({ where: { id: bot.id } });
    expect(row?.status).toBe('CONNECTED'); // untouched by the platform-owned heartbeat
  });

  it('routes forwarded Slack messages: link/unlink/chat and block_actions resolution', async () => {
    const bot = await botFixture();
    const key = await grantWorkerKey(bot.id);
    const path = `/api/bot-worker/${bot.id}/message`;

    // Valid-format link code that nobody issued → guidance, not an HTTP error.
    const badLink = await workerPost(path, key, { type: 'message', user: 'U01', channel: 'C01', text: 'link LINK-ABCDEF12' });
    expect(badLink.status).toBe(200);
    expect(badLink.body.reply).toContain('Code not recognized');

    const unlink = await workerPost(path, key, { type: 'message', user: 'U01', channel: 'C01', text: 'unlink' });
    expect(unlink.body.reply).toContain('No linked identity');

    // The agent is intentionally unconfigured in tests → friendly fallback.
    const chat = await workerPost(path, key, { type: 'message', user: 'U01', channel: 'C01', text: 'hello there' });
    expect(chat.status).toBe(200);
    expect(chat.body.reply).toMatch(/not configured/i);

    // Approval-card click from an unlinked Slack user → platform-side guidance
    // the worker posts to response_url.
    const click = await workerPost(path, key, {
      type: 'block_actions', user: 'U01', channel: 'C01',
      actions: [{ action_id: 'approve', value: 'ticket-1', type: 'button' }],
      response_url: 'https://hooks.slack.com/actions/T1/12345/abc',
    });
    expect(click.status).toBe(200);
    expect(click.body.updateCard).toContain('No platform account found');

    // Malformed events are rejected by the schema.
    const malformed = await workerPost(path, key, { type: 'nope', user: 'U01', channel: 'C01' });
    expect(malformed.status).toBe(400);
  });

  it('rotates and revokes the wrk_ key', async () => {
    const { cookies } = await staffFixture();
    const bot = await botFixture();
    const path = `/api/bot-worker/${bot.id}/provision`;

    const mint = await request(app).post(`/api/slack-bots/${bot.id}/worker-key`).set('Cookie', cookies);
    const key1 = mint.body.workerKey as string;
    expect((await workerPost(path, key1, { instanceId: 'host-1' })).status).toBe(200);

    // Rotate: new key works, old key is dead, and the provision gate is cleared
    // so the worker re-onboards from scratch.
    const rotated = await request(app).post(`/api/slack-bots/${bot.id}/worker-key`).set('Cookie', cookies);
    const key2 = rotated.body.workerKey as string;
    expect(key2).not.toBe(key1);
    expect((await workerPost(path, key1, { instanceId: 'host-1' })).status).toBe(401);
    expect((await workerPost(path, key2, { instanceId: 'host-1' })).status).toBe(200);
    let row = await prisma.slackBot.findUnique({ where: { id: bot.id } });
    expect(row?.activeInstance).toBe('host-1');

    // Revoke: nothing works, and the admin DTO reports no worker key.
    const revoke = await request(app).delete(`/api/slack-bots/${bot.id}/worker-key`).set('Cookie', cookies);
    expect(revoke.status).toBe(204);
    expect((await workerPost(path, key2, { instanceId: 'host-1' })).status).toBe(401);
    const dto = await request(app).get(`/api/slack-bots/${bot.id}`).set('Cookie', cookies);
    expect(dto.body.workerKeySet).toBe(false);
    expect(dto.body.workerKeyHint).toBeNull();
  });

  it('refuses provisioning until ownership is HOST_WORKER and blocks non-administrators', async () => {
    const { org, cookies } = await staffFixture();
    // Platform-owned bot: an admin may mint the key, but the worker cannot
    // provision until the connection ownership is explicitly transferred.
    const bot = await botFixture('Platform Bot', 'PLATFORM');
    const mint = await request(app).post(`/api/slack-bots/${bot.id}/worker-key`).set('Cookie', cookies);
    expect(mint.status).toBe(200);

    const path = `/api/bot-worker/${bot.id}/provision`;
    const prov = await workerPost(path, mint.body.workerKey, { instanceId: 'host-1' });
    expect(prov.status).toBe(409);
    expect(prov.body.code).toBe('OWNERSHIP_PLATFORM');

    // PATCH transfers ownership; provisioning then works.
    const patch = await request(app).patch(`/api/slack-bots/${bot.id}`).set('Cookie', cookies)
      .send({ executionOwner: 'HOST_WORKER' });
    expect(patch.status).toBe(200);
    expect(patch.body.executionOwner).toBe('HOST_WORKER');
    const prov2 = await workerPost(path, mint.body.workerKey, { instanceId: 'host-1' });
    expect(prov2.status).toBe(200);

    // A plain member may not mint/revoke worker keys.
    await createTestUser(org.id, 'member@example.com', 'USER');
    const memberC = await loginAs('member@example.com');
    const denied = await request(app).post(`/api/slack-bots/${bot.id}/worker-key`).set('Cookie', memberC);
    expect(denied.status).toBe(403);
    const deniedDel = await request(app).delete(`/api/slack-bots/${bot.id}/worker-key`).set('Cookie', memberC);
    expect(deniedDel.status).toBe(403);
  });
});