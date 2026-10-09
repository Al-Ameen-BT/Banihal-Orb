// Phase C Slack hardening: one-time identity-link codes.
//
// Flow: the user asks the platform for a code (authed POST /api/slack/link).
// The raw code is shown ONCE; only its SHA-256 hash is stored, with a 5-minute
// TTL. Redeeming "link <CODE>" in a Slack DM binds the slacker's member id to
// the user (User.slackId), which then authorizes approval-card decisions
// without per-event email discovery via users.info.

import crypto from 'crypto';
import { prisma, customerContext } from '../../config/database';
import { audit } from '../../lib/audit';

const LINK_TTL_MS = 5 * 60 * 1000;

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export async function issueLinkCode(userId: string, customerId: string): Promise<{ code: string; expiresInSeconds: number }> {
  const code = `LINK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  await prisma.user.update({
    where: { id: userId },
    data: {
      slackLinkCodeHash: hashCode(code),
      slackLinkExpiresAt: new Date(Date.now() + LINK_TTL_MS),
    },
  });
  await audit({ action: 'SLACK_LINK_CODE_ISSUED', performedById: userId, customerId, metadata: {} });
  return { code, expiresInSeconds: LINK_TTL_MS / 1000 };
}

/** Redeem from a Slack DM. Returns the linked user or null (bad/expired/reused). */
export async function redeemLinkCode(code: string, slackMemberId: string): Promise<{ name: string | null; email: string } | null> {
  const hash = hashCode(code.toUpperCase());
  // The code is the bearer secret binding the Slack member id, so the lookup is
  // deliberately cross-tenant: any platform user is linkable from the DM.
  return customerContext.exit(async () => {
    const user = await prisma.user.findFirst({
      where: { slackLinkCodeHash: hash, slackLinkExpiresAt: { gt: new Date() } },
      select: { id: true, name: true, email: true, customerId: true },
    });
    if (!user) return null;
    // One-time: bind and immediately clear the code fields.
    await prisma.user.update({
      where: { id: user.id },
      data: { slackId: slackMemberId, slackLinkCodeHash: null, slackLinkExpiresAt: null },
    });
    await audit({
      action: 'SLACK_IDENTITY_LINKED', performedById: user.id, customerId: user.customerId,
      metadata: { slackMemberId },
    });
    return { name: user.name, email: user.email };
  });
}

/** "unlink" in a DM: drop the binding if it belongs to the caller. */
export async function unlinkSlackId(slackMemberId: string): Promise<boolean> {
  return customerContext.exit(async () => {
    const user = await prisma.user.findFirst({ where: { slackId: slackMemberId }, select: { id: true, customerId: true } });
    if (!user) return false;
    await prisma.user.update({ where: { id: user.id }, data: { slackId: null } });
    await audit({
      action: 'SLACK_IDENTITY_LINKED', performedById: user.id, customerId: user.customerId,
      metadata: { slackMemberId, unlinked: true },
    });
    return true;
  });
}