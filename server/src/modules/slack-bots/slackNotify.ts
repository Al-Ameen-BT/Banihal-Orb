import { decryptSecret } from '../../config/slackCrypto';

// Post a newly created bot-assigned ticket into the bot's Slack channel via the
// bot's Incoming Webhook (configured by the administrator). Slack incoming webhooks
// are bound to one channel, so "where the bot is" = wherever the admin created the
// webhook. Delivery is best-effort: the ticket already exists — a Slack outage or a
// revoked webhook must never fail the ticket creation.

export interface BotTicketNotification {
  ticketNumber: string;
  title: string;
  description: string;
  priority: string;
  type: string;
  orgName: string;
  reporterName: string;
  botName: string;
  // Dynamic form values already resolved to their human labels, in field order.
  details: Array<{ label: string; value: string }>;
}

export async function notifyBotWebhook(webhookUrlEnc: string, n: BotTicketNotification): Promise<boolean> {
  let url: string;
  try { url = decryptSecret(webhookUrlEnc); } catch { return false; }

  const detailFields = n.details.map((d) => ({ type: 'mrkdwn' as const, text: `*${d.label}:*\n${d.value || '—'}` }));
  const payload = {
    text: `New ticket ${n.ticketNumber} assigned to ${n.botName}: ${n.title}`, // fallback for notifications
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `🎫 ${n.ticketNumber} — new ticket for ${n.botName}`, emoji: true } },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${n.title}*\n${n.description.slice(0, 500)}` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Priority:*\n${n.priority}` },
          { type: 'mrkdwn', text: `*Type:*\n${n.type}` },
          { type: 'mrkdwn', text: `*Organization:*\n${n.orgName}` },
          { type: 'mrkdwn', text: `*Raised by:*\n${n.reporterName}` },
        ],
      },
      // Slack caps section.fields at 10 — chunk the dynamic form values.
      ...Array.from({ length: Math.ceil(detailFields.length / 10) }, (_, i) => ({
        type: 'section' as const,
        fields: detailFields.slice(i * 10, i * 10 + 10),
      })),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Submitted via the B2B platform ticket form · ${new Date().toISOString()}` }] },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) console.error(`⚠️  Slack webhook delivery failed (${res.status}) for ${n.ticketNumber}: ${await res.text().catch(() => '')}`);
    return res.ok;
  } catch (err) {
    console.error(`⚠️  Slack webhook delivery error for ${n.ticketNumber}:`, err instanceof Error ? err.message : err);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
