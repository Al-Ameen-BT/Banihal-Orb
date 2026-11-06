import { prisma } from '../../config/database';
import { decryptSecret } from '../../config/slackCrypto';
import { audit } from '../../lib/audit';
import { runWithTicketDb } from '../../config/ticketDatabase';
import { agentChat } from '../../services/agentApi';
import { approveTicket, declineTicket } from '../ticketing/ticketing.service';
import { resolveTicketActor } from '../ticketing/identity';
import { resolveTicketOrg } from '../external-api/external-scope';
import { emitOrgTicketEvent } from '../external-api/external-webhooks';
import { redeemLinkCode, unlinkSlackId } from './slackLink';
import type { HeartbeatInput, MessageInput, ProvisionInput } from './botWorker.schema';

// ─── Host worker endpoints ───────────────────────────────────────────────────
// Business logic behind POST /api/bot-worker/:botId/{provision,heartbeat,message}.
// The router authenticates every call with the bot's `wrk_` key (Bearer + HMAC),
// exactly like the squid agent protocol; these functions run the state machine.

// ADR-002 sets the command-carrying heartbeat cadence at 30s (the plan draft
// said 5s — reconciled by the ADR; the returned heartbeatIntervalMs lets the
// platform drive the actual cadence per bot).
export const HEARTBEAT_MS = 30_000;

const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { status: 404, code: 'NOT_FOUND' });
const conflict = (code: string, message: string) => Object.assign(new Error(message), { status: 409, code });

export interface ProvisionResult {
  botId: string;
  botToken: string;
  appToken: string | null;
  instanceId: string | null;
  provisionedAt: string;
}

/**
 * First call ever: decrypt and hand the bot's Slack tokens to the host worker
 * ONCE over TLS, then record the one-time gate so a second host cannot re-fetch.
 *
 * One deliberate recovery hole: the SAME instanceId may re-provision after a
 * lost response (worker stored nothing, platform already flipped the gate). A
 * different instanceId is refused 409 — that is the rotation flow, not a retry.
 */
export async function provisionWorker(botId: string, input: ProvisionInput): Promise<ProvisionResult> {
  const bot = await prisma.slackBot.findUnique({
    where: { id: botId },
    select: { id: true, name: true, botTokenEnc: true, appTokenEnc: true, workerProvisionedAt: true, activeInstance: true },
  });
  if (!bot) throw notFound('Bot');
  if (bot.workerProvisionedAt && bot.activeInstance && input.instanceId && bot.activeInstance !== input.instanceId) {
    throw conflict('ALREADY_PROVISIONED', 'This bot is already provisioned to another host worker instance.');
  }

  const botToken = decryptSecret(bot.botTokenEnc);
  const appToken = bot.appTokenEnc ? decryptSecret(bot.appTokenEnc) : null;

  await prisma.slackBot.update({
    where: { id: botId },
    data: {
      workerProvisionedAt: new Date(),
      workerRotationPending: false,
      ...(input.instanceId ? { activeInstance: input.instanceId } : {}),
    },
  });

  const customerId = await firstOrgCustomerId(botId);
  if (customerId) {
    await audit({
      action: 'BOT_WORKER_PROVISIONED',
      performedById: null,
      targetId: botId,
      customerId,
      metadata: { botName: bot.name, instanceId: input.instanceId ?? null },
    }).catch(() => undefined);
  }

  return {
    botId,
    botToken,
    appToken,
    instanceId: input.instanceId ?? null,
    provisionedAt: new Date().toISOString(),
  };
}

export interface HeartbeatResult {
  ok: true;
  /** Lifecycle command for the worker. null = keep running. */
  command: 'disable' | 'rotated' | null;
  heartbeatIntervalMs: number;
}

/**
 * Telemetry + lease. Returns:
 *  - `disable`  — ownership moved back to the platform, the bot was disabled, or
 *                 this instanceId is a duplicate: the worker must shut down.
 *  - `rotated`  — Slack tokens were rotated; the worker must re-provision now.
 * The response IS the command channel: the worker polls this on the heartbeat
 * cadence, so no inbound connection is ever needed.
 */
export async function workerHeartbeat(botId: string, input: HeartbeatInput): Promise<HeartbeatResult> {
  const bot = await prisma.slackBot.findUnique({
    where: { id: botId },
    select: { id: true, enabled: true, executionOwner: true, activeInstance: true, workerRotationPending: true },
  });
  if (!bot) throw notFound('Bot');

  if (bot.executionOwner !== 'HOST_WORKER' || !bot.enabled) {
    return { ok: true, command: 'disable', heartbeatIntervalMs: HEARTBEAT_MS };
  }
  if (bot.activeInstance && bot.activeInstance !== input.instanceId) {
    return { ok: true, command: 'disable', heartbeatIntervalMs: HEARTBEAT_MS };
  }

  const offline = input.socketConnected === false || input.status === 'DISCONNECTED' || input.status === 'INACTIVE';
  const status = offline ? 'DISCONNECTED' as const : input.status === 'ERROR' ? 'ERROR' as const : 'CONNECTED' as const;

  await prisma.slackBot.update({
    where: { id: botId },
    data: {
      status,
      activeInstance: input.instanceId,
      lastCheckedAt: new Date(),
      lastError: status === 'ERROR' ? (input.lastError ?? 'Host worker reported an error') : null,
    },
  });

  return { ok: true, command: bot.workerRotationPending ? 'rotated' : null, heartbeatIntervalMs: HEARTBEAT_MS };
}

export interface MessageResult {
  /** Plain text for the worker to post to Slack (DM reply). */
  reply?: string;
  /** Replacement text for the approval card (block_actions); the worker posts it to response_url. */
  updateCard?: string;
}

/**
 * One Slack event forwarded by the host worker, resolved here and handed back
 * for the worker to post. The platform is the authority for identity linking,
 * assistant chat and approval decisions; the worker is only the connection.
 */
export async function workerMessage(botId: string, input: MessageInput): Promise<MessageResult> {
  const bot = await prisma.slackBot.findUnique({
    where: { id: botId },
    select: { id: true, enabled: true, executionOwner: true, workerMode: true },
  });
  if (!bot) throw notFound('Bot');
  if (bot.executionOwner !== 'HOST_WORKER') throw conflict('BOT_NOT_HOST_OWNED', 'This bot is platform-owned; the host worker must not serve its traffic.');
  if (!bot.enabled) throw conflict('BOT_DISABLED', 'This bot is disabled.');

  if (input.type === 'block_actions') {
    return { updateCard: await resolveWorkerBlockAction(input) };
  }

  // squid_bot mode: block_actions above ARE its own approval cards (D3 — same
  // approve/decline state machine as every other door), but free-text chat is
  // the thin worker's dialect. Slash commands live on the host and would bypass
  // the shared request validation if bridged, so they stop here (409).
  if (bot.workerMode === 'SQUID_BOT') {
    throw conflict('BOT_MODE_SQUID', 'Squid host bots do not bridge free-text chat; use slash commands or the dashboard.');
  }

  const text = (input.text ?? '').trim();
  if (!text) return { reply: "I didn't catch that. Try `link LINK-XXXX` or `unlink`." };

  // Phase C identity linking — intercept the one-time code / unlink command
  // before anything reaches the assistant (same handling as SlackManager.handleIdentityCommand).
  const link = text.match(/^link\s+(LINK-[0-9a-fA-F]{8})$/);
  if (link) {
    const user = await redeemLinkCode(link[1]!.toUpperCase(), input.user);
    return {
      reply: user
        ? `Linked to ${user.email}${user.name ? ` (${user.name})` : ''}. Your Slack identity now authorizes approval-card decisions on this platform.`
        : 'Code not recognized or expired. Regenerate it from the platform (My Profile → Slack) and try again within 5 minutes.',
    };
  }
  if (/^unlink\s*$/.test(text)) {
    const ok = await unlinkSlackId(input.user);
    return { reply: ok ? 'Your Slack identity is unlinked.' : 'No linked identity found for this Slack account.' };
  }

  // Slack users are not authenticated to us, so end_user guidance is the floor.
  try {
    const { reply } = await agentChat(text, 'end_user');
    return { reply: reply || "I'm sorry, I couldn't think of a reply." };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const msg = code === 'AGENT_NOT_CONFIGURED'
      ? 'The assistant API is not configured yet. Please contact your administrator.'
      : 'Something went wrong reaching the assistant. Please try again.';
    return { reply: msg };
  }
}

// Mirror of slackApprovals.handleApprovalInteraction for the HOST_WORKER path:
// the SAME service functions (approveTicket/declineTicket, resolveTicketOrg) so
// one state machine has two doors. The only difference is we cannot call
// users.info (no platform-held token round-trip for worker bots) and we return
// the replacement text instead of writing response_url ourselves — the worker,
// which holds the bot's tokens, posts the card's outcome.
const ACTION_APPROVE = 'approve';
const ACTION_DECLINE = 'decline';

async function resolveWorkerBlockAction(input: MessageInput): Promise<string> {
  const action = input.actions?.[0];
  const ticketId = action?.value;
  const decision = action?.action_id;
  if (!ticketId || (decision !== ACTION_APPROVE && decision !== ACTION_DECLINE)) {
    return 'That action is no longer valid.';
  }
  const notAllowed = 'You need to be an admin of the governing organization (or a platform administrator) to decide this ticket.';

  try {
    // Phase C slackId binding only (no API round-trip for the worker path).
    const user = await prisma.user.findFirst({
      where: { slackId: input.user },
      select: { id: true, customerId: true, role: true },
    });
    if (!user) return 'No platform account found for your Slack identity. Approve/decline from the BanihalOrb dashboard instead.';
    if (user.role === 'USER') return notAllowed;
    if (user.role === 'ORG_ADMIN') {
      if (!user.customerId) return notAllowed;
      const owner = await resolveTicketOrg(ticketId);
      if (owner !== user.customerId) return notAllowed;
    }

    const actor = await runWithTicketDb('default', () => resolveTicketActor(user.id, user.role));
    const ticket = await runWithTicketDb('default', () =>
      decision === ACTION_DECLINE
        ? declineTicket(ticketId, actor.id, null)
        : approveTicket(ticketId, actor.id),
    );

    if (user.customerId) {
      void emitOrgTicketEvent({ customerId: user.customerId, type: 'ticket.status_changed', ticket }).catch(() => undefined);
      await audit({
        action: decision === ACTION_DECLINE ? 'TICKET_DECLINED' : 'TICKET_APPROVED',
        performedById: user.id,
        targetId: ticketId,
        customerId: user.customerId,
        metadata: { ticketNumber: ticket.ticketNumber, via: 'slack-host-worker' },
      });
    }

    return `✅ *${ticket.ticketNumber}* ${decision}d by <@${input.user}>.`;
  } catch (err) {
    const status = (err as { status?: number })?.status;
    return status === 409
      ? 'This ticket has already been approved or declined.'
      : 'Something went wrong. Please decide from the BanihalOrb dashboard instead.';
  }
}

/** First org a bot is assigned to, for audit scoping (bots are cross-tenant). */
async function firstOrgCustomerId(botId: string): Promise<string | null> {
  const row = await prisma.slackBotOrg.findFirst({ where: { botId }, select: { customerId: true } });
  return row?.customerId ?? null;
}