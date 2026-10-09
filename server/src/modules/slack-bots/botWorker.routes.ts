import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../../config/database';
import { decryptSecret, hashApiKey } from '../../config/slackCrypto';
import { audit } from '../../lib/audit';
import { authMiddleware } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/rbac.middleware';
import { CommandResultSchema, HeartbeatSchema, MessageSchema, ProvisionSchema, RequestSchema, StateSchema } from './botWorker.schema';
import { provisionWorker, workerHeartbeat, workerMessage } from './botWorker.service';
import { squidBotCommandResult, squidBotRequest, squidBotState } from '../squid/squidBot.service';

// ─── Host-worker control API (ADR-002 reverse control plane) ────────────────
// A host worker on client infrastructure talks ONLY to these routes, and only
// with its own bot's `wrk_` worker key. Each request is HMAC-SHA256 over
// `${ts}\n${METHOD}\n${path}\n${sha256(rawBody)}` keyed with the raw wrk_ key
// (encrypted copy lives in slackBots.workerKeyEnc). The 5-minute timestamp
// window makes a signed request un-replayable; the one-time provisioning gate
// and the instanceId lease make a second host impossible.
//
// Mounted BEFORE the cookie auth wall (app.ts) — a machine, not a session. The
// response body of POST /provision is the only place the bot's Slack tokens
// ever leave the platform, and only over this authenticated TLS channel.
//
// Communications with the remote bot are deliberately outbound-ONLY (443): a
// foreign network will not open an inbound port, and a plaintext token should
// never be shipped — so the worker calls home and the heartbeat IS the command
// channel (disable / rotated ride in its response).

const router = Router();

// In-memory consecutive-failure counter → auto-disable the bot on abuse. Same
// policy as the proxy agent (per-process memory; a PG counter could make the
// decision survive a restart).
const badAuthCount = new Map<string, number>();
const MAX_BAD_AUTH = 5;

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

interface WorkerBot {
  id: string;
  name: string;
  enabled: boolean;
  executionOwner: string;
  workerMode: string;
}

/** Verify the wrk_ key + request signature; attach the authenticated bot to req. */
export async function workerAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const botId = req.params['botId'] ?? '';
  const ts = Number(req.get('X-Worker-Timestamp'));
  const sig = (req.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const res401 = (code = 'WORKER_AUTH_FAILED') => { res.status(401).json({ error: 'Authentication failed', code }); };

  if (!botId || !sig || !Number.isFinite(ts) || Math.abs(Date.now() - ts) > 300_000) {
    res401();
    return;
  }
  const bot = await prisma.slackBot.findUnique({
    where: { id: botId },
    select: { id: true, name: true, enabled: true, executionOwner: true, workerMode: true, workerKeyHash: true, workerKeyEnc: true },
  });
  if (!bot?.workerKeyEnc || !bot.workerKeyHash) { res401('WORKER_KEY_NOT_SET'); return; }

  let raw: string;
  try { raw = decryptSecret(bot.workerKeyEnc); } catch { res401(); return; }

  // The decrypted raw key must still match the stored hash (constant-time) —
  // guards against the two columns ever diverging (one cleared, one not).
  const haveHash = Buffer.from(hashApiKey(raw));
  const wantHash = Buffer.from(bot.workerKeyHash);
  if (wantHash.length !== haveHash.length || !crypto.timingSafeEqual(wantHash, haveHash)) {
    res401();
    return;
  }

  const canonical = `${ts}\n${req.method}\n${req.originalUrl}\n${sha256((req as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0))}`;
  const expected = crypto.createHmac('sha256', raw).update(canonical).digest('hex');
  const ok = expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  if (!ok) {
    const n = (badAuthCount.get(botId) ?? 0) + 1;
    badAuthCount.set(botId, n);
    const org = await prisma.slackBotOrg.findFirst({ where: { botId }, select: { customerId: true } });
    if (org) {
      await audit({
        action: 'WORKER_AUTH_FAILED', performedById: null, customerId: org.customerId, targetId: botId,
        metadata: { reason: 'signature mismatch', ip: req.ip, attempts: n },
      }).catch(() => undefined);
    }
    if (n >= MAX_BAD_AUTH) {
      badAuthCount.delete(botId);
      await prisma.slackBot.update({ where: { id: botId }, data: { enabled: false } });
    }
    res401();
    return;
  }

  badAuthCount.delete(botId);
  (req as Request & { workerBot: WorkerBot }).workerBot = {
    id: bot.id, name: bot.name, enabled: bot.enabled, executionOwner: bot.executionOwner, workerMode: bot.workerMode,
  };
  next();
}

/**
 * Mode gate (risk: `workerMode` misuse opening the wrong dialect). SLACK_THIN
 * bots speak provision/heartbeat/message; SQUID_BOT speaks request/state/
 * command-result and forwards block_actions over `message` — but never free
 * text or token provisioning. The wrong combination is a 409, not a 404, so an
 * ops misconfiguration is obvious instead of looking like an attack.
 */
export function requireWorkerMode(mode: 'SLACK_THIN' | 'SQUID_BOT') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const bot = (req as Request & { workerBot?: WorkerBot }).workerBot;
    if (!bot) { res.status(401).json({ error: 'Authentication failed', code: 'WORKER_AUTH_FAILED' }); return; }
    if (bot.workerMode !== mode) {
      res.status(409).json({
        error: `This bot speaks the ${bot.workerMode} dialect, not ${mode}`,
        code: bot.workerMode === 'SQUID_BOT' ? 'BOT_MODE_SQUID' : 'BOT_MODE_SLACK_THIN',
      });
      return;
    }
    next();
  };
}

// First call ever — the one-time token handover. A second host instance is 409.
// SLACK_THIN only: a squid_bot holds its own tokens and never provisions (D4).
router.post('/:botId/provision', workerAuth, requireWorkerMode('SLACK_THIN'), async (req, res, next) => {
  try {
    const parsed = ProvisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message, code: 'VALIDATION_ERROR' }); return; }
    res.json(await provisionWorker(req.params['botId']!, parsed.data));
  } catch (e) { next(e); }
});

// Telemetry + instance lease; the response carries lifecycle commands.
// SLACK_THIN only — the squid bot's /state carries the same lease duties.
router.post('/:botId/heartbeat', workerAuth, requireWorkerMode('SLACK_THIN'), async (req, res, next) => {
  try {
    const parsed = HeartbeatSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message, code: 'VALIDATION_ERROR' }); return; }
    res.json(await workerHeartbeat(req.params['botId']!, parsed.data));
  } catch (e) { next(e); }
});

// One Slack event forwarded for platform-side resolution; the reply rides back.
// Both modes: thin workers bridge chat, the squid bot forwards block_actions
// (its own approval cards) — free-text rejection for squid bots lives in
// workerMessage so the card path keeps working (D3).
router.post('/:botId/message', workerAuth, async (req, res, next) => {
  try {
    const parsed = MessageSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message, code: 'VALIDATION_ERROR' }); return; }
    res.json(await workerMessage(req.params['botId']!, parsed.data));
  } catch (e) { next(e); }
});

// ─── Ops snapshot (plan §5.5: GET /api/bot-worker/:botId/status) ──────────────
// Mounted before the cookie wall like every other route here, so this ONE
// route carries its own session auth: administrator-only raw last snapshot
// (bot health + latest SquidBotState.raw + recent ledger rows) for debugging a
// misbehaving host without the worker key. No tenant middleware on this router,
// so no customerId injection — admins legitimately read cross-tenant.
router.get('/:botId/status', authMiddleware, requireRole('ADMINISTRATOR'), async (req, res, next) => {
  try {
    const bot = await prisma.slackBot.findUnique({
      where: { id: req.params['botId'] },
      select: {
        id: true, name: true, slug: true, enabled: true, status: true,
        workerMode: true, executionOwner: true, activeInstance: true,
        lastCheckedAt: true, lastError: true,
      },
    });
    if (!bot) { res.status(404).json({ error: 'Bot not found', code: 'NOT_FOUND' }); return; }
    const [state, commands] = await Promise.all([
      prisma.squidBotState.findUnique({ where: { botId: bot.id } }),
      prisma.squidBotCommand.findMany({
        where: { botId: bot.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    res.json({ bot, state, commands });
  } catch (e) { next(e); }
});

// ─── Squid host bot dialect (workerMode = SQUID_BOT) ─────────────────────────
// Plan v2 §5.1–5.3. Wrapping/validating is here; the state machine is
// squidBot.service (both doors + the ticket-status sync funnel into it).

// §5.1 Slack-originated change request → platform ticket + approval card.
router.post('/:botId/request', workerAuth, requireWorkerMode('SQUID_BOT'), async (req, res, next) => {
  try {
    const parsed = RequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message, code: 'VALIDATION_ERROR' }); return; }
    res.status(201).json(await squidBotRequest(req.params['botId']!, parsed.data));
  } catch (e) { next(e); }
});

// §5.2 every ~30 s: lease + latest state + rules mirror + approval sync; the
// response carries the command inbox (and disable, mirroring the heartbeat).
router.post('/:botId/state', workerAuth, requireWorkerMode('SQUID_BOT'), async (req, res, next) => {
  try {
    const parsed = StateSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message, code: 'VALIDATION_ERROR' }); return; }
    res.json(await squidBotState(req.params['botId']!, parsed.data));
  } catch (e) { next(e); }
});

// §5.3 execution outcome → command ACKED/FAILED, CR APPLIED/FAILED, ticket
// comment, org notification, audit.
router.post('/:botId/command-result', workerAuth, requireWorkerMode('SQUID_BOT'), async (req, res, next) => {
  try {
    const parsed = CommandResultSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message, code: 'VALIDATION_ERROR' }); return; }
    res.json(await squidBotCommandResult(req.params['botId']!, parsed.data));
  } catch (e) { next(e); }
});

export default router;