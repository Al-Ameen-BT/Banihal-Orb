import type { z } from 'zod';
import { prisma } from '../../config/database';
import { runWithTicketDb } from '../../config/ticketDatabase';
import * as ticketService from '../ticketing/ticketing.service';
import { resolveTicketActor } from '../ticketing/identity';
import { notifyBotWebhook } from '../slack-bots/slackNotify';
import type { CreateBotTicketSchema } from './bots.schema';

const notFound = (w: string) => Object.assign(new Error(`${w} not found`), { status: 404, code: 'NOT_FOUND' });
const badRequest = (m: string) => Object.assign(new Error(m), { status: 400, code: 'BAD_REQUEST' });

type FieldRow = Awaited<ReturnType<typeof prisma.slackBotFormField.findFirstOrThrow>>;

function toOrgBotDTO(bot: { id: string; name: string; slug: string; description: string | null; status: string; ticketUserId: string | null; formFields: FieldRow[] }) {
  return {
    id: bot.id, name: bot.name, slug: bot.slug, description: bot.description,
    status: bot.status, ticketUserId: bot.ticketUserId,
    formFields: bot.formFields.map((f) => ({
      id: f.id, key: f.key, label: f.label, type: f.type, required: f.required,
      options: (f.options as string[] | null) ?? null,
      placeholder: f.placeholder, helpText: f.helpText, order: f.order,
    })),
  };
}

// This org's enabled, assigned bots. SlackBotOrg is tenant-scoped → auto-filtered by customerId.
export async function listOrgBots() {
  const links = await prisma.slackBotOrg.findMany({
    include: { bot: { include: { formFields: { orderBy: { order: 'asc' } } } } },
  });
  return links.map((l) => l.bot).filter((b) => b.enabled).map(toOrgBotDTO);
}

// Coerce + validate the submitted values against the bot's field schema.
function validateValues(fields: FieldRow[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = raw[f.key];
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (f.required && f.type !== 'CHECKBOX') throw badRequest(`"${f.label}" is required`);
      if (f.type === 'CHECKBOX') out[f.key] = false;
      continue;
    }
    switch (f.type) {
      case 'NUMBER': {
        const n = Number(v);
        if (Number.isNaN(n)) throw badRequest(`"${f.label}" must be a number`);
        out[f.key] = n; break;
      }
      case 'CHECKBOX': out[f.key] = v === true || v === 'true' || v === 'on'; break;
      case 'SELECT': {
        const opts = (f.options as string[] | null) ?? [];
        if (!opts.includes(String(v))) throw badRequest(`"${f.label}" has an invalid selection`);
        out[f.key] = String(v); break;
      }
      case 'USER_EMAIL': {
        const email = String(v).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest(`"${f.label}" must be a valid email`);
        out[f.key] = email; break;
      }
      default: out[f.key] = String(v).slice(0, 5000);
    }
  }
  return out;
}

export async function createBotTicket(
  user: { userId: string; role: 'USER' | 'ORG_ADMIN' | 'ADMINISTRATOR'; customerId: string },
  botId: string,
  input: z.infer<typeof CreateBotTicketSchema>,
) {
  // Verify the bot is assigned to the caller's org (tenant-scoped read).
  const link = await prisma.slackBotOrg.findFirst({ where: { botId }, select: { id: true } });
  if (!link) throw notFound('Bot');
  const bot = await prisma.slackBot.findUnique({ where: { id: botId }, include: { formFields: true } });
  if (!bot || !bot.enabled) throw badRequest('This bot is not available.');
  if (!bot.ticketUserId) throw badRequest('This bot is not wired as a ticket assignee.');

  const values = validateValues(bot.formFields, input.values);

  // Create the ticket in the shared (default) ticket store, assigned to the bot.
  const ticket = await runWithTicketDb('default', async () => {
    const actor = await resolveTicketActor(user.userId, user.role);
    return ticketService.createTicket(actor.id, {
      title: input.title,
      description: input.description,
      projectId: input.projectId,
      type: input.type,
      priority: input.priority,
      status: 'todo',
      assigneeId: bot.ticketUserId!,
    }, user.customerId);
  });

  await prisma.botTicketSubmission.create({
    data: { botId, customerId: user.customerId, ticketId: ticket.id, ticketNumber: ticket.ticketNumber, values, createdById: user.userId },
  });

  // Deliver the ticket into the bot's Slack channel (Incoming Webhook) so the bot
  // can act on it. Best-effort: the ticket + submission are already saved.
  let slackNotified = false;
  if (bot.webhookUrlEnc) {
    const [org, reporter] = await Promise.all([
      prisma.customer.findUnique({ where: { id: user.customerId }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: user.userId }, select: { name: true } }),
    ]);
    const details = [...bot.formFields]
      .sort((a, b) => a.order - b.order)
      .filter((f) => values[f.key] !== undefined)
      .map((f) => ({ label: f.label, value: String(values[f.key]) }));
    slackNotified = await notifyBotWebhook(bot.webhookUrlEnc, {
      ticketNumber: ticket.ticketNumber,
      title: input.title,
      description: input.description,
      priority: input.priority,
      type: input.type,
      orgName: org?.name ?? 'Unknown organization',
      reporterName: reporter?.name ?? 'Unknown',
      botName: bot.name,
      details,
    });
  }

  return { ticket, botName: bot.name, slackNotified };
}
