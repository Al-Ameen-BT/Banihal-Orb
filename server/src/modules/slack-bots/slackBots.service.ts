import type { z } from 'zod';
import { prisma } from '../../config/database';
import { encryptSecret, decryptSecret, maskToken } from '../../config/slackCrypto';
import { runWithTicketDb } from '../../config/ticketDatabase';
import { resolveBotTicketUser } from '../ticketing/ticketing.client';
import { slackManager } from './slackManager';
import type { CreateBotSchema, UpdateBotSchema, FieldSchema, UpdateFieldSchema } from './slackBots.schema';

const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { status: 404, code: 'NOT_FOUND' });

type BotRow = Awaited<ReturnType<typeof prisma.slackBot.findFirstOrThrow>>;

// Admin-facing DTO — never leaks the raw tokens (only a masked hint + whether set).
function toBotDTO(b: BotRow & { formFields?: unknown[]; orgs?: unknown[] }) {
  return {
    id: b.id, name: b.name, slug: b.slug, description: b.description,
    status: b.status, lastError: b.lastError,
    lastCheckedAt: b.lastCheckedAt ? b.lastCheckedAt.toISOString() : null,
    teamName: b.teamName, botUserId: b.botUserId, enabled: b.enabled,
    botTokenHint: maskToken(safeDecrypt(b.botTokenEnc)),
    appTokenSet: !!b.appTokenEnc,
    fieldCount: b.formFields?.length ?? 0,
    orgCount: b.orgs?.length ?? 0,
    createdAt: b.createdAt.toISOString(),
  };
}
function safeDecrypt(enc: string): string { try { return decryptSecret(enc); } catch { return ''; } }

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bot';
}
async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${i}`;
    const exists = await prisma.slackBot.findUnique({ where: { slug }, select: { id: true } });
    if (!exists) return slug;
  }
  return `${base}-${Date.now()}`;
}

export async function listBots() {
  const bots = await prisma.slackBot.findMany({ include: { formFields: true, orgs: true }, orderBy: { createdAt: 'desc' } });
  return bots.map(toBotDTO);
}

export async function getBot(id: string) {
  const bot = await prisma.slackBot.findUnique({ where: { id }, include: { formFields: { orderBy: { order: 'asc' } }, orgs: true } });
  if (!bot) throw notFound('Bot');
  return { ...toBotDTO(bot), formFields: bot.formFields.map(toFieldDTO), orgIds: bot.orgs.map((o) => o.customerId) };
}

export async function createBot(input: z.infer<typeof CreateBotSchema>) {
  const slug = await uniqueSlug(input.name);
  // Bridge a ticket assignee row for the bot in the shared (default) ticket store.
  const ticketUserId = await runWithTicketDb('default', () => resolveBotTicketUser({ name: input.name, slug }));
  const bot = await prisma.slackBot.create({
    data: {
      name: input.name, slug, description: input.description ?? null,
      botTokenEnc: encryptSecret(input.botToken),
      appTokenEnc: input.appToken ? encryptSecret(input.appToken) : null,
      ticketUserId,
    },
    include: { formFields: true, orgs: true },
  });
  void slackManager.reconcile(bot.id); // connect + set live status (async)
  return toBotDTO(bot);
}

export async function updateBot(id: string, input: z.infer<typeof UpdateBotSchema>) {
  const existing = await prisma.slackBot.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw notFound('Bot');
  await prisma.slackBot.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.botToken !== undefined ? { botTokenEnc: encryptSecret(input.botToken) } : {}),
      ...(input.appToken !== undefined ? { appTokenEnc: input.appToken ? encryptSecret(input.appToken) : null } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
  });
  void slackManager.reconcile(id); // apply token/enabled changes to the live connection
  return getBot(id);
}

export async function deleteBot(id: string): Promise<void> {
  const existing = await prisma.slackBot.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw notFound('Bot');
  await slackManager.disconnect(id, false);
  await prisma.slackBot.delete({ where: { id } }); // cascades fields + orgs
}

export async function setEnabled(id: string, enabled: boolean) {
  await prisma.slackBot.update({ where: { id }, data: { enabled } });
  await slackManager.reconcile(id);
  return getBot(id);
}

// ─── Form fields ────────────────────────────────────────────────────────────
type FieldRow = Awaited<ReturnType<typeof prisma.slackBotFormField.findFirstOrThrow>>;
function toFieldDTO(f: FieldRow) {
  return {
    id: f.id, key: f.key, label: f.label, type: f.type, required: f.required,
    options: (f.options as string[] | null) ?? null,
    placeholder: f.placeholder, helpText: f.helpText, order: f.order,
  };
}

export async function listFields(botId: string) {
  const rows = await prisma.slackBotFormField.findMany({ where: { botId }, orderBy: { order: 'asc' } });
  return rows.map(toFieldDTO);
}
export async function addField(botId: string, input: z.infer<typeof FieldSchema>) {
  const bot = await prisma.slackBot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!bot) throw notFound('Bot');
  const row = await prisma.slackBotFormField.create({
    data: {
      botId, key: input.key, label: input.label, type: input.type,
      required: input.required ?? false, options: input.options ?? undefined,
      placeholder: input.placeholder ?? null, helpText: input.helpText ?? null,
      order: input.order ?? 0,
    },
  });
  return toFieldDTO(row);
}
export async function updateField(fieldId: string, input: z.infer<typeof UpdateFieldSchema>) {
  const row = await prisma.slackBotFormField.update({
    where: { id: fieldId },
    data: {
      ...(input.key !== undefined ? { key: input.key } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.required !== undefined ? { required: input.required } : {}),
      ...(input.options !== undefined ? { options: input.options ?? undefined } : {}),
      ...(input.placeholder !== undefined ? { placeholder: input.placeholder } : {}),
      ...(input.helpText !== undefined ? { helpText: input.helpText } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
    },
  });
  return toFieldDTO(row);
}
export async function deleteField(fieldId: string): Promise<void> {
  await prisma.slackBotFormField.delete({ where: { id: fieldId } });
}

// ─── Org assignment (per-organization availability) ──────────────────────────
export async function listBotOrgs(botId: string): Promise<string[]> {
  const rows = await prisma.slackBotOrg.findMany({ where: { botId }, select: { customerId: true } });
  return rows.map((r) => r.customerId);
}
export async function assignOrg(botId: string, customerId: string): Promise<void> {
  const bot = await prisma.slackBot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!bot) throw notFound('Bot');
  await prisma.slackBotOrg.upsert({ where: { botId_customerId: { botId, customerId } }, create: { botId, customerId }, update: {} });
}
export async function unassignOrg(botId: string, customerId: string): Promise<void> {
  await prisma.slackBotOrg.deleteMany({ where: { botId, customerId } });
}

// Organizations for the assignment picker.
export async function listCustomers() {
  const rows = await prisma.customer.findMany({ select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } });
  return rows;
}
