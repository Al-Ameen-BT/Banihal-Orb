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

export async function notifyTicketAssigned({
  ticket, assigneeTicketUserId, actorTicketUserId,
}: AssignmentNotification): Promise<void> {
  if (!isPushConfigured()) return;
  if (!assigneeTicketUserId) return;
  // Self-assignment (incl. the administrator claim flow) needs no notification.
  if (assigneeTicketUserId === actorTicketUserId) return;

  const recipient = await resolveB2bIdentity(assigneeTicketUserId);
  if (!recipient) return; // bot or non-bridged ticketing user — nobody to notify

  await sendToUser({
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
