import { prisma } from '../../config/database';
import { encryptSecret, decryptSecret } from '../../config/slackCrypto';
import type { AdBot } from './adKeyAuth.middleware';

const notFound = (w: string) => Object.assign(new Error(`${w} not found`), { status: 404, code: 'NOT_FOUND' });
const badRequest = (m: string) => Object.assign(new Error(m), { status: 400, code: 'BAD_REQUEST' });
const gone = (m: string) => Object.assign(new Error(m), { status: 410, code: 'AD_SECRET_GONE' });
const forbidden = () => Object.assign(new Error('You cannot view this credential'), { status: 403, code: 'FORBIDDEN' });

const TTL_MS = 24 * 60 * 60 * 1000;

// ─── Machine ingest: the AD automation delivers a temp password for a bot ticket ──
export async function deliverSecret(bot: AdBot, input: { ticketNumber: string; secret: string; targetEmail?: string }) {
  if (!input.secret || input.secret.length > 512) throw badRequest('secret is required (max 512 chars)');

  // A bot may only deliver for its OWN ticket.
  const submission = await prisma.botTicketSubmission.findFirst({ where: { botId: bot.id, ticketNumber: input.ticketNumber } });
  if (!submission) throw notFound('Ticket for this bot');

  // Target = the designated USER_EMAIL field value (or the explicitly passed email,
  // which must match the form value when both are present).
  const emailFields = await prisma.slackBotFormField.findMany({ where: { botId: bot.id, type: 'USER_EMAIL' }, select: { key: true } });
  const values = (submission.values as Record<string, unknown>) ?? {};
  const fromForm = emailFields.map((f) => values[f.key]).find((v) => typeof v === 'string' && v) as string | undefined;
  const passed = input.targetEmail?.trim().toLowerCase();
  if (passed && fromForm && passed !== fromForm.toLowerCase()) throw badRequest('targetEmail does not match the ticket');
  const targetEmail = (passed ?? fromForm)?.toLowerCase();
  if (!targetEmail) throw badRequest('No target email on this ticket (add a USER_EMAIL field or pass targetEmail)');

  // Resolve to a user in the ticket's organization (may be absent — requester can still view).
  const target = await prisma.user.findFirst({ where: { email: targetEmail, customerId: submission.customerId }, select: { id: true } });

  await prisma.adCredentialDelivery.upsert({
    where: { botId_ticketNumber: { botId: bot.id, ticketNumber: input.ticketNumber } },
    create: {
      botId: bot.id, customerId: submission.customerId, ticketId: submission.ticketId, ticketNumber: input.ticketNumber,
      targetUserId: target?.id ?? null, targetEmail, requestedById: submission.createdById,
      secretEnc: encryptSecret(input.secret), status: 'DELIVERED', expiresAt: new Date(Date.now() + TTL_MS),
    },
    update: {
      targetUserId: target?.id ?? null, targetEmail, secretEnc: encryptSecret(input.secret),
      status: 'DELIVERED', viewedByTarget: false, viewedByRequester: false, viewedAt: null,
      deliveredAt: new Date(), expiresAt: new Date(Date.now() + TTL_MS),
    },
  });

  await prisma.auditLog.create({
    // NOTE: never store the secret itself in the audit metadata.
    data: { action: 'AD_SECRET_DELIVERED', customerId: submission.customerId, targetId: submission.ticketId, metadata: { ticketNumber: input.ticketNumber, targetEmail, resolved: !!target } },
  }).catch(() => {});

  return { delivered: true };
}

// ─── Org side: list + one-time reveal ────────────────────────────────────────
type DeliveryRow = Awaited<ReturnType<typeof prisma.adCredentialDelivery.findFirstOrThrow>>;

function toDTO(d: DeliveryRow, userId: string) {
  const isTarget = d.targetUserId === userId;
  const isRequester = d.requestedById === userId;
  const expired = d.status === 'EXPIRED' || d.expiresAt < new Date();
  const alreadyViewed = (isTarget && d.viewedByTarget) || (isRequester && d.viewedByRequester);
  return {
    id: d.id, ticketNumber: d.ticketNumber, targetEmail: d.targetEmail,
    status: expired ? 'EXPIRED' : d.status,
    role: isTarget ? (isRequester ? 'both' : 'target') : 'requester',
    canReveal: !expired && !alreadyViewed && d.status === 'DELIVERED' && !!d.secretEnc,
    alreadyViewed, expiresAt: d.expiresAt.toISOString(), deliveredAt: d.deliveredAt.toISOString(),
  };
}

// Lazily flip an expired row to EXPIRED and purge its ciphertext.
async function purgeIfExpired(d: DeliveryRow): Promise<DeliveryRow> {
  if (d.secretEnc && d.expiresAt < new Date()) {
    return prisma.adCredentialDelivery.update({ where: { id: d.id }, data: { secretEnc: null, status: 'EXPIRED' } });
  }
  return d;
}

// Deliveries the caller can see (as target OR requester). Tenant-scoped by the
// extension; status only — never the secret.
export async function listForUser(userId: string) {
  const rows = await prisma.adCredentialDelivery.findMany({
    where: { OR: [{ targetUserId: userId }, { requestedById: userId }] },
    orderBy: { deliveredAt: 'desc' }, take: 50,
  });
  const fresh = await Promise.all(rows.map(purgeIfExpired));
  return fresh.map((d) => toDTO(d, userId));
}

// One-time reveal for the target user or the requesting org-admin.
export async function reveal(userId: string, id: string): Promise<{ password: string }> {
  let d = await prisma.adCredentialDelivery.findUnique({ where: { id } });
  if (!d) throw notFound('Credential');
  const isTarget = d.targetUserId === userId;
  const isRequester = d.requestedById === userId;
  if (!isTarget && !isRequester) throw forbidden();

  // A caller who already viewed their copy gets an accurate message even after the
  // ciphertext was purged by full consumption.
  if ((isTarget && d.viewedByTarget) || (isRequester && d.viewedByRequester)) throw gone('You have already viewed this credential.');
  d = await purgeIfExpired(d);
  if (!d.secretEnc || d.status === 'EXPIRED') throw gone('This credential has expired.');

  const password = decryptSecret(d.secretEnc);

  const viewedByTarget = d.viewedByTarget || isTarget;
  const viewedByRequester = d.viewedByRequester || isRequester;
  const fullyConsumed = viewedByTarget && viewedByRequester;
  await prisma.adCredentialDelivery.update({
    where: { id },
    data: {
      viewedByTarget, viewedByRequester, viewedAt: new Date(),
      ...(fullyConsumed ? { secretEnc: null, status: 'VIEWED' } : {}),
    },
  });
  await prisma.auditLog.create({
    data: { action: 'AD_SECRET_VIEWED', performedById: userId, customerId: d.customerId, targetId: d.ticketId, metadata: { ticketNumber: d.ticketNumber, as: isTarget ? 'target' : 'requester' } },
  }).catch(() => {});

  return { password };
}
