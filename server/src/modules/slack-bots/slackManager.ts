import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { prisma } from '../../config/database';
import { decryptSecret } from '../../config/slackCrypto';
import { agentChat } from '../../services/agentApi';
import { handleApprovalInteraction, type BlockActionPayload } from './slackApprovals';
import { redeemLinkCode, unlinkSlackId } from './slackLink';

// ─── Slack bot manager (singleton) ───────────────────────────────────────────
// Owns the live connections for every enabled SlackBot. Uses the Slack Web API to
// validate/health-check (auth.test) and, when an app-level token is present, opens a
// Socket Mode connection to bridge inbound Slack messages to the Analytics Agent and
// post the reply back. Live status is persisted to the SlackBot row; a poll loop keeps
// it fresh. No public URL is required (Socket Mode is an outbound WebSocket).

interface Conn { web: WebClient; socket?: SocketModeClient; botUserId?: string | undefined }

const POLL_MS = 30_000;

class SlackManager {
  private conns = new Map<string, Conn>();
  private poll: NodeJS.Timeout | null = null;

  async init(): Promise<void> {
    const bots = await prisma.slackBot.findMany({ where: { enabled: true } });
    for (const b of bots) await this.connect(b.id).catch(() => undefined);
    if (!this.poll) this.poll = setInterval(() => void this.pollStatus(), POLL_MS);
  }

  // (Re)connect a bot from its current DB row. Safe to call repeatedly.
  async connect(botId: string): Promise<void> {
    const bot = await prisma.slackBot.findUnique({ where: { id: botId } });
    if (!bot || !bot.enabled) { await this.disconnect(botId); return; }
    await this.disconnect(botId, false); // drop any stale connection first

    const web = new WebClient(decryptSecret(bot.botTokenEnc));
    try {
      const auth = await web.auth.test();
      const botUserId = (auth.user_id as string | undefined) ?? undefined;
      await prisma.slackBot.update({
        where: { id: botId },
        data: { status: 'CONNECTED', botUserId, teamName: (auth.team as string | undefined) ?? null, lastError: null, lastCheckedAt: new Date() },
      });
      const conn: Conn = { web, botUserId };

      if (bot.appTokenEnc) {
        const socket = new SocketModeClient({ appToken: decryptSecret(bot.appTokenEnc) });
        socket.on('slack_event', async ({ ack, event }: { ack: () => Promise<void>; event: SlackEvent }) => {
          await ack();
          await this.handleEvent(conn, event).catch(() => undefined);
        });
        await socket.start();
        conn.socket = socket;
      }
      this.conns.set(botId, conn);
    } catch (err) {
      await prisma.slackBot.update({
        where: { id: botId },
        data: { status: 'ERROR', lastError: errMessage(err), lastCheckedAt: new Date() },
      });
    }
  }

  async disconnect(botId: string, persist = true): Promise<void> {
    const conn = this.conns.get(botId);
    if (conn?.socket) await conn.socket.disconnect().catch(() => undefined);
    this.conns.delete(botId);
    if (persist) {
      await prisma.slackBot.update({ where: { id: botId }, data: { status: 'DISCONNECTED', lastCheckedAt: new Date() } }).catch(() => undefined);
    }
  }

  // Called after any admin CRUD change to bring the live connection in line with the DB.
  async reconcile(botId: string): Promise<void> {
    const bot = await prisma.slackBot.findUnique({ where: { id: botId }, select: { enabled: true } });
    if (bot?.enabled) await this.connect(botId);
    else await this.disconnect(botId);
  }

  private async pollStatus(): Promise<void> {
    for (const [botId, conn] of this.conns) {
      try {
        const auth = await conn.web.auth.test();
        await prisma.slackBot.update({
          where: { id: botId },
          data: { status: 'CONNECTED', botUserId: (auth.user_id as string | undefined) ?? undefined, lastError: null, lastCheckedAt: new Date() },
        });
      } catch (err) {
        await prisma.slackBot.update({ where: { id: botId }, data: { status: 'ERROR', lastError: errMessage(err), lastCheckedAt: new Date() } }).catch(() => undefined);
      }
    }
  }

  // Bridge an inbound Slack user message to the assistant and reply in-thread.
  private async handleEvent(conn: Conn, event: SlackEvent): Promise<void> {
    if (!event) return;
    // Approval-card button clicks (interactive events arrive with the full
    // block_actions payload under `payload`). Side-effect free ack already sent.
    if (event.type === 'interactive' && event.payload?.type === 'block_actions') {
      await handleApprovalInteraction(conn, event.payload);
      return;
    }
    if (event.type !== 'message' && event.type !== 'app_mention') return;
    if (event.bot_id || event.subtype || (conn.botUserId && event.user === conn.botUserId)) return; // ignore bots / edits / self
    if (event.type === 'message' && event.channel_type !== 'im') return; // only DMs (mentions handled via app_mention)
    const text = stripMention(event.text ?? '', conn.botUserId).trim();
    if (!text) return;
    // Phase C identity linking — intercept the one-time code and unlink commands
    // before anything reaches the assistant.
    const linked = await this.handleIdentityCommand(conn, event, text);
    if (linked) return;
    // Slack users are not authenticated to us, so end_user guidance is the floor.
    const { reply } = await agentChat(text, 'end_user');
    if (reply) await conn.web.chat.postMessage({ channel: event.channel, text: reply, thread_ts: event.thread_ts });
  }

  // Handles `link LINK-XXXX` / `unlink` DMs. Returns true when consumed.
  private async handleIdentityCommand(conn: Conn, event: SlackEvent, text: string): Promise<boolean> {
    const m = text.match(/^link\s+(LINK-[0-9a-fA-F]{8})$/);
    if (m) {
      const user = await redeemLinkCode(m[1]!.toUpperCase(), event.user ?? '');
      const msg = user
        ? `Linked to ${user.email}${user.name ? ` (${user.name})` : ''}. Your Slack id now authorizes approval-card decisions on this platform.`
        : 'Code not recognized or expired. Regenerate it from the platform (My Profile → Slack) and try again within 5 minutes.';
      await conn.web.chat.postMessage({ channel: event.channel, text: msg, thread_ts: event.thread_ts });
      return true;
    }
    if (/^unlink\s*$/.test(text)) {
      const ok = await unlinkSlackId(event.user ?? '');
      await conn.web.chat.postMessage({
        channel: event.channel,
        text: ok ? 'Your Slack identity is unlinked.' : 'No linked identity found for this Slack account.',
        thread_ts: event.thread_ts,
      });
      return true;
    }
    return false;
  }
}

interface SlackEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel: string;
  channel_type?: string;
  thread_ts?: string;
  payload?: BlockActionPayload;
}

function stripMention(text: string, botUserId?: string): string {
  return botUserId ? text.replace(new RegExp(`<@${botUserId}>`, 'g'), '') : text;
}

function errMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.slice(0, 500);
}

export const slackManager = new SlackManager();
