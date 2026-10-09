import { describe, it, expect, beforeEach, vi } from 'vitest';

// Prisma, SMTP and web-push are mocked at the boundary: what is under test is the
// admission logic — who gets the code, what the code is worth, and what the org can
// do before it is admitted — not Postgres. Keeps the file in CI's DB-free set.
const db = {
  user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
  customer: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
  orgApprovalChallenge: {
    findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn(), delete: vi.fn().mockResolvedValue({}),
  },
  platformRole: { findMany: vi.fn().mockResolvedValue([]) },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  refreshToken: {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({ id: 'rt1' }),
  },
  emailVerificationToken: {
    findUnique: vi.fn(), findFirst: vi.fn(),
    create: vi.fn().mockResolvedValue({}), deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  $transaction: vi.fn().mockResolvedValue([]),
};
vi.mock('../src/config/database', () => ({ prisma: db, customerContext: { exit: (f: () => unknown) => f() } }));

const sendOrgApprovalEmail = vi.fn().mockResolvedValue(true);
vi.mock('../src/modules/mail/mail.service', () => ({
  sendOrgApprovalEmail: (...a: unknown[]) => sendOrgApprovalEmail(...a),
  sendVerificationEmail: vi.fn().mockResolvedValue(true),
  sendPasswordResetEmail: vi.fn(), sendMfaCodeEmail: vi.fn(), sendInviteEmail: vi.fn(),
}));

const sendToUser = vi.fn().mockResolvedValue({ total: 0, sent: 0, removed: 0, failed: 0, outcomes: [] });
vi.mock('../src/lib/webpush', () => ({
  sendToUser: (...a: unknown[]) => sendToUser(...a),
  isPushConfigured: () => true,
}));

vi.mock('../src/modules/auth/passwordReuse', () => ({
  assertPasswordNotReused: vi.fn(), passwordFingerprint: () => 'fp',
}));

const orgApproval = await import('../src/modules/auth/orgApproval.service');
const auth = await import('../src/modules/auth/auth.service');
const bcrypt = (await import('bcryptjs')).default;

const ORG = { id: 'c1', name: 'Acme Ltd', mailId: 'admin@acme.com', contactPerson: 'Dana', domain: 'acme.com' };
const future = () => new Date(Date.now() + 600_000);
const past = () => new Date(Date.now() - 60_000);

/** The plaintext code as it was handed to the mailer — the only place it exists. */
const emailedCode = (): string => (sendOrgApprovalEmail.mock.calls[0] as [string, string])[1];

beforeEach(() => {
  Object.values(db).forEach((m) =>
    typeof m === 'function'
      ? (m as ReturnType<typeof vi.fn>).mockClear()
      : Object.values(m).forEach((f) => (f as ReturnType<typeof vi.fn>).mockClear?.()),
  );
  sendOrgApprovalEmail.mockClear();
  sendToUser.mockClear();
  db.orgApprovalChallenge.upsert.mockResolvedValue({ id: 'ch1', expiresAt: future() });
  // Two approvers: an Administration holder (permissions computed) and an HR Admin
  // holder (key stored in the column). Both must be selected.
  db.platformRole.findMany.mockResolvedValue([
    { id: 'r-admin', key: 'administration', permissions: [] },
    { id: 'r-hr', key: 'hr_admin', permissions: ['orgs.approve', 'orgs.manage'] },
    { id: 'r-emp', key: 'employee', permissions: ['tickets.view'] },
  ]);
  db.user.findMany.mockResolvedValue([
    { id: 'u-admin', name: 'Alex', email: 'alex@platform.com', customerId: 'plat' },
    { id: 'u-hr', name: 'Robin', email: 'robin@platform.com', customerId: 'plat' },
  ]);
});

describe('issueApprovalChallenge — who gets the code', () => {
  it('emails every Administration and HR Admin user at their own address', async () => {
    await orgApproval.issueApprovalChallenge(ORG);

    // Selection asked for exactly the roles holding orgs.approve, and only staff.
    const where = db.user.findMany.mock.calls[0]![0].where;
    expect(where.role).toBe('ADMINISTRATOR');
    expect(where.platformRoleId.in).toEqual(expect.arrayContaining(['r-admin', 'r-hr']));
    expect(where.platformRoleId.in).not.toContain('r-emp');

    expect(sendOrgApprovalEmail).toHaveBeenCalledTimes(2);
    const recipients = sendOrgApprovalEmail.mock.calls.map((c) => (c as [string])[0]);
    expect(recipients).toEqual(['alex@platform.com', 'robin@platform.com']);
  });

  it('stores the code hashed, never in plaintext', async () => {
    await orgApproval.issueApprovalChallenge(ORG);
    const stored = db.orgApprovalChallenge.upsert.mock.calls[0]![0].create.codeHash;
    const code = emailedCode();

    expect(code).toMatch(/^\d{6}$/);
    expect(stored).not.toBe(code);
    expect(await bcrypt.compare(code, stored)).toBe(true);
  });

  it('returns only the challenge id and expiry — never the code', async () => {
    const result = await orgApproval.issueApprovalChallenge(ORG);
    expect(result).toEqual({ challengeId: 'ch1', expiresAt: expect.any(Date) });
    expect(JSON.stringify(result)).not.toContain(emailedCode());
  });

  it('pushes an ALERT that does not carry the code', async () => {
    await orgApproval.issueApprovalChallenge(ORG);
    expect(sendToUser).toHaveBeenCalledTimes(2);
    const payload = (sendToUser.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload;
    expect(JSON.stringify(payload)).not.toContain(emailedCode());
    expect(payload.title).toMatch(/approval/i);
  });

  it('audits and warns when nobody holds orgs.approve, instead of failing silently', async () => {
    db.user.findMany.mockResolvedValue([]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await orgApproval.issueApprovalChallenge(ORG);

    expect(sendOrgApprovalEmail).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'ORG_APPROVAL_NO_RECIPIENTS' }) }),
    );
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('never puts the code, or an approver address, in the audit metadata', async () => {
    await orgApproval.issueApprovalChallenge(ORG);
    const entry = db.auditLog.create.mock.calls.at(-1)![0].data;
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(emailedCode());
    expect(serialized).not.toContain('alex@platform.com');
  });
});

describe('verifyApprovalCode', () => {
  const challenge = async (code: string, over: Record<string, unknown> = {}) => ({
    id: 'ch1', attempts: 0, expiresAt: future(),
    codeHash: await bcrypt.hash(code, 4),
    customer: { id: 'c1', name: 'Acme Ltd', approved: false },
    ...over,
  });

  it('approves the org and burns the challenge on the right code', async () => {
    db.orgApprovalChallenge.findUnique.mockResolvedValue(await challenge('123456'));
    db.user.findFirst.mockResolvedValue({ id: 'u-org', emailVerifiedAt: new Date() });

    await expect(orgApproval.verifyApprovalCode('ch1', '123456'))
      .resolves.toMatchObject({ userId: 'u-org', customerId: 'c1' });

    // Approval and burn happen together, so a half-applied state is impossible.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1' }, data: { approved: true, approvedAt: expect.any(Date) } }),
    );
    expect(db.orgApprovalChallenge.delete).toHaveBeenCalledWith({ where: { id: 'ch1' } });
  });

  it('counts a wrong code against the attempt budget and leaves the org pending', async () => {
    db.orgApprovalChallenge.findUnique.mockResolvedValue(await challenge('123456'));
    db.orgApprovalChallenge.update.mockResolvedValue({ attempts: 1 });

    await expect(orgApproval.verifyApprovalCode('ch1', '000000'))
      .rejects.toMatchObject({ status: 400, code: 'ORG_APPROVAL_CODE_INVALID', remaining: 4 });

    expect(db.customer.update).not.toHaveBeenCalled();
    expect(db.orgApprovalChallenge.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attempts: { increment: 1 } } }),
    );
  });

  it('burns the challenge once the attempt budget is spent', async () => {
    db.orgApprovalChallenge.findUnique.mockResolvedValue(await challenge('123456', { attempts: 5 }));

    await expect(orgApproval.verifyApprovalCode('ch1', '123456'))
      .rejects.toMatchObject({ status: 429, code: 'ORG_APPROVAL_TOO_MANY_ATTEMPTS' });

    // Even the CORRECT code is refused once the budget is gone.
    expect(db.customer.update).not.toHaveBeenCalled();
    expect(db.orgApprovalChallenge.delete).toHaveBeenCalled();
  });

  it('rejects an expired challenge', async () => {
    db.orgApprovalChallenge.findUnique.mockResolvedValue(await challenge('123456', { expiresAt: past() }));
    await expect(orgApproval.verifyApprovalCode('ch1', '123456'))
      .rejects.toMatchObject({ code: 'ORG_APPROVAL_INVALID' });
    expect(db.customer.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown challenge id', async () => {
    db.orgApprovalChallenge.findUnique.mockResolvedValue(null);
    await expect(orgApproval.verifyApprovalCode('nope', '123456')).rejects.toMatchObject({ status: 400 });
  });

  it('refuses to re-approve an org that is already approved', async () => {
    db.orgApprovalChallenge.findUnique.mockResolvedValue(
      await challenge('123456', { customer: { id: 'c1', name: 'Acme Ltd', approved: true } }),
    );
    await expect(orgApproval.verifyApprovalCode('ch1', '123456')).rejects.toMatchObject({ status: 400 });
    expect(db.customer.update).not.toHaveBeenCalled();
  });

  it('fails closed when the org admin has not confirmed their email', async () => {
    db.orgApprovalChallenge.findUnique.mockResolvedValue(await challenge('123456'));
    db.user.findFirst.mockResolvedValue({ id: 'u-org', emailVerifiedAt: null });

    await expect(orgApproval.verifyApprovalCode('ch1', '123456')).rejects.toMatchObject({ status: 400 });
    expect(db.customer.update).not.toHaveBeenCalled();
  });
});

describe('resendApprovalCode', () => {
  it('enforces the cooldown so the approvers cannot be mail-bombed', async () => {
    db.orgApprovalChallenge.findUnique.mockResolvedValue({
      id: 'ch1', lastSentAt: new Date(), customer: { ...ORG, approved: false },
    });
    await expect(orgApproval.resendApprovalCode('ch1'))
      .rejects.toMatchObject({ status: 429, code: 'ORG_APPROVAL_RESEND_COOLDOWN' });
    expect(sendOrgApprovalEmail).not.toHaveBeenCalled();
  });

  it('issues a different code once the cooldown has elapsed', async () => {
    db.orgApprovalChallenge.findUnique.mockResolvedValue({
      id: 'ch1', lastSentAt: new Date(Date.now() - 3_600_000), customer: { ...ORG, approved: false },
    });

    await orgApproval.resendApprovalCode('ch1');

    expect(sendOrgApprovalEmail).toHaveBeenCalled();
    // Re-issue resets the attempt budget along with the code.
    expect(db.orgApprovalChallenge.upsert.mock.calls[0]![0].update).toMatchObject({ attempts: 0 });
  });
});

describe('the gate — a pending org cannot get in', () => {
  const pendingUser = async (approved: boolean) => ({
    id: 'u1', email: 'a@acme.com', customerId: 'c1', role: 'ORG_ADMIN', platformRoleId: null,
    passwordHash: await bcrypt.hash('pw', 4), mfaEnabled: false, emailVerifiedAt: new Date(),
    customer: { mfaRequired: false, approved, suspended: false },
  });

  it('blocks login for an org awaiting approval, even with the right password', async () => {
    db.user.findUnique.mockResolvedValue(await pendingUser(false));
    await expect(auth.initiateLogin({ email: 'a@acme.com', password: 'pw' } as never))
      .rejects.toMatchObject({ status: 403, code: 'ORG_NOT_APPROVED' });
  });

  it('lets an approved org through', async () => {
    db.user.findUnique.mockResolvedValue(await pendingUser(true));
    await expect(auth.initiateLogin({ email: 'a@acme.com', password: 'pw' } as never))
      .resolves.toMatchObject({ mfaRequired: false });
  });

  it('answers a wrong password with bad credentials, not ORG_NOT_APPROVED', async () => {
    // Otherwise login becomes an oracle for which organizations are pending.
    db.user.findUnique.mockResolvedValue(await pendingUser(false));
    await expect(auth.initiateLogin({ email: 'a@acme.com', password: 'WRONG' } as never))
      .rejects.not.toMatchObject({ code: 'ORG_NOT_APPROVED' });
  });

  it('blocks a new member joining a pending org', async () => {
    db.customer.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValue(null);
    (db as unknown as { customer: { findFirst: ReturnType<typeof vi.fn> } }).customer.findFirst =
      vi.fn().mockResolvedValue({ id: 'c1', suspended: false, approved: false });

    await expect(
      auth.registerUser({ name: 'N', email: 'new@acme.com', password: 'TestPassword1!', contactNumber: '+1' } as never),
    ).rejects.toMatchObject({ status: 403, code: 'ORG_NOT_APPROVED' });
  });
});

describe('verifyEmail hands back an approval challenge for a pending org', () => {
  it('returns the challenge id and expiry, and no code', async () => {
    db.emailVerificationToken.findUnique.mockResolvedValue({
      expiresAt: future(), user: { id: 'u1', email: 'a@acme.com', customerId: 'c1', emailVerifiedAt: null },
    });
    db.customer.findUnique.mockResolvedValue({ ...ORG, approved: false });

    const result = await auth.verifyEmail('raw');

    expect(result.approval).toMatchObject({ challengeId: 'ch1', organizationName: 'Acme Ltd' });
    expect(JSON.stringify(result)).not.toContain(emailedCode());
  });

  it('issues nothing for an org that is already approved', async () => {
    db.emailVerificationToken.findUnique.mockResolvedValue({
      expiresAt: future(), user: { id: 'u1', email: 'a@acme.com', customerId: 'c1', emailVerifiedAt: null },
    });
    db.customer.findUnique.mockResolvedValue({ ...ORG, approved: true });

    const result = await auth.verifyEmail('raw');

    expect(result.approval).toBeUndefined();
    expect(sendOrgApprovalEmail).not.toHaveBeenCalled();
  });
});
