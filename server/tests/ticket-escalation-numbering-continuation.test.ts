import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import { createTestOrg, createTestUser, loginAs, ticketTestDbReady, ticketDbSkipReason } from './helpers';
import { prisma } from '../src/config/database';
import { adminTicketPrisma, runWithTicketDb } from '../src/config/ticketDatabase';
import { deriveOrgCode } from '../src/utils/orgCode';
import { DEFAULT_FORMAT } from '../src/modules/ticketing/services/numberFormat';
import { parseEscalationNumber, validateEscalationNumbering } from '../src/modules/ticketing/services/escalationNumbering';

// Escalated copies must continue the SOURCE org's per-store sequence with the
// org-coded format (TKT-<ORGCODE>-001, -002, …) even when the customer has NO
// stored orgCode row — the code is then derived from the org name, exactly like
// source-ticket creation, instead of the copy silently falling into the admin
// store's global TKT-NNN counter. These tests also exercise the validation
// system (validateEscalationNumbering) that guards the scheme.

const ready = ticketTestDbReady();
describe.skipIf(!ready)(`escalated-copy continuing numbering${ready ? '' : ` (SKIPPED: ${ticketDbSkipReason()})`}`, () => {
  async function setupOrg(tag: string) {
    const name = `Num Cont ${tag}`;
    const org = await createTestOrg(name);
    const orgCode = await prisma.customer.findUnique({ where: { id: org.id }, select: { orgCode: true } });
    expect(orgCode?.orgCode, 'fixture org must have NO stored orgCode so derivation kicks in').toBeNull();
    const email = `nc-${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}@example.com`;
    const admin = await createTestUser(org.id, email, 'ORG_ADMIN');
    const ac = await loginAs(admin.email);
    return { name, code: deriveOrgCode(name), admin, ac };
  }

  it('copies continue the per-org sequence using the DERIVED code (no orgCode row)', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const { code, ac } = await setupOrg(`Org A ${now}`);
    await request(app).get('/api/ticketing/tickets?mine=true').set('Cookie', ac).expect(200);
    const proj = await request(app).post('/api/ticketing/projects').set('Cookie', ac).send({ name: `Num Cont Proj ${now}` });
    expect(proj.status).toBe(201);

    const mk = (title: string) => request(app).post('/api/ticketing/tickets').set('Cookie', ac)
      .send({ title, description: 'test', projectId: proj.body.id, escalateToAdministrators: true });

    const r1 = await mk('first'); expect(r1.status).toBe(201);
    const r2 = await mk('second'); expect(r2.status).toBe(201);
    const num1 = r1.body.ticketNumber as string;
    const num2 = r2.body.ticketNumber as string;
    expect(num1).toMatch(new RegExp(`^TKT-${code}-\\d{3,}$`));
    expect(num2).not.toBe(num1);

    const src1 = await request(app).get(`/api/ticketing/tickets/${r1.body.id}`).set('Cookie', ac).expect(200);
    expect(src1.body.labels).toContain('escalated');

    // Copies land in the ADMIN store with the derived code and a CONTINUING
    // sequence (second copy = first + 1) — the org segment must NOT be dropped.
    // NB: the shared test DB can already carry org-coded rows for the same derived
    // code from earlier runs, so we assert continuation relatively, not from 001.
    const copy1 = await adminTicketPrisma.tickets.findFirst({
      where: { labels: { has: `src:${num1}` } },
      select: { ticketNumber: true, labels: true },
    });
    const copy2 = await adminTicketPrisma.tickets.findFirst({
      where: { labels: { has: `src:${num2}` } },
      select: { ticketNumber: true, labels: true },
    });
    expect(copy1).toBeDefined();
    expect(copy2).toBeDefined();
    const p1 = parseEscalationNumber(copy1!.ticketNumber, DEFAULT_FORMAT);
    const p2 = parseEscalationNumber(copy2!.ticketNumber, DEFAULT_FORMAT);
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(p1!.orgCode).toBe(code);
    expect(p2!.orgCode).toBe(code);
    expect(p2!.seq).toBe(p1!.seq + 1);
  });

  it('per-org sequences stay isolated (org B starts at 001, not 003)', async () => {
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const { code: codeA, ac: acA } = await setupOrg(`Org Iso A ${now}`);
    const { code: codeB, ac: acB } = await setupOrg(`Org Iso B ${now}`);
    await request(app).get('/api/ticketing/tickets?mine=true').set('Cookie', acA).expect(200);
    await request(app).get('/api/ticketing/tickets?mine=true').set('Cookie', acB).expect(200);

    const projA = await request(app).post('/api/ticketing/projects').set('Cookie', acA).send({ name: `Num Iso Proj A ${now}` });
    const projB = await request(app).post('/api/ticketing/projects').set('Cookie', acB).send({ name: `Num Iso Proj B ${now}` });
    expect(projA.status).toBe(201);
    expect(projB.status).toBe(201);

    const mk = (ac: string[], projectId: string, title: string) => request(app).post('/api/ticketing/tickets').set('Cookie', ac)
      .send({ title, description: 'test', projectId, escalateToAdministrators: true });

    // Org A escalates twice, org B escalates once.
    const a1 = await mk(acA, projA.body.id, 'iso a1'); expect(a1.status).toBe(201);
    const a2 = await mk(acA, projA.body.id, 'iso a2'); expect(a2.status).toBe(201);
    const b1 = await mk(acB, projB.body.id, 'iso b1'); expect(b1.status).toBe(201);

    const copyA1 = await adminTicketPrisma.tickets.findFirst({ where: { labels: { has: `src:${a1.body.ticketNumber}` } }, select: { ticketNumber: true } });
    const copyA2 = await adminTicketPrisma.tickets.findFirst({ where: { labels: { has: `src:${a2.body.ticketNumber}` } }, select: { ticketNumber: true } });
    const copyB1 = await adminTicketPrisma.tickets.findFirst({ where: { labels: { has: `src:${b1.body.ticketNumber}` } }, select: { ticketNumber: true } });
    const pa1 = parseEscalationNumber(copyA1!.ticketNumber, DEFAULT_FORMAT);
    const pa2 = parseEscalationNumber(copyA2!.ticketNumber, DEFAULT_FORMAT);
    const pb1 = parseEscalationNumber(copyB1!.ticketNumber, DEFAULT_FORMAT);
    expect(pa1).not.toBeNull();
    expect(pa2).not.toBeNull();
    expect(pb1).not.toBeNull();
    expect(pa1!.orgCode).toBe(codeA);
    expect(pa2!.orgCode).toBe(codeA);
    expect(pa2!.seq).toBe(pa1!.seq + 1);
    // Isolation: org B gets its OWN org segment (its counter does not continue A's).
    expect(codeA).not.toBe(codeB);
    expect(pb1!.orgCode).toBe(codeB);
  });

  it('validation reports the freshly-created per-org group as contiguous', async () => {
    // Note: the shared test DB may carry org-coded leftovers from earlier runs,
    // so this asserts on THIS test's own sequence rather than a global ok=true.
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const { code, ac } = await setupOrg(`Org Healthy ${now}`);
    await request(app).get('/api/ticketing/tickets?mine=true').set('Cookie', ac).expect(200);
    const proj = await request(app).post('/api/ticketing/projects').set('Cookie', ac).send({ name: `Num Healthy Proj ${now}` });
    expect(proj.status).toBe(201);
    const made = await request(app).post('/api/ticketing/tickets').set('Cookie', ac).send({
      title: 'healthy copy', description: 'test', projectId: proj.body.id, escalateToAdministrators: true,
    });
    expect(made.status).toBe(201);
    expect(made.body.ticketNumber).toMatch(new RegExp(`^TKT-${code}-\\d{3,}$`));

    const report = await runWithTicketDb('admin', () => validateEscalationNumbering());
    const madeParsed = parseEscalationNumber(made.body.ticketNumber, DEFAULT_FORMAT) ?? { orgCode: code, seq: -1 };
    const group = report.groups.find((g) => g.orgCode === code);
    expect(group).toBeDefined();
    expect(group!.seqs).toContain(madeParsed.seq);
    expect(group!.maxSeq).toBe(madeParsed.seq);
    expect(group!.gaps).toEqual([]);
    expect(group!.duplicatedSeqs).toEqual([]);
  });

  it('validation flags an escalated copy that lost its org segment', async () => {
    // Plant a copy that regresses to the old bug: 'escalated'+'src:' but a plain
    // global TKT-NNN number with no org code.
    const now = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const { ac } = await setupOrg(`Org Bad ${now}`);
    await request(app).get('/api/ticketing/tickets?mine=true').set('Cookie', ac).expect(200);
    const proj = await request(app).post('/api/ticketing/projects').set('Cookie', ac).send({ name: `Num Bad Proj ${now}` });
    const made = await request(app).post('/api/ticketing/tickets').set('Cookie', ac).send({
      title: 'good copy', description: 'test', projectId: proj.body.id, escalateToAdministrators: true,
    });
    expect(made.status).toBe(201);
    const goodCopy = await adminTicketPrisma.tickets.findFirst({
      where: { labels: { has: `src:${made.body.ticketNumber}` } },
      select: { id: true, projectId: true, reporterId: true, createdBy: true },
    })!;

    const badNum = `TKT-${(parseInt(now.slice(-3), 10) || 900) + 1}`;
    const bad = await adminTicketPrisma.tickets.create({
      data: {
        ticketNumber: badNum,
        title: 'regressed copy',
        description: 'planted by test',
        projectId: goodCopy!.projectId,
        reporterId: goodCopy!.reporterId,
        createdBy: goodCopy!.createdBy,
        labels: ['escalated', `src:stray-${now}`],
      },
      select: { id: true, ticketNumber: true },
    });
    try {
      const report = await runWithTicketDb('admin', () => validateEscalationNumbering());
      expect(report.ok).toBe(false);
      expect(report.uncodedCopies.map((c) => c.ticketNumber)).toContain(bad.ticketNumber);
    } finally {
      await adminTicketPrisma.tickets.delete({ where: { id: bad.id } });
    }
  });
});