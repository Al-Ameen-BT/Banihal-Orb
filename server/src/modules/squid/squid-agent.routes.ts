import { Router, Request } from 'express';
import { prisma } from '../../config/database';
import { decryptSecret } from '../../config/slackCrypto';
import { agentPoll, agentResult, agentBundlePublicKey, ingestTelemetry, getOrCreateSquidProject, getOrCreateSquidBotUser } from './squid.service';
import { AgentResultSchema, TelemetryIngestSchema } from './squid.schema';
import { createMachineKeyAuth } from '../../lib/machineAuth';
import { audit } from '../../lib/audit';

// ─── Agent control API ───────────────────────────────────────────────────────
// The per-host squid agent talks ONLY to these routes, and only with its own
// proxy id + request signature. Each request is HMAC-SHA256 over
// `${ts}\n${METHOD}\n${path}\n${sha256(rawBody)}` using the per-proxy raw
// registration key (the encrypted copy lives in squidProxies.regKeyEncrypted).
// V2 nonces reject replay; timestamps alone only bound signature age.
// The signature verification, bad-auth streak counter and bad-auth audit row
// live in the shared lib/machineAuth (ADR-003); only what is the router's own
// — WHICH actor is loaded and WHAT disable costs — is configured below.
//
// Mounted BEFORE the cookie auth wall (app.ts) — a machine, not a session. The
// production hardening beyond this is mTLS pinning of the agent's host cert on
// this path (nginx ssl_verify_client); the HMAC is the baseline that works on
// any transport.

const router = Router();

interface AuthedProxy {
  id: string;
  customerId: string;
  name: string;
  status: string;
  customer: { name: string | null } | null;
}

/** Verify the request signature; attach the authenticated proxy to req. */
export const agentAuth = createMachineKeyAuth<AuthedProxy>({
  actorKind: 'proxy',
  actorIdOf: (req) => req.get('X-Proxy-Id') ?? '',
  timestampHeader: 'X-Proxy-Timestamp',
  loadActor: async (proxyId) => {
    const proxy = await prisma.squidProxy.findUnique({
      where: { id: proxyId },
      include: { customer: { select: { name: true } } },
    });
    if (!proxy?.regKeyEncrypted || !proxy.regKeyHash || proxy.status === 'DISABLED') return null;
    let secret: string;
    try { secret = decryptSecret(proxy.regKeyEncrypted); } catch { return null; }
    return {
      actorId: proxyId,
      context: {
        id: proxy.id, customerId: proxy.customerId, name: proxy.name, status: proxy.status, customer: proxy.customer,
      },
      secret,
      customerId: proxy.customerId, // factory writes the single bad-auth audit row (R2)
      secretHash: proxy.regKeyHash,
    };
  },
  reqKey: 'proxy',
  authFailedCode: 'PROXY_AUTH_FAILED',
  auditAction: 'SQUID_AGENT_AUTH_FAILED',
});

// The public key agents pin at bootstrap — public material, no authentication.
router.get('/public-key', (_req, res) => {
  res.json({ algorithm: 'Ed25519', publicKey: agentBundlePublicKey() });
});

// Agent polls for configuration; the poll doubles as its heartbeat.
router.get('/poll', agentAuth, async (req, res, next) => {
  try { res.json(await agentPoll((req as Request & { proxy: AuthedProxy }).proxy.id, Number(req.get('X-Machine-Version') ?? '1'))); }
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

// Bot fetches its ticketing API credentials using the same HMAC auth.
// Returns the decrypted external API key secret for the bot to use.
router.get('/ticketing-config', agentAuth, async (req, res, next) => {
  try {
    const proxy = (req as Request & { proxy: AuthedProxy }).proxy;
    
    // Get the external API key linked to this proxy
    const proxyWithKey = await prisma.squidProxy.findUnique({
      where: { id: proxy.id },
      include: { externalApiKey: true },
    });
    
    if (!proxyWithKey?.externalApiKey) {
      res.status(404).json({ error: 'No ticketing API key configured for this proxy', code: 'NOT_CONFIGURED' });
      return;
    }
    
    const extKey = proxyWithKey.externalApiKey;
    if (!extKey.enabled) {
      res.status(403).json({ error: 'Ticketing API key is disabled', code: 'KEY_DISABLED' });
      return;
    }
    
    // Decrypt the secret from secretEnc (stored encrypted in the database)
    if (!extKey.secretEnc) {
      res.status(500).json({ error: 'Ticketing API key secret not available (key created before secret storage was added)', code: 'SECRET_UNAVAILABLE' });
      return;
    }
    
    let secret: string;
    try {
      secret = decryptSecret(extKey.secretEnc);
    } catch {
      res.status(500).json({ error: 'Unable to decrypt API key secret', code: 'SECRET_DECRYPT_FAILED' });
      return;
    }
    
    // customerIds is Json — cast to string array
    const customerIds = (extKey.customerIds as string[]) ?? [];
    if (customerIds.length !== 1 || customerIds[0] !== proxy.customerId) {
      res.status(403).json({ error: 'Ticketing key must be restricted to this organisation', code: 'KEY_CUSTOMER_MISMATCH' });
      return;
    }
    await audit({ action: 'SQUID_TOKEN_VERIFIED', performedById: null, customerId: proxy.customerId, targetId: proxy.id, metadata: { ticketingCredentialsFetched: true } });
    res.setHeader('Cache-Control', 'no-store');
    
    // Resolve project and assignee IDs so the bot can fetch its tickets
    const project = await getOrCreateSquidProject();
    const assigneeId = await getOrCreateSquidBotUser();

    res.json({
      baseUrl: process.env.TICKET_API_BASE_URL ?? '',
      clientId: extKey.clientId,
      clientSecret: secret,
      projectId: project.id,
      assigneeId: assigneeId,
      orgCustomerId: customerIds.length === 1 ? customerIds[0] : '',
      scopes: extKey.scopes,
      ticketStore: extKey.ticketStore,
    });
  } catch (e) { next(e); }
});

export default router;
