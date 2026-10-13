import { prisma } from '../../config/database';
import { audit } from '../../lib/audit';
import { Prisma } from '@prisma/client';
import type { SquidBotCommand, SquidBotCommandType } from '@prisma/client';

// ─── Squid host bot store (workerMode = SQUID_BOT) ───────────────────────────
// Persistence + exactly-once bookkeeping for the bot that executes per-IP rule
// changes on the client host (plan v2, tasks/plan-squid-bot-integration.md).
//
// Deliberately a LEAF module: prisma + audit only, no import of squid.service —
// squid.service.applyChangeRequest dispatches through enqueueBotCommand here,
// and importing back would be a cycle. Orchestration (ticket-status sync,
// notifications, SSE broadcast) lives in squidBot.service.ts.

const DAY = 86_400_000;
/** D12: commands/rules history window. State is latest-only by construction. */
export const HISTORY_RETENTION_DAYS = 90;
/** Dispatched-but-unacked commands time out after this (30 missed 30s polls). */
export const COMMAND_ACK_TIMEOUT_MS = 15 * 60_000;

const err = (status: number, code: string, message: string): Error =>
  Object.assign(new Error(message), { status, code });

const isP2002 = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** CR action ('BOT_ALLOW') → ledger type ('ALLOW'). */
const COMMAND_TYPE_BY_ACTION: Record<string, SquidBotCommandType> = {
  BOT_ALLOW: 'ALLOW',
  BOT_DENY: 'DENY',
  BOT_EXTEND: 'EXTEND',
  BOT_FULL_NET: 'FULL_NET',
  BOT_LOCK_NET: 'LOCK_NET',
};

export const BOT_ACTION_PREFIX = 'BOT_';
export function botActionOf(action: string): SquidBotCommandType | null {
  return COMMAND_TYPE_BY_ACTION[action] ?? null;
}
export function botActionName(commandType: SquidBotCommandType): string {
  return `${BOT_ACTION_PREFIX}${commandType}`;
}

// ─── Scope resolution (D10: one bot per organization) ────────────────────────

export interface SquidBotScope {
  customerId: string;
  proxyId: string;
  approvalChannelId: string | null;
}

/**
 * The org + proxy a bot governs. D10: each organization has its own bot, so a
 * bot linked to zero or several orgs is a configuration error, not something to
 * guess around — 409 with a pointer at the ops doc. A null squidProxyId link
 * resolves to the org's single proxy; multi-proxy orgs must set it explicitly.
 */
export async function resolveBotScope(botId: string): Promise<SquidBotScope> {
  const links = await prisma.slackBotOrg.findMany({
    where: { botId },
    select: { customerId: true, squidProxyId: true, approvalChannelId: true },
  });
  if (links.length === 0) {
    throw err(409, 'bot_org_not_linked', 'This bot is not linked to an organization. See the vendored INTEGRATION.md.');
  }
  if (links.length > 1) {
    throw err(409, 'bot_org_misconfigured', 'One bot serves exactly one organization (D10) — unlink the extras.');
  }
  const link = links[0]!;
  let proxyId = link.squidProxyId;
  if (proxyId) {
    const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId }, select: { customerId: true } });
    if (!proxy || proxy.customerId !== link.customerId) {
      throw err(409, 'bot_proxy_not_found', 'The proxy linked to this bot does not exist for its organization.');
    }
  } else {
    const proxies = await prisma.squidProxy.findMany({ where: { customerId: link.customerId }, select: { id: true } });
    if (proxies.length === 1) proxyId = proxies[0]!.id;
    else if (proxies.length === 0) {
      throw err(409, 'bot_proxy_unresolved', 'No squid proxy is provisioned for this organization.');
    } else {
      throw err(409, 'bot_proxy_ambiguous', 'This organization owns several proxies — set squidProxyId on the bot↔org link.');
    }
  }
  return { customerId: link.customerId, proxyId, approvalChannelId: link.approvalChannelId };
}

export interface ProxyBotOwner {
  botId: string;
  customerId: string;
  approvalChannelId: string | null;
}

/** The bot governing a proxy — inverse of resolveBotScope (card posting, status). */
export async function findBotForProxy(proxyId: string): Promise<ProxyBotOwner | null> {
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId }, select: { customerId: true } });
  if (!proxy) return null;
  const links = await prisma.slackBotOrg.findMany({
    where: { customerId: proxy.customerId },
    select: { botId: true, squidProxyId: true, approvalChannelId: true },
  });
  if (links.length === 0) return null;
  const explicit = links.find((l) => l.squidProxyId === proxyId);
  if (explicit) return { botId: explicit.botId, customerId: proxy.customerId, approvalChannelId: explicit.approvalChannelId };
  // Null-link resolution mirrors resolveBotScope: only unambiguous when the org
  // owns exactly this one proxy.
  if (links.length === 1) {
    const count = await prisma.squidProxy.count({ where: { customerId: proxy.customerId } });
    if (count === 1) {
      return { botId: links[0]!.botId, customerId: proxy.customerId, approvalChannelId: links[0]!.approvalChannelId };
    }
  }
  return null;
}

// ─── Command ledger (exactly-once) ───────────────────────────────────────────

/**
 * Create the ledger row for an APPROVED change request and claim it
 * (→ DISPATCHED). Idempotent: `changeRequestId` is UNIQUE, so a racing second
 * approval door gets the existing row back instead of a duplicate command.
 * Called from squid.service.applyChangeRequest (every approval door funnels
 * there: state sync, external webhook, external status feedback loop).
 */
export async function enqueueBotCommand(cr: {
  id: string;
  customerId: string;
  proxyId: string;
  action: string;
  details: unknown;
}): Promise<SquidBotCommand> {
  const type = COMMAND_TYPE_BY_ACTION[cr.action];
  if (!type) throw err(400, 'UNKNOWN_ACTION', `Not a host-bot action: ${cr.action}`);

  const owner = await findBotForProxy(cr.proxyId);
  if (!owner) {
    throw err(409, 'BOT_NOT_LINKED', 'No squid host bot is linked for this proxy — the approved change cannot be dispatched.');
  }

  let cmd: SquidBotCommand;
  try {
    cmd = await prisma.squidBotCommand.create({
      data: {
        botId: owner.botId,
        customerId: cr.customerId,
        proxyId: cr.proxyId,
        changeRequestId: cr.id,
        type,
        payload: (cr.details ?? {}) as object,
      },
    });
  } catch (e) {
    if (!isP2002(e)) throw e;
    const existing = await prisma.squidBotCommand.findUnique({ where: { changeRequestId: cr.id } });
    if (existing) return existing;
    throw e;
  }

  await prisma.squidChangeRequest.updateMany({
    where: { id: cr.id, status: { in: ['APPROVED', 'PENDING_APPROVAL'] } },
    data: { status: 'DISPATCHED' },
  });
  await audit({
    action: 'SQUID_BOT_COMMAND_SENT',
    performedById: null,
    customerId: cr.customerId,
    targetId: cr.id,
    metadata: { commandId: cmd.id, commandType: type, proxyId: cr.proxyId, botId: owner.botId },
  }).catch(() => undefined);
  return cmd;
}

/**
 * Commands ready to hand back on a /state response: PENDING (never delivered)
 * plus DISPATCHED (redelivery until acked — at-least-once with a host-side
 * dedupe on commandId). Marks delivery time on first hand-out and bumps the
 * attempts counter.
 */
export async function claimCommandsForDelivery(botId: string, limit = 25): Promise<SquidBotCommand[]> {
  const cmds = await prisma.squidBotCommand.findMany({
    where: { botId, status: { in: ['PENDING', 'DISPATCHED'] } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  if (cmds.length === 0) return [];
  const ids = cmds.map((c) => c.id);
  await prisma.squidBotCommand.updateMany({ where: { id: { in: ids }, dispatchedAt: null }, data: { dispatchedAt: new Date() } });
  await prisma.squidBotCommand.updateMany({
    where: { id: { in: ids } },
    data: { status: 'DISPATCHED', attempts: { increment: 1 } },
  });
  return prisma.squidBotCommand.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: 'asc' } });
}

/** Dispatched longer than the ack window with no /command-result. */
export async function findStaleCommands(botId: string): Promise<SquidBotCommand[]> {
  const cutoff = new Date(Date.now() - COMMAND_ACK_TIMEOUT_MS);
  return prisma.squidBotCommand.findMany({
    where: { botId, status: 'DISPATCHED', dispatchedAt: { lt: cutoff } },
  });
}

/**
 * Time a command out and fail its change request. Returns the failed CR row for
 * the caller to broadcast/comment on, or null if another door already finalized
 * either side of the pair.
 */
export async function markCommandTimedOut(cmd: SquidBotCommand): Promise<{ id: string; proxyId: string; ticketId: string | null; error: string | null } | null> {
  const claimed = await prisma.squidBotCommand.updateMany({
    where: { id: cmd.id, status: 'DISPATCHED' },
    data: { status: 'TIMED_OUT', result: 'Host did not acknowledge in time' },
  });
  if (claimed.count === 0) return null;

  const error = 'The host bot did not acknowledge this command within 15 minutes.';
  const flipped = await prisma.squidChangeRequest.updateMany({
    where: { id: cmd.changeRequestId, status: 'DISPATCHED' },
    data: { status: 'FAILED', error },
  });
  await audit({
    action: 'SQUID_CHANGE_FAILED',
    performedById: null,
    customerId: cmd.customerId,
    targetId: cmd.changeRequestId,
    metadata: { commandId: cmd.id, commandType: cmd.type, proxyId: cmd.proxyId, reason: 'dispatch-timeout' },
  }).catch(() => undefined);
  if (flipped.count === 0) return null;
  return prisma.squidChangeRequest.findUnique({
    where: { id: cmd.changeRequestId },
    select: { id: true, proxyId: true, ticketId: true, error: true },
  });
}

export interface CommandResultOutcome {
  command: SquidBotCommand;
  /** The change request the ack finalized (null when nothing flipped). */
  changeRequest: { id: string; proxyId: string; ticketId: string | null; status: string; error: string | null; summary: string } | null;
  /** The ack arrived after a timeout — the CR may already have been failed. */
  late: boolean;
  /** False when this commandId belongs to another bot or is already finalized. */
  applied: boolean;
}

/**
 * Fold a /command-result into the ledger: command ACKED/FAILED, change request
 * APPLIED/FAILED (audit included), idempotent on repeated acks.
 */
export async function finalizeCommand(
  botId: string,
  input: { commandId: string; ok: boolean; detail?: string | undefined },
): Promise<CommandResultOutcome> {
  const cmd = await prisma.squidBotCommand.findUnique({ where: { id: input.commandId } });
  if (!cmd || cmd.botId !== botId) throw err(404, 'command_not_found', 'Unknown command id.');
  if (cmd.status === 'ACKED' || cmd.status === 'FAILED') {
    const cr = await prisma.squidChangeRequest.findUnique({
      where: { id: cmd.changeRequestId },
      select: { id: true, proxyId: true, ticketId: true, status: true, error: true, summary: true },
    });
    return { command: cmd, changeRequest: cr, late: false, applied: false };
  }

  const late = cmd.status === 'TIMED_OUT';
  const detail = input.detail ?? (input.ok ? 'applied' : 'failed');
  const command = await prisma.squidBotCommand.update({
    where: { id: cmd.id },
    data: { status: input.ok ? 'ACKED' : 'FAILED', result: detail, ackedAt: new Date() },
  });

  // A late ok means the host DID apply it — the CR's timeout failure is stale,
  // so FAILED → APPLIED is allowed. A late failure leaves the failed CR alone.
  let changeRequest: CommandResultOutcome['changeRequest'] = null;
  if (input.ok) {
    const flipped = await prisma.squidChangeRequest.updateMany({
      where: { id: cmd.changeRequestId, status: { in: late ? ['DISPATCHED', 'FAILED'] : ['DISPATCHED'] } },
      data: { status: 'APPLIED', error: null },
    });
    if (flipped.count > 0) {
      await audit({
        action: 'SQUID_CHANGE_APPLIED',
        performedById: null,
        customerId: cmd.customerId,
        targetId: cmd.changeRequestId,
        metadata: { commandId: cmd.id, commandType: cmd.type, proxyId: cmd.proxyId, via: 'slack-host-worker', late, detail },
      }).catch(() => undefined);
    }
  } else {
    const flipped = await prisma.squidChangeRequest.updateMany({
      where: { id: cmd.changeRequestId, status: 'DISPATCHED' },
      data: { status: 'FAILED', error: detail },
    });
    if (flipped.count > 0) {
      await audit({
        action: 'SQUID_CHANGE_FAILED',
        performedById: null,
        customerId: cmd.customerId,
        targetId: cmd.changeRequestId,
        metadata: { commandId: cmd.id, commandType: cmd.type, proxyId: cmd.proxyId, via: 'slack-host-worker', detail },
      }).catch(() => undefined);
    }
  }
  changeRequest = await prisma.squidChangeRequest.findUnique({
    where: { id: cmd.changeRequestId },
    select: { id: true, proxyId: true, ticketId: true, status: true, error: true, summary: true },
  });
  return { command, changeRequest, late, applied: true };
}

// ─── State + rules mirror ────────────────────────────────────────────────────

export interface BotStatePatch {
  proxyId: string | null;
  instanceId: string;
  version?: string | undefined;
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  socketConnected: boolean;
  lastEventAt?: number | undefined;
  msgCount?: number | undefined;
  squidActive: boolean;
  squidParseOk?: boolean | undefined;
  squidLastReloadAt?: number | undefined;
  domainCount: number;
  discovery?: object | null | undefined;
  lastError?: string | undefined;
  raw: object;
}

/** Upsert-latest (D12: one row per bot — history lives in audit + commands). */
export async function upsertBotState(botId: string, customerId: string, patch: BotStatePatch): Promise<void> {
  const { proxyId, instanceId, version, status, socketConnected, lastEventAt, msgCount,
    squidActive, squidParseOk, squidLastReloadAt, domainCount, discovery, lastError, raw } = patch;
  const data = {
    customerId, proxyId, instanceId, version, status, socketConnected,
    ...(lastEventAt !== undefined ? { lastEventAt: new Date(lastEventAt * 1000) } : {}),
    ...(msgCount !== undefined ? { msgCount } : {}),
    squidActive,
    ...(squidParseOk !== undefined ? { squidParseOk } : {}),
    ...(squidLastReloadAt !== undefined ? { squidLastReloadAt: new Date(squidLastReloadAt * 1000) } : {}),
    domainCount,
    ...(discovery !== undefined ? { discovery: discovery as object } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
    raw,
    observedAt: new Date(),
  };
  await prisma.squidBotState.upsert({
    where: { botId },
    create: { botId, ...data },
    update: data,
  });
}

export interface RuleInput {
  ip: string;
  domain: string;
  isDestIp?: boolean | undefined;
  app?: string | null | undefined;
  /** Epoch seconds; null/undefined = indefinite (the bot's own semantics, D11). */
  expires?: number | null | undefined;
}

/**
 * Full snapshot: upsert every listed rule stamped at `passStart`, then delete
 * whatever this pass did not touch (expiry-worker removals arrive this way).
 */
export async function replaceBotRules(botId: string, customerId: string, proxyId: string | null, rules: RuleInput[]): Promise<void> {
  const passStart = new Date();
  for (const r of rules) {
    await prisma.squidBotRule.upsert({
      where: { botId_ip_domain: { botId, ip: r.ip, domain: r.domain } },
      create: {
        botId, customerId, proxyId, ip: r.ip, domain: r.domain,
        isDestIp: r.isDestIp ?? false, app: r.app ?? null,
        expiresAt: r.expires ? new Date(r.expires * 1000) : null,
        lastSeenAt: passStart,
      },
      update: {
        customerId, proxyId, isDestIp: r.isDestIp ?? false, app: r.app ?? null,
        expiresAt: r.expires ? new Date(r.expires * 1000) : null,
        lastSeenAt: passStart,
      },
    });
  }
  await prisma.squidBotRule.deleteMany({ where: { botId, lastSeenAt: { lt: passStart } } });
}

/** Incremental change: `up` upserts, `down` removes (bot-side expiry/deny cleanup). */
export async function applyBotRuleDelta(
  botId: string,
  customerId: string,
  proxyId: string | null,
  delta: Array<{ op: 'up' | 'down' } & RuleInput>,
): Promise<void> {
  for (const d of delta) {
    if (d.op === 'down') {
      await prisma.squidBotRule.deleteMany({ where: { botId, ip: d.ip, domain: d.domain } });
      continue;
    }
    const expiresAt = d.expires ? new Date(d.expires * 1000) : null;
    await prisma.squidBotRule.upsert({
      where: { botId_ip_domain: { botId, ip: d.ip, domain: d.domain } },
      create: {
        botId, customerId, proxyId, ip: d.ip, domain: d.domain,
        isDestIp: d.isDestIp ?? false, app: d.app ?? null, expiresAt, lastSeenAt: new Date(),
      },
      update: { customerId, proxyId, isDestIp: d.isDestIp ?? false, app: d.app ?? null, expiresAt, lastSeenAt: new Date() },
    });
  }
}

/**
 * D12 retention: terminal commands and unseen rules older than the window.
 * Non-terminal commands are live state and are kept regardless of age — a bot
 * that has been offline for a quarter still owns its queued approvals.
 */
export async function trimBotHistory(now = new Date()): Promise<{ commands: number; rules: number }> {
  const cutoff = new Date(now.getTime() - HISTORY_RETENTION_DAYS * DAY);
  const commands = await prisma.squidBotCommand.deleteMany({
    where: { createdAt: { lt: cutoff }, status: { in: ['ACKED', 'FAILED', 'TIMED_OUT'] } },
  });
  const rules = await prisma.squidBotRule.deleteMany({ where: { lastSeenAt: { lt: cutoff } } });
  return { commands: commands.count, rules: rules.count };
}
