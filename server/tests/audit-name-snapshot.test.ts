import { describe, it, expect } from 'vitest';
import { prisma } from '../src/config/database';
import { audit } from '../src/lib/audit';
import { createTestOrg, createTestUser } from './helpers';

// The AuditLog.performedById FK is ON DELETE SET NULL. Deleting an account used to
// anonymize every row that person ever wrote — the system-activity page showed '—'
// for user and role, and the deletion events they themselves generated lost who
// they were. audit() now snapshots performer identity into metadata at write time,
// so the trail stays attributable after the account is gone.
describe('audit trail survives actor deletion', () => {
  it('snapshots the performer and keeps the name after SET NULL', async () => {
    const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const org = await createTestOrg(`audit-${tag}`);
    const actor = await createTestUser(org.id, `actor-${tag}@audit.test`, 'ADMINISTRATOR', 'administration');
    const target = await createTestUser(org.id, `target-${tag}@audit.test`, 'USER');

    await audit({
      action: 'USER_REMOVED',
      performedById: actor.id,
      targetId: target.id,
      customerId: org.id,
      metadata: { targetEmail: target.email, targetName: target.name, targetRole: target.role },
    });

    const row = await prisma.auditLog.findFirst({ orderBy: { createdAt: 'desc' }, where: { performedById: actor.id } });
    expect(row).toBeDefined();
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({
      performedByName: actor.name,

      performedByEmail: actor.email,
      performedByRole: 'ADMINISTRATOR',
      targetName: target.name,
      targetEmail: target.email,
    });

    // Delete the actor: the FK goes NULL, but the snapshot must survive.
    await prisma.user.delete({ where: { id: actor.id } });
    const after = await prisma.auditLog.findUnique({ where: { id: row!.id }, include: { performedBy: true } });
    expect(after!.performedBy).toBeNull();
    expect((after!.metadata as Record<string, unknown>).performedByName).toBe(actor.name);
    expect((after!.metadata as Record<string, unknown>).performedByEmail).toBe(actor.email);
  });
});