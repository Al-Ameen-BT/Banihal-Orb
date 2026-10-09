import { sendToUser, isPushConfigured } from '../../../lib/webpush';
import { resolveB2bIdentity } from '../identity';
import type { TicketDTO } from '../ticketing.types';

// Web Push notification for "a ticket was assigned to you". Delivery is strictly
// best-effort: the assignment is already committed, so a missing VAPID key, an
// unbridged assignee or a dead push service must never fail the API call.

const PRIORITY_LABEL: Record<string, string> = {
  low: 'Low priority', medium: 'Medium priority', high: 'High priority', urgent: 'Urgent',
};

export interface AssignmentNotification {
  ticket: TicketDTO;
  assigneeTicketUserId: string | null;
  actorTicketUserId: string;   // whoever performed the assignment
}

// Every reason push does not happen used to be a bare `return`, so a
// misconfigured or mis-keyed deployment was indistinguishable from "nobody has
// subscribed". These warn once per reason — enough to diagnose from the journal,
// quiet enough not to flood it on a deployment that simply has push turned off.
const warned = new Set<string>();
const warnOnce = (key: string, message: string): void => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`⚠️  Web Push: ${message}`);
};

export async function notifyTicketAssigned({
  ticket, assigneeTicketUserId, actorTicketUserId,
}: AssignmentNotification): Promise<void> {
  if (!isPushConfigured()) {
    warnOnce('unconfigured', 'skipping notifications — VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set');
    return;
  }
  if (!assigneeTicketUserId) return;
  // Self-assignment (incl. the administrator claim flow) needs no notification.
  if (assigneeTicketUserId === actorTicketUserId) return;

  const recipient = await resolveB2bIdentity(assigneeTicketUserId);
  if (!recipient) {
    // A Slack bot, or ticketing staff created natively with no matching B2B
    // account. Expected for bots; for a person it means the email bridge missed.
    warnOnce(`unbridged:${assigneeTicketUserId}`,
      `no B2B account bridged for ticketing user ${assigneeTicketUserId} — ${ticket.ticketNumber} not notified`);
    return;
  }

  const result = await sendToUser({
    userId: recipient.userId,
    tenantId: recipient.tenantId,
    payload: {
      title: `${ticket.ticketNumber} assigned to you`,
      body: `${ticket.title}${ticket.projectName ? ` · ${ticket.projectName}` : ''} · ${PRIORITY_LABEL[ticket.priority] ?? ticket.priority}`,
      // Deep link handled by the ?ticket= param on the ticketing page.
      url: `/ticketing?ticket=${ticket.id}`,
      // Re-assigning the same ticket replaces the earlier notification.
      tag: `ticket-${ticket.id}`,
      data: { kind: 'ticket-assigned', ticketId: ticket.id, ticketNumber: ticket.ticketNumber },
    },
  });

  // sendToUser never throws for a per-endpoint failure, so without this a push
  // service rejecting every device wrote nothing anywhere. A 403 here is the
  // signature of a VAPID key mismatch — the one failure that looks like success.
  if (result.failed > 0) {
    const detail = result.outcomes
      .filter((o): o is Extract<typeof o, { status: 'error' }> => o.status === 'error')
      // Host only: the endpoint path is a device capability URL, not for the log.
      .map((o) => `${new URL(o.endpoint).host} ${o.statusCode ?? '?'} ${o.message}`)
      .join('; ');
    console.warn(
      `⚠️  Web Push: ${result.failed}/${result.total} deliveries failed for ${ticket.ticketNumber} — ${detail}`,
    );
  }
}

// Fire-and-forget wrapper for request paths: never awaited, never throws.
export function notifyTicketAssignedInBackground(args: AssignmentNotification): void {
  void notifyTicketAssigned(args).catch((err) =>
    console.error(
      `⚠️  Web Push assignment notification failed for ${args.ticket.ticketNumber}:`,
      err instanceof Error ? err.message : err,
    ),
  );
}
