import { prisma } from '../../config/database';
import { customerContext } from '../../config/database';
import { sendToUser, isPushConfigured } from '../../lib/webpush';

/**
 * The one way to raise a notification.
 *
 * Two channels, deliberately unequal:
 *  - the DATABASE ROW is the guarantee. It is written synchronously and persists
 *    with read state until the recipient clears it.
 *  - WEB PUSH is an accelerator. It is opt-in per device and may fail for reasons
 *    entirely outside this request, so it is best-effort and never propagates.
 *
 * Before this existed, every "notification" in the system was recomputed on each
 * poll from a `since` watermark held in the browser's localStorage — so anything
 * that scrolled past the watermark was simply gone. That is tolerable for "a
 * ticket changed" and not for "someone asked you a question".
 */
export interface NotificationEntry {
  /** Recipient — a MAIN-database User id. */
  userId: string;
  /**
   * The RECIPIENT's organization, not the actor's.
   *
   * config/database.ts injects `customerId` into every scoped read, so a row
   * written with the actor's org would be invisible to the person it is for
   * whenever the two differ — which is exactly the cross-org case the admin
   * ticket store produces. identity.resolveB2bIdentity() returns this pair
   * together for that reason.
   */
  customerId: string;
  kind: string;
  title: string;
  body?: string;
  /** Deep link the bell and the push notification both navigate to. */
  url?: string;
  actorId?: string;
  /** Loose reference (e.g. a ticket id). No FK — it may live in another database. */
  entityId?: string;
}

const warned = new Set<string>();
const warnOnce = (key: string, message: string): void => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`⚠️  Notifications: ${message}`);
};

export async function notify(entry: NotificationEntry): Promise<void> {
  // Written OUTSIDE the caller's tenant context. `create` is not a scoped
  // operation today, but the recipient's org is frequently not the actor's, and
  // relying on that exemption silently would break the moment it changed.
  await customerContext.exit(() => prisma.notification.create({
    data: {
      userId: entry.userId,
      customerId: entry.customerId,
      kind: entry.kind,
      title: entry.title,
      ...(entry.body ? { body: entry.body } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      ...(entry.actorId ? { actorId: entry.actorId } : {}),
      ...(entry.entityId ? { entityId: entry.entityId } : {}),
    },
  }));

  void pushInBackground(entry);
}

/** Best-effort only: the row above is already committed and is the real delivery. */
function pushInBackground(entry: NotificationEntry): void {
  if (!isPushConfigured()) {
    warnOnce('unconfigured', 'push skipped — VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set');
    return;
  }
  void sendToUser({
    userId: entry.userId,
    tenantId: entry.customerId,
    payload: {
      title: entry.title,
      ...(entry.body ? { body: entry.body } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      // Collapse repeats about the same thing rather than stacking them.
      tag: `${entry.kind}-${entry.entityId ?? entry.userId}`,
      data: { kind: entry.kind, ...(entry.entityId ? { entityId: entry.entityId } : {}) },
    },
  }).catch((err) => console.error('⚠️  Notification push failed:', err instanceof Error ? err.message : err));
}

export interface NotificationListOptions { limit: number; before?: string | undefined; }

/**
 * The caller's OWN notifications.
 *
 * `userId` is filtered explicitly and that is not redundant: the tenant extension
 * injects only `customerId`, so without this every member of an organization
 * would read every other member's notifications.
 */
export async function listForUser(userId: string, { limit, before }: NotificationListOptions) {
  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId, ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return { items, unreadCount };
}

/** Scoped by userId so one user can never mark another's notification read. */
export async function markRead(userId: string, id: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: new Date() },
  });
}

export async function markAllRead(userId: string): Promise<number> {
  const { count } = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}
