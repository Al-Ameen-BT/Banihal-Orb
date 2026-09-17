import { WebClient } from '@slack/web-api';
import { prisma } from '../../config/database';
import { runWithTicketDb } from '../../config/ticketDatabase';
import { approveTicket, declineTicket } from '../ticketing/ticketing.service';
import { resolveTicketActor } from '../ticketing/identity';
import { resolveTicketOrg } from '../external-api/external-scope';
import { audit } from '../../lib/audit';
import { emitOrgTicketEvent } from '../external-api/external-webhooks';
import type { TicketDTO } from '../ticketing/ticketing.types';

// ─── Slack approval cards ─────────────────────────────────────────────────────
// External-created tickets arrive with `pending:approval`. When the ticket's
// assignee is a Slack bot persona and the owning org has an approvalChannelId,
// the bot posts a card with Approve / Decline buttons to that channel. Clicks
// arrive as Socket Mode `interactive` events and are resolved here through the
// SAME service functions the platform UI calls — one state machine, two doors.

const ACTION_APPROVE = 'approve';
const ACTION_DECLINE = 'decline';

export interface BlockActionPayload {
  type: 'block_actions';
  actions?: Array<{ action_id: string; value?: string; type: string }>;
  user?: { id: string; name?: string };
  response_url?: string;
  container?: { message_ts?: string };
  message?: { ts?: string };
}

/** Post an approval card for a `pending:approval` ticket, best-effort. */
export async function notifyApprovalCardForTicket(opts: {
  botTokenEnc: string;
  channel: string;
  ticket: { id: string; ticketNumber: string; title: string; description: string; priority: string; type: string };
  orgName: string;
}): Promise<void> {
  const { channel, ticket, orgName } = opts;
  const web = new WebClient(opts.botTokenEnc);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Approval required: ${ticket.ticketNumber}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${ticket.title}*\n${ticket.description.slice(0, 500)}` } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Priority:*\n${ticket.priority}` },
        { type: 'mrkdwn', text: `*Type:*\n${ticket.type}` },
        { type: 'mrkdwn', text: `*Organization:*\n${orgName}` },
      ],
    },
    {
      type: 'actions',
      block_id: `approval_${ticket.id}`,
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Approve', emoji: true }, style: 'primary', action_id: ACTION_APPROVE, value: ticket.id },
        { type: 'button', text: { type: 'plain_text', text: 'Decline', emoji: true }, style: 'danger', action_id: ACTION_DECLINE, value: ticket.id },
      ],
    },
  ];
  const res = await web.chat.postMessage({ channel, blocks, text: `Approval required: ${ticket.ticketNumber}: ${ticket.title}` });
  if (!res.ok) throw new Error(`Slack approval card failed (${res.error})`);
}

/** Replace the card with the outcome so the whole channel sees the decision. */
function replaceCard(response_url: string, text: string): void {
  void fetch(response_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replace_original: true, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }),
  }).catch(() => undefined);
}

interface Decider {
  ticketUserId: string;  // bridged ticketing Users.id (the approve/decline actor)
  b2bUserId: string;
  customerId: string | null;
  role: 'ADMINISTRATOR' | 'ORG_ADMIN' | 'USER';
}

/** Resolve the Slack clicker to a platform account. Prefers the Phase C slackId
 *  binding (no API round-trip); falls back to email discovery via users.info
 *  (needs the bot's `users:read.email` scope for profile.email). */
async function resolveDecider(conn: { web: WebClient }, slackUserId: string): Promise<Decider | null> {
  const linked = slackUserId
    ? await prisma.user.findFirst({
        where: { slackId: slackUserId },
        select: { id: true, customerId: true, role: true },
      })
    : null;
  const base = linked ?? await viaEmailDiscovery(conn, slackUserId);
  if (!base) return null;
  const actor = await runWithTicketDb('default', () => resolveTicketActor(base.id, base.role));
  return { ticketUserId: actor.id, b2bUserId: base.id, customerId: base.customerId, role: base.role };
}

async function viaEmailDiscovery(conn: { web: WebClient }, slackUserId: string) {
  if (!slackUserId) return null;
  const info = await conn.web.users.info({ user: slackUserId });
  const email = info.user?.profile?.email;
  if (!email) return null;
  return prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, customerId: true, role: true },
  });
}

/** Platform admins decide anything; org admins only their own org's tickets. */
async function mayDecide(d: Decider, ticketId: string): Promise<boolean> {
  if (d.role === 'ADMINISTRATOR') return true;
  if (d.role !== 'ORG_ADMIN' || !d.customerId) return false;
  const org = await resolveTicketOrg(ticketId);
  return org === d.customerId;
}

// ─── Delivery hook (called from the external ticket create) ─────────────────
// Post the card when the assignee is a Slack bot persona AND the org has an
// approval channel configured. Best-effort: never fail the ticket creation.

export async function notifyApprovalForExternalTicket(dto: TicketDTO, orgCustomerId: string | undefined): Promise<void> {
  if (!orgCustomerId || !dto.assignee?.id) return;
  try {
    const bot = await prisma.slackBot.findFirst({
      where: { ticketUserId: dto.assignee.id },
      select: { id: true, botTokenEnc: true },
    });
    if (!bot) return;
    const link = await prisma.slackBotOrg.findUnique({
      where: { botId_customerId: { botId: bot.id, customerId: orgCustomerId } },
      select: { approvalChannelId: true },
    });
    if (!link?.approvalChannelId) return;
    const org = await prisma.customer.findUnique({ where: { id: orgCustomerId }, select: { name: true } });
    await notifyApprovalCardForTicket({
      botTokenEnc: bot.botTokenEnc,
      channel: link.approvalChannelId,
      orgName: org?.name ?? '',
      ticket: {
        id: dto.id, ticketNumber: dto.ticketNumber, title: dto.title,
        description: dto.description, priority: dto.priority, type: dto.type,
      },
    });
  } catch (err) {
    console.error('⚠️  Slack approval card delivery failed:', err instanceof Error ? err.message : err);
  }
}

/** Handle a `block_actions` Socket Mode event from an approval card. */
export async function handleApprovalInteraction(conn: { web: WebClient }, payload: BlockActionPayload): Promise<void> {
  const action = payload.actions?.[0];
  const ticketId = action?.value;
  const responseUrl = payload.response_url;
  if (!ticketId || !responseUrl) return;
  const decision = action.action_id;

  try {
    const decider = await resolveDecider(conn, payload.user?.id ?? '');
    if (!decider) {
      replaceCard(responseUrl, `No platform account found for your Slack identity. Approve/decline ${ticketId.slice(0, 8)}… from the B2B dashboard instead.`);
      return;
    }
    if (!(await mayDecide(decider, ticketId))) {
      replaceCard(responseUrl, 'You need to be an admin of the governing organization (or a platform administrator) to decide this ticket.');
      return;
    }

    const ticket = await runWithTicketDb('default', () =>
      decision === ACTION_DECLINE
        ? declineTicket(ticketId, decider.ticketUserId, null)
        : approveTicket(ticketId, decider.ticketUserId),
    );

    // Same webhook as the platform-UI decision: the org's consumers hear that
    // the ticket left `pending:approval`.
    if (decider.customerId) {
      void emitOrgTicketEvent({ customerId: decider.customerId, type: 'ticket.status_changed', ticket }).catch(() => undefined);
      await audit({
        action: decision === ACTION_DECLINE ? 'TICKET_DECLINED' : 'TICKET_APPROVED',
        performedById: decider.b2bUserId,
        targetId: ticketId,
        customerId: decider.customerId,
        metadata: { ticketNumber: ticket.ticketNumber, via: 'slack' },
      });
    }

    replaceCard(responseUrl, `✅ *${ticket.ticketNumber}* ${decision} by <@${payload.user?.id ?? ''}>.`);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    replaceCard(responseUrl, status === 409
      ? 'This ticket has already been approved or declined.'
      : 'Something went wrong. Please decide from the B2B dashboard instead.');
  }
}