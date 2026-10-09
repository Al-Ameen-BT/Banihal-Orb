import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

// Prisma and the mailer are mocked at the boundary: what is under test is the
// redemption/gate logic, not Postgres or SMTP. It also keeps this file runnable
// without the seeded test database.
const db = {
  user: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  emailVerificationToken: {
    findUnique: vi.fn(), findFirst: vi.fn(),
    create: vi.fn().mockResolvedValue({}), deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  // verifyEmail checks whether the account's org still needs platform approval.
  // Approved by default here so these tests keep exercising the verification gate
  // alone; the approval path has its own file (org-approval.test.ts).
  customer: {
    findUnique: vi.fn().mockResolvedValue({
      id: 'c1', name: 'Acme', mailId: 'a@b.com', contactPerson: 'A', domain: 'b.com', approved: true,
    }),
  },
  refreshToken: {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),      // no competing active session
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({ id: 'rt1' }),
  },
};
vi.mock('../src/config/database', () => ({ prisma: db, customerContext: { exit: (f: () => unknown) => f() } }));

const sendVerificationEmail = vi.fn().mockResolvedValue(true);
vi.mock('../src/modules/mail/mail.service', () => ({
  sendVerificationEmail: (...a: unknown[]) => sendVerificationEmail(...a),
  sendPasswordResetEmail: vi.fn(), sendMfaCodeEmail: vi.fn(), sendInviteEmail: vi.fn(),
}));
vi.mock('../src/modules/auth/passwordReuse', () => ({
  assertPasswordNotReused: vi.fn(), passwordFingerprint: () => 'fp',
}));

const auth = await import('../src/modules/auth/auth.service');
const bcrypt = (await import('bcryptjs')).default;

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60_000);

beforeEach(() => {
  Object.values(db).forEach((m) => Object.values(m).forEach((f) => (f as ReturnType<typeof vi.fn>).mockClear?.()));
  sendVerificationEmail.mockClear();
});

describe('verifyEmail', () => {
  it('stamps emailVerifiedAt and burns every token for that user', async () => {
    db.emailVerificationToken.findUnique.mockResolvedValue({
      expiresAt: future(), user: { id: 'u1', email: 'a@b.com', customerId: 'c1', emailVerifiedAt: null },
    });

    expect(await auth.verifyEmail('raw')).toEqual({ email: 'a@b.com' });
    expect(db.emailVerificationToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: sha256('raw') } }),  // hashed, never raw
    );
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1' }, data: { emailVerifiedAt: expect.any(Date) } }),
    );
    expect(db.emailVerificationToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });

  it('rejects an expired link instead of verifying on it', async () => {
    db.emailVerificationToken.findUnique.mockResolvedValue({
      expiresAt: past(), user: { id: 'u1', email: 'a@b.com', customerId: 'c1', emailVerifiedAt: null },
    });
    await expect(auth.verifyEmail('raw')).rejects.toMatchObject({ code: 'VERIFICATION_TOKEN_INVALID' });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown token', async () => {
    db.emailVerificationToken.findUnique.mockResolvedValue(null);
    await expect(auth.verifyEmail('nope')).rejects.toMatchObject({ status: 400 });
  });

  it('is idempotent — a second click does not re-stamp an already-verified account', async () => {
    db.emailVerificationToken.findUnique.mockResolvedValue({
      expiresAt: future(), user: { id: 'u1', email: 'a@b.com', customerId: 'c1', emailVerifiedAt: new Date() },
    });
    await expect(auth.verifyEmail('raw')).resolves.toEqual({ email: 'a@b.com' });
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe('resendEmailVerification', () => {
  it('says nothing and sends nothing for an unknown address (no enumeration)', async () => {
    db.user.findUnique.mockResolvedValue(null);
    await expect(auth.resendEmailVerification('ghost@b.com')).resolves.toBeUndefined();
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('sends nothing for an already-verified address', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', emailVerifiedAt: new Date() });
    await auth.resendEmailVerification('a@b.com');
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('enforces the cooldown so the endpoint cannot mail-bomb an address', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', emailVerifiedAt: null });
    db.emailVerificationToken.findFirst.mockResolvedValue({ lastSentAt: new Date() });
    await expect(auth.resendEmailVerification('a@b.com')).rejects.toMatchObject({ status: 429 });
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('sends once the cooldown has elapsed', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com', emailVerifiedAt: null });
    db.emailVerificationToken.findFirst.mockResolvedValue({
      lastSentAt: new Date(Date.now() - (auth.VERIFICATION_RESEND_COOLDOWN_SECONDS + 1) * 1000),
    });
    await auth.resendEmailVerification('a@b.com');
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    // The emailed link must carry the RAW token; only its hash is stored.
    const [, link] = sendVerificationEmail.mock.calls[0] as [string, string, number];
    const raw = new URL(link).searchParams.get('token')!;
    const stored = db.emailVerificationToken.create.mock.calls[0]![0].data.tokenHash;
    expect(stored).toBe(sha256(raw));
    expect(stored).not.toBe(raw);
  });
});

describe('initiateLogin — verification gate', () => {
  const user = async (emailVerifiedAt: Date | null) => ({
    id: 'u1', email: 'a@b.com', customerId: 'c1', role: 'USER', platformRoleId: null,
    passwordHash: await bcrypt.hash('pw', 4), mfaEnabled: false, emailVerifiedAt,
    customer: { mfaRequired: false, approved: true, suspended: false },
  });

  it('blocks an unverified account even with the right password', async () => {
    db.user.findUnique.mockResolvedValue(await user(null));
    await expect(auth.initiateLogin({ email: 'a@b.com', password: 'pw' } as never))
      .rejects.toMatchObject({ status: 403, code: 'EMAIL_NOT_VERIFIED' });
  });

  it('reports bad credentials — not EMAIL_NOT_VERIFIED — on a wrong password, so it cannot enumerate accounts', async () => {
    db.user.findUnique.mockResolvedValue(await user(null));
    await expect(auth.initiateLogin({ email: 'a@b.com', password: 'WRONG' } as never))
      .rejects.not.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  it('lets a verified account through', async () => {
    db.user.findUnique.mockResolvedValue(await user(new Date()));
    await expect(auth.initiateLogin({ email: 'a@b.com', password: 'pw' } as never))
      .resolves.toMatchObject({ mfaRequired: false });
  });
});
