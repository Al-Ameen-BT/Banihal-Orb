import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { audit } from '../../lib/audit';
import { sendToUser, isPushConfigured } from '../../lib/webpush';
import { usersWithPermission } from '../platform-roles/platformRoles.service';
import * as mailService from '../mail/mail.service';

// ─── Organization approval ───────────────────────────────────────────────────
// Admission control for self-service signup. Registering created an organization
// that could sign in as soon as its email was confirmed; now a human at the vendor
// has to admit it first.
//
// The handover is deliberately out-of-band. A code is emailed to every staff member
// holding `orgs.approve`; one of them satisfies themselves the signup is genuine and
// reads the code to the org's admin, who types it into the page they are already on.
// Nothing about that exchange happens over the wire, which is the point: the check
// being enforced is "a person at the vendor vouched for this", and no amount of
// request forgery substitutes for that.
//
// Security shape, mirroring EmailMfaChallenge:
//   - the raw code is returned by NO endpoint and set in NO cookie. It exists in
//     plaintext only in the staff email body.
//   - stored bcrypt-hashed, so reading the database cannot recover it.
//   - attempt-counted and short-lived, which is what makes 6 digits sufficient.
//   - the browser holds only `challengeId`, useless without the code.

const BCRYPT_ROUNDS = 12;

const challengeInvalid = () =>
  Object.assign(new Error('This approval request is no longer valid. Ask for a new code.'), {
    status: 400,
    code: 'ORG_APPROVAL_INVALID',
  });

/** Details the approver needs to decide, and the org admin's mailbox for the audit trail. */
interface OrgForApproval {
  id: string;
  name: string;
  mailId: string;
  contactPerson: string;
  domain: string | null;
}

/**
 * Generate, hash, store and distribute a fresh code. Replaces any prior challenge
 * for the org, so only the newest code is ever valid.
 *
 * Returns the challenge id and its expiry — never the code.
 */
export async function issueApprovalChallenge(
  org: OrgForApproval,
  /** The staff member who triggered a re-issue; null when the org admin's own
   *  email confirmation issued it. Recorded on the single audit row this writes. */
  actorId: string | null = null,
): Promise<{ challengeId: string; expiresAt: Date }> {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + env.ORG_APPROVAL_TTL_MINUTES * 60_000);

  // Upsert rather than delete+create: customerId is unique, and re-issuing must
  // reset the attempt counter as well as the code.
  const challenge = await prisma.orgApprovalChallenge.upsert({
    where: { customerId: org.id },
    create: { customerId: org.id, codeHash, expiresAt, lastSentAt: new Date() },
    update: { codeHash, expiresAt, attempts: 0, lastSentAt: new Date() },
    select: { id: true, expiresAt: true },
  });

  await notifyApprovers(org, code, actorId);

  return { challengeId: challenge.id, expiresAt: challenge.expiresAt };
}

/**
 * Deliver the code to every staff member who can act on it, at their own mailbox.
 *
 * Best-effort per recipient: one bad address must not stop the others, since any
 * single delivery is enough to unblock the organization.
 */
async function notifyApprovers(
  org: OrgForApproval,
  code: string,
  actorId: string | null,
): Promise<void> {
  const approvers = await usersWithPermission('orgs.approve');

  if (approvers.length === 0) {
    // Nobody can admit this org, so the signup is stranded and no customer-visible
    // symptom would ever explain why. Make it loud and make it auditable.
    console.error(
      `⚠️  Org approval: no staff hold 'orgs.approve' — ${org.name} cannot be admitted by anyone.`,
    );
    await audit({
      action: 'ORG_APPROVAL_NO_RECIPIENTS',
      performedById: null,
      customerId: org.id,
      metadata: { orgName: org.name },
    }).catch(() => {});
    return;
  }

  const details: mailService.OrgApprovalDetails = {
    orgName: org.name,
    contactPerson: org.contactPerson,
    contactEmail: org.mailId,
    domain: org.domain,
  };

  const results = await Promise.allSettled(
    approvers.map((a) =>
      mailService.sendOrgApprovalEmail(a.email, code, details, env.ORG_APPROVAL_TTL_MINUTES),
    ),
  );
  const delivered = results.filter((r) => r.status === 'fulfilled' && r.value).length;
  if (delivered === 0) {
    console.error(
      `⚠️  Org approval: code for ${org.name} reached none of its ${approvers.length} approver(s).`,
    );
  }

  // Push is an ALERT, not a delivery channel — it deliberately carries no code.
  // A notification renders on a lock screen, which is the wrong place for the
  // secret that admits an organization; the code travels by email only.
  if (isPushConfigured()) {
    await Promise.allSettled(
      approvers.map((a) =>
        sendToUser({
          userId: a.id,
          tenantId: a.customerId,
          payload: {
            title: 'Organization awaiting approval',
            body: `${org.name} has registered. The approval code is in your email.`,
            url: '/saas-admin/pending',
            tag: `org-approval-${org.id}`,
          },
        }),
      ),
    );
  }

  await audit({
    action: 'ORG_APPROVAL_REQUESTED',
    performedById: actorId,
    customerId: org.id,
    // Recipient count, never the code and never the addresses.
    metadata: {
      orgName: org.name,
      approvers: approvers.length,
      emailsDelivered: delivered,
      ...(actorId ? { reissuedByStaff: true } : {}),
    },
  }).catch(() => {});
}

/**
 * Validate a code and admit the organization.
 *
 * Returns the org's admin user so the caller can issue a session — the code plus a
 * confirmed mailbox is what authorises that. Throws on every failure path; the org
 * stays pending unless bcrypt.compare actually succeeds.
 */
export async function verifyApprovalCode(
  challengeId: string,
  code: string,
): Promise<{ userId: string; customerId: string; orgName: string }> {
  const challenge = await prisma.orgApprovalChallenge.findUnique({
    where: { id: challengeId },
    include: { customer: { select: { id: true, name: true, approved: true } } },
  });

  if (!challenge || challenge.expiresAt < new Date()) throw challengeInvalid();

  // Already admitted (a double submit, or two tabs): burn the stale challenge and
  // report it as spent rather than approving twice.
  if (challenge.customer.approved) {
    await prisma.orgApprovalChallenge.delete({ where: { id: challenge.id } }).catch(() => {});
    throw challengeInvalid();
  }

  if (challenge.attempts >= env.ORG_APPROVAL_MAX_ATTEMPTS) {
    await prisma.orgApprovalChallenge.delete({ where: { id: challenge.id } }).catch(() => {});
    throw Object.assign(new Error('Too many incorrect codes. Ask for a new one.'), {
      status: 429,
      code: 'ORG_APPROVAL_TOO_MANY_ATTEMPTS',
    });
  }

  const ok = await bcrypt.compare(code, challenge.codeHash);
  if (!ok) {
    const updated = await prisma.orgApprovalChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    const remaining = Math.max(0, env.ORG_APPROVAL_MAX_ATTEMPTS - updated.attempts);
    await audit({
      action: 'ORG_APPROVAL_FAILED',
      performedById: null,
      customerId: challenge.customer.id,
      metadata: { orgName: challenge.customer.name, attempts: updated.attempts },
    }).catch(() => {});
    throw Object.assign(
      new Error(
        remaining > 0
          ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`
          : 'Too many incorrect codes. Ask for a new one.',
      ),
      { status: 400, code: 'ORG_APPROVAL_CODE_INVALID', remaining },
    );
  }

  // The org's admin — the account that registered it. Resolved before the write so
  // an org somehow lacking one fails closed rather than being approved for nobody.
  const admin = await prisma.user.findFirst({
    where: { customerId: challenge.customer.id, role: 'ORG_ADMIN' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, name: true, emailVerifiedAt: true },
  });
  if (!admin) throw challengeInvalid();

  // Belt and braces: a session is about to be issued, so re-assert the thing the
  // caller is trusted to have already checked.
  if (!admin.emailVerifiedAt) throw challengeInvalid();

  await prisma.$transaction([
    prisma.customer.update({
      where: { id: challenge.customer.id },
      data: { approved: true, approvedAt: new Date() },
    }),
    // Burn the challenge so the code cannot be replayed.
    prisma.orgApprovalChallenge.delete({ where: { id: challenge.id } }),
  ]);

  await audit({
    action: 'ORG_APPROVED',
    performedById: admin.id,
    customerId: challenge.customer.id,
    metadata: { orgName: challenge.customer.name },
  }).catch(() => {});

  // Send a welcome email to the organization's founding admin.
  await mailService.sendWelcomeEmail(admin.email, { name: admin.name, orgName: challenge.customer.name });

  return { userId: admin.id, customerId: challenge.customer.id, orgName: challenge.customer.name };
}

/**
 * Re-issue a code for an in-flight challenge, subject to a cooldown so this cannot
 * be used to mail-bomb the approvers. Returns a NEW challenge id — the row is
 * upserted by customer, and the client is told the new id and expiry.
 */
export async function resendApprovalCode(
  challengeId: string,
): Promise<{ challengeId: string; expiresAt: Date }> {
  const challenge = await prisma.orgApprovalChallenge.findUnique({
    where: { id: challengeId },
    include: {
      customer: {
        select: { id: true, name: true, mailId: true, contactPerson: true, domain: true, approved: true },
      },
    },
  });
  if (!challenge || challenge.customer.approved) throw challengeInvalid();

  const waitMs =
    challenge.lastSentAt.getTime() + env.ORG_APPROVAL_RESEND_COOLDOWN_SECONDS * 1000 - Date.now();
  if (waitMs > 0) {
    throw Object.assign(
      new Error(`Please wait ${Math.ceil(waitMs / 1000)}s before requesting another code.`),
      { status: 429, code: 'ORG_APPROVAL_RESEND_COOLDOWN', retryAfter: Math.ceil(waitMs / 1000) },
    );
  }

  const { approved: _approved, ...org } = challenge.customer;
  return issueApprovalChallenge(org);
}

/**
 * Re-issue from the control plane, addressed by organization rather than by
 * challenge — the staff-side entry point, for when a code was never received.
 */
export async function reissueForCustomer(
  customerId: string,
  actorId: string,
): Promise<{ expiresAt: Date }> {
  const org = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, name: true, mailId: true, contactPerson: true, domain: true, approved: true },
  });
  if (!org) {
    throw Object.assign(new Error('Organization not found.'), { status: 404, code: 'NOT_FOUND' });
  }
  if (org.approved) {
    throw Object.assign(new Error('This organization is already approved.'), {
      status: 409,
      code: 'ORG_ALREADY_APPROVED',
    });
  }

  const { approved: _approved, ...rest } = org;
  // The actor is threaded into the single audit row issueApprovalChallenge writes,
  // rather than adding a second row for the same click.
  const { expiresAt } = await issueApprovalChallenge(rest, actorId);
  return { expiresAt };
}

/** Organizations still awaiting admission, for the control-plane queue. */
export async function listPendingOrgs() {
  const rows = await prisma.customer.findMany({
    where: { approved: false },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      domain: true,
      mailId: true,
      contactPerson: true,
      contactNumber: true,
      createdAt: true,
      // Never selects codeHash: the code is unrecoverable by design, and the queue
      // shows only whether a live code exists and when it lapses.
      approvalChallenge: { select: { expiresAt: true, lastSentAt: true, attempts: true } },
      users: { select: { emailVerifiedAt: true }, orderBy: { createdAt: 'asc' }, take: 1 },
    },
  });

  return rows.map(({ users, approvalChallenge, ...org }) => ({
    ...org,
    emailVerified: Boolean(users[0]?.emailVerifiedAt),
    codeExpiresAt: approvalChallenge?.expiresAt ?? null,
    codeAttempts: approvalChallenge?.attempts ?? 0,
  }));
}
