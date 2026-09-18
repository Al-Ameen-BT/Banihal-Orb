import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../../config/database';
import { decryptSecret } from '../../config/slackCrypto';
import { audit } from '../../lib/audit';
import { agentPoll, agentResult, agentBundlePublicKey, ingestTelemetry } from './squid.service';
import { AgentResultSchema, TelemetryIngestSchema } from './squid.schema';
import { notify } from '../notifications/notifications.service';

// ─── Agent control API ───────────────────────────────────────────────────────
// The per-host squid agent talks ONLY to these routes, and only with its own
// proxy id + request signature. Each request is HMAC-SHA256 over
// `${ts}\n${METHOD}\n${path}\n${sha256(rawBody)}` using the per-proxy raw
// registration key (the encrypted copy lives in squidProxies.regKeyEncrypted).
// The 5-minute timestamp window makes a signed request un-replayable for
// anything meaningful, and the app is idempotent by revision/seq beyond that.
//
// Mounted BEFORE the cookie auth wall (app.ts) — a machine, not a session. The
// production hardening beyond this is mTLS pinning of the agent's host cert on
// this path (nginx ssl_verify_client); the HMAC is the baseline that works on
// any transport.

const router = Router();

// In-memory consecutive-failure counter → auto-disable on abuse.
// ponytail: per-process memory; add a PG counter if the fleet ever needs the
// auto-disable decision to survive a restart mid-attack.
const badAuthCount = new Map<string, number>();
const MAX_BAD_AUTH = 5;

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

interface AuthedProxy {
  id: string;
  customerId: string;
  name: string;
  status: string;
  customer: { name: string | null } | null;
}

async function autoDisable(proxyId: string): Promise<void> {
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId }, select: { customerId: true, name: true } });
  if (!proxy) return;
  await prisma.squidProxy.update({ where: { id: proxyId }, data: { status: 'DISABLED', locked: true } });
  const admins = await prisma.user.findMany({ where: { customerId: proxy.customerId, role: 'ORG_ADMIN' }, select: { id: true } });
  for (const a of admins) {
    await notify({ userId: a.id, customerId: proxy.customerId, kind: 'squid_proxy', title: `Proxy “${proxy.name}” auto-disabled after repeated bad-auth attempts.`, url: '/squid' }).catch(() => {});
  }
}

/** Verify the request signature; attach the authenticated proxy to req. */
export async function agentAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const proxyId = req.get('X-Proxy-Id') ?? '';
  const ts = Number(req.get('X-Proxy-Timestamp'));
  const sig = (req.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const res401 = (code = 'PROXY_AUTH_FAILED') => { res.status(401).json({ error: 'Authentication failed', code }); };

  if (!proxyId || !sig || !Number.isFinite(ts) || Math.abs(Date.now() - ts) > 300_000) {
    res401('PROXY_AUTH_FAILED');
    return;
  }
  const proxy = await prisma.squidProxy.findUnique({
    where: { id: proxyId },
    include: { customer: { select: { name: true } } },
  });
  if (!proxy?.regKeyEncrypted) { res401(); return; }

  let raw: string;
  try { raw = decryptSecret(proxy.regKeyEncrypted); } catch { res401(); return; }

  const canonical = `${ts}\n${req.method}\n${req.originalUrl}\n${sha256((req as any).rawBody ?? Buffer.alloc(0))}`;
  const expected = crypto.createHmac('sha256', raw).update(canonical).digest('hex');
  const ok = expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  if (!ok) {
    const n = (badAuthCount.get(proxyId) ?? 0) + 1;
    badAuthCount.set(proxyId, n);
    await audit({ action: 'SQUID_AGENT_AUTH_FAILED', performedById: null, customerId: proxy.customerId, targetId: proxyId, metadata: { reason: 'signature mismatch', ip: req.ip, attempts: n } }).catch(() => {});
    if (n >= MAX_BAD_AUTH) { badAuthCount.delete(proxyId); await autoDisable(proxyId); }
    res401();
    return;
  }

  badAuthCount.delete(proxyId);
  (req as Request & { proxy: AuthedProxy }).proxy = {
    id: proxy.id, customerId: proxy.customerId, name: proxy.name, status: proxy.status, customer: proxy.customer,
  };
  next();
}

// The public key agents pin at bootstrap — public material, no authentication.
router.get('/public-key', (_req, res) => {
  res.json({ algorithm: 'Ed25519', publicKey: agentBundlePublicKey() });
});

// Agent polls for configuration; the poll doubles as its heartbeat.
router.get('/poll', agentAuth, async (req, res, next) => {
  try { res.json(await agentPoll((req as Request & { proxy: AuthedProxy }).proxy.id)); }
  catch (e) { next(e); }
});

// Agent reports the outcome of applying a revision (ok/error, monotonic ack).
router.post('/result', agentAuth, async (req, res, next) => {
  try {
    const parsed = AgentResultSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message, code: 'VALIDATION_ERROR' }); return; }
    const proxy = (req as Request & { proxy: AuthedProxy }).proxy;
    res.json(await agentResult(proxy.id, null, proxy.customerId, parsed.data));
  } catch (e) { next(e); }
});

// Agent pushes a telemetry snapshot + recent access-log lines. Same HMAC auth as
// poll/result; idempotent-ish (each report is one more row; the 48h/7d TTL prune
// keeps the tables bounded).
router.post('/telemetry', agentAuth, async (req, res, next) => {
  try {
    const parsed = TelemetryIngestSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message, code: 'VALIDATION_ERROR' }); return; }
    const proxy = (req as Request & { proxy: AuthedProxy }).proxy;
    res.json(await ingestTelemetry(proxy.id, proxy.customerId, parsed.data));
  } catch (e) { next(e); }
});

export default router;