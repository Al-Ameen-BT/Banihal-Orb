import { isIP } from 'net';
import { prisma } from '../../config/database';
import { audit } from '../../lib/audit';
import { runWithTicketDb } from '../../config/ticketDatabase';
import { getTicketById, getTicketCore, createComment } from '../ticketing/ticketing.client';
import {
  loadProxy, assertUnlocked, createChangeRequest, applyChangeRequest,
  broadcastChangeRequestUpdate, getOrCreateSquidBotUser, notifyAdminsOfProxy,
} from './squid.service';
import {
  resolveBotScope, findBotForProxy, claimCommandsForDelivery, findStaleCommands,
  markCommandTimedOut, finalizeCommand, upsertBotState, replaceBotRules, applyBotRuleDelta,
} from './squidBotStore';
import type { SquidBotScope } from './squidBotStore';
import type { BotChangeAction, BotChangeBodyInput } from './squid.schema';
import type { CommandResultInput, RequestInput, StateInput } from '../slack-bots/botWorker.schema';

// ─── Squid host bot — the platform half of the bot seam ──────────────────────
// Plan v2 (tasks/plan-squid-bot-integration.md), D1–D12. Three wire handlers
// (request / state / command-result), the shared submit core both doors run
// through (D2), and the ticket-status sync that turns an approval anywhere —
// web UI, platform Slack card, worker-forwarded card, external webhook — into a
// dispatched command. The host bot stays the executor; nothing here rewrites it.
//
// The sync exists because approval has no callback: approveTicket() is called
// from four doors and none of them knew about change requests. Polling on /state
// closes the loop at zero added latency — the command rides the same response.

/** Same cadence as ADR-002's heartbeat; the response tells the bot to keep it. */
export const STATE_INTERVAL_MS = 30_000;

const httpErr = (status: number, code: string, message: string): Error =>
  Object.assign(new Error(message), { status, code });

type Door = 'slack-host-worker' | 'web-app';

/** 'full-net' → 'FULL_NET' → action 'BOT_FULL_NET' (the CR action family). */
function botCrAction(action: BotChangeAction): string {
  return `BOT_${action.toUpperCase().replace(/-/g, '_')}`;
}

/** 'FULL_NET' → 'full-net' (wire type back out of the ledger enum). */
function wireType(enumValue: string): string {
  return enumValue.toLowerCase().replace(/_/g, '-');
}

function requesterLabel(r: Requester): string {
  return r.kind === 'slack'
    ? `@${r.slackUserName ?? r.slackUserId} (Slack)`
    : `${r.name ?? r.email ?? r.userId} (web)`;
}

/** Mirror of the bot's own ticket summaries (bot.py) so both channels read alike. */
function buildSummary(action: BotChangeAction, payload: Payload, label: string): string {
  const target = payload.domain ? ` → ${payload.domain}` : '';
  switch (action) {
    case 'allow':
      return `[ALLOW] ${payload.ip}${target} (${payload.hours ? `${payload.hours}h` : 'indefinite'}) — ${label}`;
    case 'deny':
      return `[DENY] ${payload.ip}${target} — ${label}`;
    case 'extend':
      return `[EXTEND] ${payload.ip}${target} (+${payload.hours}h) — ${label}`;
    case 'full-net':
      return `[FULL-NET] ${payload.ip} — unrestricted access — ${label}`;
    case 'lock-net':
      return `[LOCK-NET] ${payload.ip} — full-net revoked — ${label}`;
    default: {
      const _exhaustive: never = action;
      throw httpErr(400, 'UNKNOWN_ACTION', `Unknown bot action: ${String(_exhaustive)}`);
    }
  }
}

interface Payload {
  ip: string;
  domain?: string | undefined;
  hours?: number | undefined;
}

interface Requester {
  kind: 'slack' | 'web';
  userId?: string | null;
  name?: string | null;
  email?: string | null;
  slackUserId?: string | null;
  slackUserName?: string | null;
  channelId?: string | null;
}

/**
 * THE core (D2): validate-latch → approval ticket + change request + card +
 * audit. Both doors (Slack /request and the web form) are thin wrappers — they
 * differ only in how the requester and scope are resolved.
 */
async function submitChange(args: {
  proxyId: string;
  customerId: string;
  actorId: string | null;
  source: 'WEB' | 'SLACK';
  via: Door;
  action: BotChangeAction;
  payload: Payload;
  reason?: string | undefined;
  requester: Requester;
}): Promise<{ id: string; ticketId: string | null; ticketUrl: string | null; status: string }> {
  const proxy = await loadProxy(args.proxyId); // 404 + tenant-scoped
  assertUnlocked(proxy);                       // 423 read-only while locked

  // A `domain` that parses as an IP is the bot's destination-IP form — the bot
  // derives this itself (is_destination_ip), we just mirror it back on the wire.
  const isDestIp = Boolean(args.payload.domain && isIP(args.payload.domain) !== 0);
  const action = botCrAction(args.action);
  const summary = buildSummary(args.action, args.payload, requesterLabel(args.requester));

  const cr = await createChangeRequest({
    proxyId: args.proxyId,
    customerId: args.customerId,
    actorId: args.actorId,
    source: args.source,
    action,
    summary,
    details: {
      ...args.payload,
      isDestIp,
      ...(args.reason ? { reason: args.reason } : {}),
      requester: args.requester,
      via: args.via,
    },
  });

  await audit({
    action: 'SQUID_CHANGE_REQUESTED',
    performedById: args.actorId,
    customerId: args.customerId,
    targetId: cr.id,
    metadata: { via: args.via, action, proxyId: args.proxyId, ticketId: cr.ticketId, summary },
  }).catch(() => undefined);

  return { id: cr.id, ticketId: cr.ticketId, ticketUrl: cr.ticketUrl, status: cr.status };
}

export interface ChangeReceipt {
  changeRequestId: string;
  ticketId: string | null;
  ticketNumber: string | null;
  status: 'pending_approval';
  webUrl: string | null;
}

async function receipt(cr: { id: string; ticketId: string | null; ticketUrl: string | null }): Promise<ChangeReceipt> {
  const ticket = cr.ticketId
    ? await runWithTicketDb('default', () => getTicketById(cr.ticketId!))
    : null;
  return {
    changeRequestId: cr.id,
    ticketId: cr.ticketId,
    ticketNumber: ticket?.ticketNumber ?? null,
    status: 'pending_approval',
    webUrl: cr.ticketUrl,
  };
}

// ─── Door 1: POST /api/bot-worker/:botId/request (Slack-originated) ───────────

export async function squidBotRequest(botId: string, input: RequestInput): Promise<ChangeReceipt> {
  const bot = await prisma.slackBot.findUnique({
    where: { id: botId },
    select: { id: true, enabled: true, executionOwner: true },
  });
  if (!bot) throw httpErr(404, 'NOT_FOUND', 'Bot not found');
  if (!bot.enabled) throw httpErr(409, 'BOT_DISABLED', 'This bot is disabled.');
  if (bot.executionOwner !== 'HOST_WORKER') {
    throw httpErr(409, 'BOT_NOT_HOST_OWNED', 'This bot is platform-owned; the host worker must not serve its traffic.');
  }

  // D10: one bot serves exactly one organization — 0 or >1 links is a config
  // error (409), never a guess.
  const scope = await resolveBotScope(botId);

  const cr = await submitChange({
    proxyId: scope.proxyId,
    customerId: scope.customerId,
    actorId: null, // a Slack user is not a platform account — attribution lives in details
    source: 'SLACK',
    via: 'slack-host-worker',
    action: input.type,
    payload: input.payload,
    requester: {
      kind: 'slack',
      slackUserId: input.requester.slackUserId,
      slackUserName: input.requester.slackUserName,
      channelId: input.requester.channelId,
    },
  });
  return receipt(cr);
}

// ─── Door 2: POST /api/squid/:proxyId/change-requests (web main window) ───────

export async function requestProxyChange(
  proxyId: string,
  actor: { id: string; customerId: string },
  input: BotChangeBodyInput,
): Promise<ChangeReceipt> {
  // Ownership check like streamChangeRequests — an ORG_ADMIN must not be able
  // to aim a request at another org's proxy even with a valid session.
  const proxy = await prisma.squidProxy.findUnique({ where: { id: proxyId }, select: { customerId: true } });
  if (!proxy || proxy.customerId !== actor.customerId) {
    throw httpErr(404, 'NOT_FOUND', 'Proxy not found');
  }
  const user = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { name: true, email: true },
  });
  const cr = await submitChange({
    proxyId,
    customerId: actor.customerId,
    actorId: actor.id,
    source: 'WEB',
    via: 'web-app',
    action: input.action,
    payload: { ip: input.ip, domain: input.domain, hours: input.hours },
    reason: input.reason,
    requester: { kind: 'web', userId: actor.id, name: user?.name, email: user?.email },
  });
  return receipt(cr);
}

// ─── Approval sync (the missing approval→apply link) ──────────────────────────

/** Push one change request's current row to SSE watchers. */
async function broadcastCr(id: string): Promise<void> {
  const cr = await prisma.squidChangeRequest.findUnique({ where: { id } });
  if (!cr) return;
  broadcastChangeRequestUpdate(cr.proxyId, {
    id: cr.id,
    status: cr.status,
    action: cr.action,
    summary: cr.summary,
    ticketId: cr.ticketId,
    ticketUrl: cr.ticketUrl,
    appliedSeq: cr.appliedSeq,
    error: cr.error,
    updatedAt: cr.updatedAt,
  });
}

/** Best-effort comment as the squid persona — receipts live on the ticket. */
async function commentOnTicket(ticketId: string | null | undefined, text: string): Promise<void> {
  if (!ticketId) return;
  try {
    const personaId = await runWithTicketDb('default', () => getOrCreateSquidBotUser());
    await runWithTicketDb('default', () => createComment(ticketId, personaId, text));
  } catch (e) {
    console.error('⚠️  Squid ticket comment failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * Detect ticket decisions for host-bot change requests and dispatch them.
 * Runs on every /state poll and before the web list — covering ALL approval
 * doors (web UI, platform Slack card, worker-forwarded card, external webhook)
 * because every one of them ends in the same ticket status. Idempotent:
 * transitions are atomic updateMany guards, command creation is unique-per-CR.
 *
 * Scope is deliberately `BOT_*` actions: branch/port actions keep their existing
 * external-webhook flow untouched.
 */
export async function syncBotChangeRequests(filter: { customerId?: string; proxyId?: string }): Promise<void> {
  const crs = await prisma.squidChangeRequest.findMany({
    where: {
      status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
      action: { startsWith: 'BOT_' },
      ...(filter.proxyId ? { proxyId: filter.proxyId } : {}),
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
    },
  });

  for (const cr of crs) {
    try {
      if (cr.status === 'PENDING_APPROVAL') {
        if (!cr.ticketId) continue;
        const core = await runWithTicketDb('default', () => getTicketCore(cr.ticketId!));
        if (!core) continue;

        if (core.status === 'declined' || core.status === 'rejected') {
          const rejected = await prisma.squidChangeRequest.updateMany({
            where: { id: cr.id, status: 'PENDING_APPROVAL' },
            data: { status: 'REJECTED', error: 'Declined by an approver' },
          });
          if (rejected.count > 0) {
            await broadcastCr(cr.id);
            await audit({
              action: 'SQUID_CHANGE_REJECTED',
              performedById: null,
              customerId: cr.customerId,
              targetId: cr.id,
              metadata: { via: 'host-bot-sync', ticketId: cr.ticketId, proxyId: cr.proxyId },
            }).catch(() => undefined);
            await notifyAdminsOfProxy(
              cr.customerId,
              `Squid change request declined: ${cr.summary}`.slice(0, 160)
            ).catch(() => undefined);
          }
          continue;
        }
        if (core.status !== 'in_progress' && core.status !== 'completed') continue; // still awaiting a decision

        const approved = await prisma.squidChangeRequest.updateMany({
          where: { id: cr.id, status: 'PENDING_APPROVAL' },
          data: { status: 'APPROVED', error: null },
        });
        if (approved.count > 0) {
          await broadcastCr(cr.id);
          await audit({
            action: 'SQUID_CHANGE_APPROVED',
            performedById: null,
            customerId: cr.customerId,
            targetId: cr.id,
            metadata: { via: 'host-bot-sync', ticketId: cr.ticketId, proxyId: cr.proxyId },
          }).catch(() => undefined);
          await notifyAdminsOfProxy(
            cr.customerId,
            `Squid change request approved: ${cr.summary}`.slice(0, 160)
          ).catch(() => undefined);
        }
      }

      // APPROVED (us or another door) → enter the exactly-once ledger.
      // 423 while the proxy is locked suspends dispatch until it unlocks.
      await applyChangeRequest(cr.id, 'host-bot-sync');
    } catch (e) {
      // Expected non-errors: 423 locked (retry next poll), 409 a concurrent door
      // already finalized it, 400 unknown action on foreign rows. A sync pass
      // must never fail the /state poll — log only genuine faults.
      const status = (e as { status?: number })?.status;
      if (!status || ![400, 409, 423].includes(status)) {
        console.error('⚠️  Squid bot change sync:', e instanceof Error ? e.message : e);
      }
    }
  }
}

/** Time out commands the host never acked (30 missed polls), fail + surface them. */
async function timeoutStaleCommands(botId: string, scope: SquidBotScope): Promise<void> {
  const stale = await findStaleCommands(botId);
  for (const cmd of stale) {
    const failed = await markCommandTimedOut(cmd);
    if (!failed) continue;
    await broadcastCr(cmd.changeRequestId);
    const wire = wireType(cmd.type);
    await commentOnTicket(
      failed.ticketId,
      `⚠️ The ${wire} command (ledger ${cmd.id}) was dispatched but the host bot never acknowledged it within 15 minutes — the change may not have executed. Retried from the requests list or investigate the host.`,
    );
    await notifyAdminsOfProxy(scope.customerId, `⚠️ Squid host bot did not acknowledge a ${wire} command — change request failed.`);
  }
}

// ─── POST /api/bot-worker/:botId/state ────────────────────────────────────────

export interface StateResult {
  ok: true;
  /** Same lease semantics as the heartbeat: a duplicate/disabled instance dies. */
  command: 'disable' | null;
  commands: Array<{ id: string; type: string; payload: Record<string, unknown>; context?: Record<string, unknown> }>;
  heartbeatIntervalMs: number;
}

/** Project stored CR details onto the wire payload the bot's engine expects. */
function wirePayload(details: unknown): Record<string, unknown> {
  const d = (details ?? {}) as Record<string, unknown>;
  return {
    ...(typeof d.ip === 'string' ? { ip: d.ip } : {}),
    ...(typeof d.domain === 'string' ? { domain: d.domain } : {}),
    is_dest_ip: Boolean(d.isDestIp),
    ...(typeof d.hours === 'number' ? { hours: d.hours } : {}),
  };
}

/**
 * Requester routing for progress posts (B5). Present only for Slack-originated
 * requests (details.requester.channelId); web-originated commands deliver no
 * context and the host skips its progress messages.
 */
function wireContext(details: unknown): Record<string, unknown> | undefined {
  const r = ((details ?? {}) as Record<string, unknown>).requester;
  if (!r || typeof r !== 'object') return undefined;
  const req = r as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof req.channelId === 'string' && req.channelId) out['requesterChannelId'] = req.channelId;
  if (typeof req.slackUserId === 'string' && req.slackUserId) out['requesterSlackUserId'] = req.slackUserId;
  if (typeof req.slackUserName === 'string' && req.slackUserName) out['requesterSlackUserName'] = req.slackUserName;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Every ~30 s: lease check, latest-state upsert (D12), rules mirror, approval
 * sync → command enqueue, dispatch timeouts, and the command inbox back.
 * Order matters: sync first so an approval milliseconds ago still rides this
 * very response; claim last so acks above have already removed rows.
 */
export async function squidBotState(botId: string, input: StateInput): Promise<StateResult> {
  const bot = await prisma.slackBot.findUnique({
    where: { id: botId },
    select: { id: true, status: true, enabled: true, executionOwner: true, activeInstance: true },
  });
  if (!bot) throw httpErr(404, 'NOT_FOUND', 'Bot not found');

  // Lease (mirrors workerHeartbeat): disabled, platform-owned, or a second
  // instance → `disable`, and no writes at all (no stale status from a corpse).
  if (!bot.enabled || bot.executionOwner !== 'HOST_WORKER' ||
      (bot.activeInstance && bot.activeInstance !== input.instanceId)) {
    return { ok: true, command: 'disable', commands: [], heartbeatIntervalMs: STATE_INTERVAL_MS };
  }

  const links = await prisma.slackBotOrg.findMany({
    where: { botId },
    select: { customerId: true },
  });
  // Misconfigured scope (D10) must not brick telemetry: health columns + state
  // still update off the first link; sync/deliver-dependent work is skipped.
  let scope: SquidBotScope | null = null;
  try { scope = await resolveBotScope(botId); } catch { scope = null; }
  const customerId = scope?.customerId ?? links[0]?.customerId ?? null;

  const offline = input.socketConnected === false || input.status === 'DISCONNECTED';
  const status = offline ? 'DISCONNECTED' as const : input.status === 'ERROR' ? 'ERROR' as const : 'CONNECTED' as const;

  await prisma.slackBot.update({
    where: { id: botId },
    data: {
      status,
      activeInstance: input.instanceId,
      lastCheckedAt: new Date(),
      lastError: status === 'ERROR' ? (input.lastError ?? 'Host bot reported an error') : null,
    },
  });
  // Audit the transition, never the poll (30s × bots would flood the log).
  if (bot.status !== status && customerId) {
    await audit({
      action: 'SQUID_BOT_STATE',
      performedById: null,
      customerId,
      targetId: botId,
      metadata: { from: bot.status, to: status, instanceId: input.instanceId, socketConnected: input.socketConnected ?? false },
    }).catch(() => undefined);
  }

  if (customerId) {
    await upsertBotState(botId, customerId, {
      proxyId: scope?.proxyId ?? null,
      instanceId: input.instanceId,
      version: input.version,
      status,
      socketConnected: input.socketConnected ?? false,
      lastEventAt: input.lastEventAt,
      msgCount: input.msgCount,
      squidActive: input.squid?.active ?? false,
      squidParseOk: input.squid?.parseOk,
      squidLastReloadAt: input.squid?.lastReloadAt,
      domainCount: input.counts?.domains ?? 0,
      discovery: input.discovery ?? undefined,
      lastError: input.lastError ?? undefined,
      raw: input as unknown as object,
    });

    const proxyId = scope?.proxyId ?? null;
    if (input.rules) {
      await replaceBotRules(botId, customerId, proxyId, input.rules.map((r) => ({
        ip: r.ip, domain: r.domain,
        isDestIp: r.isDestIp ?? (isIP(r.domain) !== 0),
        app: r.app, expires: r.expires,
      })));
    } else if (input.rulesDelta?.length) {
      await applyBotRuleDelta(botId, customerId, proxyId, input.rulesDelta.map((d) => ({
        op: d.op, ip: d.ip, domain: d.domain,
        isDestIp: d.isDestIp ?? (isIP(d.domain) !== 0),
        app: d.app, expires: d.expires,
      })));
    }
  }

  // Piggybacked ack FIRST: the command must leave the inbox before we claim it.
  if (input.requestContext?.commandIdAcked) {
    await squidBotCommandResult(botId, {
      commandId: input.requestContext.commandIdAcked,
      instanceId: input.instanceId,
      ok: true,
      detail: 'Acknowledged via /state',
    }).catch(() => undefined);
  }

  if (scope) {
    await syncBotChangeRequests({ customerId: scope.customerId })
      .catch((e) => console.error('⚠️  Squid bot sync pass failed:', e instanceof Error ? e.message : e));
    await timeoutStaleCommands(botId, scope)
      .catch((e) => console.error('⚠️  Squid bot timeout pass failed:', e instanceof Error ? e.message : e));
  }

  const deliverable = await claimCommandsForDelivery(botId);
  return {
    ok: true,
    command: null,
    commands: deliverable.map((c) => {
      const context = wireContext(c.payload);
      return {
        id: c.id,
        type: wireType(c.type),
        payload: wirePayload(c.payload),
        ...(context ? { context } : {}),
      };
    }),
    heartbeatIntervalMs: STATE_INTERVAL_MS,
  };
}

// ─── POST /api/bot-worker/:botId/command-result ───────────────────────────────

export interface CommandResultOutcomeResult {
  ok: true;
  late: boolean;
  commandStatus: string;
}

export async function squidBotCommandResult(botId: string, input: CommandResultInput): Promise<CommandResultOutcomeResult> {
  const outcome = await finalizeCommand(botId, {
    commandId: input.commandId,
    ok: input.ok,
    detail: input.detail,
  });

  if (outcome.applied && outcome.changeRequest) {
    await broadcastCr(outcome.changeRequest.id);
    const wire = wireType(outcome.command.type);
    if (outcome.changeRequest.ticketId) {
      await commentOnTicket(
        outcome.changeRequest.ticketId,
        outcome.command.status === 'ACKED'
          ? `✅ The host bot applied the ${wire} command (ledger ${outcome.command.id})${outcome.late ? ' — late acknowledgement, after a dispatch timeout' : ''}. ${outcome.command.result ?? ''}`.trim()
          : `❌ The host bot reported the ${wire} command (ledger ${outcome.command.id}) failed: ${outcome.command.result || 'no detail'}`,
      );
    }
    if (!input.ok) {
      await notifyAdminsOfProxy(
        outcome.command.customerId,
        `❌ Squid host bot failed a ${wire} command — operator attention needed.`,
      ).catch(() => undefined);
    } else if (outcome.command.status === 'ACKED') {
      await notifyAdminsOfProxy(
        outcome.command.customerId,
        `✅ Squid host bot applied ${wire}: ${outcome.changeRequest.summary}`.slice(0, 160)
      ).catch(() => undefined);
    }
  }

  return { ok: true, late: outcome.late, commandStatus: outcome.command.status };
}

// ─── GET /api/squid/:proxyId/status (dashboard W3/W4 API) ─────────────────────

export interface ProxyBotStatus {
  linked: boolean;
  bot: { id: string; name: string; slug: string; enabled: boolean; status: string; lastCheckedAt: Date | null; lastError: string | null } | null;
  state: unknown;
  rules: { active: number; expiringIn24h: number } | null;
  commands: { pending: number; dispatched: number; acked: number; failed: number; timedOut: number } | null;
}

export async function getProxyBotStatus(proxyId: string): Promise<ProxyBotStatus> {
  await loadProxy(proxyId); // 404 + tenant scoping before anything else
  const owner = await findBotForProxy(proxyId);
  if (!owner) return { linked: false, bot: null, state: null, rules: null, commands: null };

  const dayAgo = new Date(Date.now() - 86_400_000);
  const [bot, state, active, expiringIn24h, recent] = await Promise.all([
    prisma.slackBot.findUnique({
      where: { id: owner.botId },
      select: { id: true, name: true, slug: true, enabled: true, status: true, lastCheckedAt: true, lastError: true },
    }),
    prisma.squidBotState.findUnique({ where: { botId: owner.botId } }),
    prisma.squidBotRule.count({ where: { botId: owner.botId } }),
    prisma.squidBotRule.count({
      where: { botId: owner.botId, expiresAt: { gte: new Date(), lte: new Date(Date.now() + 86_400_000) } },
    }),
    prisma.squidBotCommand.findMany({
      where: { botId: owner.botId, createdAt: { gte: dayAgo } },
      select: { status: true },
    }),
  ]);

  const count = (s: string) => recent.filter((c) => c.status === s).length;
  return {
    linked: true,
    bot,
    state,
    rules: { active, expiringIn24h },
    commands: {
      pending: count('PENDING'),
      dispatched: count('DISPATCHED'),
      acked: count('ACKED'),
      failed: count('FAILED'),
      timedOut: count('TIMED_OUT'),
    },
  };
}
