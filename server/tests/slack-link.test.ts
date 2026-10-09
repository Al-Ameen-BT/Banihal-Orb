import { describe, expect, afterAll } from 'vitest';
import { prisma } from '../src/config/database';
import { createTestOrg, createTestUser, cleanDb } from './helpers';
import { issueLinkCode, redeemLinkCode, unlinkSlackId } from '../src/modules/slack-bots/slackLink';

describe('Slack identity linking (Phase C)', () => {
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    await cleanDb();
    orgId = (await createTestOrg('Slack Link Test')).id;
    userId = (await createTestUser(orgId, 'slacklink@example.com')).id;
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('issues a one-time code and stores only its SHA-256 hash', async () => {
    const { code, expiresInSeconds } = await issueLinkCode(userId, orgId);
    expect(code).toMatch(/^LINK-[0-9A-F]{8}$/);
    expect(expiresInSeconds).toBe(300);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.slackLinkCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.slackLinkExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(row.slackId).toBeNull();
  });

  it('redeems the code once, binds Slack id, burns the code', async () => {
    const { code } = await issueLinkCode(userId, orgId);
    const linked = await redeemLinkCode(code, 'U123SLACK');
    expect(linked?.email).toBe('slacklink@example.com');
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.slackId).toBe('U123SLACK');
    expect(row.slackLinkCodeHash).toBeNull();
    expect(row.slackLinkExpiresAt).toBeNull();
    // One-time: replaying the same code must fail.
    expect(await redeemLinkCode(code, 'UOTHER')).toBeNull();
  });

  it('rejects expiry, unknown and garbage codes', async () => {
    const { code } = await issueLinkCode(userId, orgId);
    await prisma.user.update({ where: { id: userId }, data: { slackLinkExpiresAt: new Date(Date.now() - 1000) } });
    expect(await redeemLinkCode(code, 'U123SLACK')).toBeNull();
    expect(await redeemLinkCode('LINK-ABCDEF12', 'U123SLACK')).toBeNull();
    expect(await redeemLinkCode('not-a-code', 'U123SLACK')).toBeNull();
  });

  it('unlinks only the caller-owned binding', async () => {
    const { code } = await issueLinkCode(userId, orgId);
    const linked = await redeemLinkCode(code, 'U123SLACK');
    expect(linked?.email).toBe('slacklink@example.com');
    expect(await unlinkSlackId('U123SLACK')).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).slackId).toBeNull();
    expect(await unlinkSlackId('U123SLACK')).toBe(false);
  });
});