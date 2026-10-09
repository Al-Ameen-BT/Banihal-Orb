/**
 * external-api-keys — issue / revoke / list machine credentials for the
 * external ticketing API.
 *
 *   npm run external:keys -- list
 *   npm run external:keys -- create --name "Slack bot" \
 *       --scopes tickets.view,tickets.write --store default \
 *       --customers <orgId>,<orgId> --by admin@domain
 *   npm run external:keys -- revoke --clientId ext_ck_... --by admin@domain
 *   npm run external:keys -- webhook-register --key <clientId> \
 *       --url https://hooks.consumer.example/tickets [--events a,b,c] --by admin@domain
 *   npm run external:keys -- webhook-list --key <clientId>
 *   npm run external:keys -- webhook-remove --id <webhookId> --by admin@domain --yes
 *
 * The raw secret is printed exactly ONCE on create. Only its SHA-256 hash is
 * stored; re-running create is the only way to get a usable secret again.
 */
import 'dotenv/config';
import { prisma } from '../src/config/database';
import { env } from '../src/config/env';
import { createKey, revokeKey, listKeys, EXTERNAL_SCOPES, EXTERNAL_STORES } from '../src/modules/external-api/external-keys';
import { createWebhook, listWebhooks, removeWebhook, EXTERNAL_WEBHOOK_EVENTS } from '../src/modules/external-api/external-webhooks';

const [command] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};

async function resolveActor(email: string): Promise<{ userId: string; customerId: string }> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, customerId: true, role: true, name: true } });
  if (!user) throw new Error(`no platform account for '${email}'`);
  if (user.role !== 'ADMINISTRATOR') throw new Error(`${email} is not an ADMINISTRATOR — only platform staff may issue API keys`);
  return { userId: user.id, customerId: user.customerId };
}

async function main(): Promise<void> {
  if (command === 'list') {
    const keys = await listKeys();
    console.log(`${keys.length} external API key(s):`);
    for (const k of keys) {
      console.log(`  ${k.enabled ? '●' : '○'} ${k.name}  ${k.clientId}  hint=${k.secretHint}  store=${k.ticketStore}  scopes=${k.scopes.join(',')}  webhooks=${k.webhookCount}${k.expiresAt ? `  exp=${k.expiresAt}` : ''}`);
    }
    return;
  }

  if (command === 'create') {
    const by = flag('by'); if (!by) throw new Error('--by <admin email> is required (the key is audited to this account)');
    const name = flag('name'); if (!name) throw new Error('--name is required');
    const scopes = (flag('scopes') ?? 'tickets.view,tickets.write').split(',').map((s) => s.trim()) as never[];
    const store = flag('store') ?? 'default';
    const customers = (flag('customers') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const actor = await resolveActor(by);
    const issued = await createKey({ name, scopes, ticketStore: store as 'default' | 'admin', customerIds: customers }, actor);
    console.log(`issued ${issued.clientId} for '${name}' (store=${store}, scopes=${issued.scopes.join(',')}, orgs=${issued.customerIds.length})`);
    console.log(`secret (shown ONCE — store it now):\n  ${issued.secret}`);
    console.log(`db: ${dbName(env.DATABASE_URL)}`);
    return;
  }

  if (command === 'revoke') {
    const clientId = flag('clientId'); if (!clientId) throw new Error('--clientId is required');
    const by = flag('by'); if (!by) throw new Error('--by <admin email> is required');
    if (!process.argv.includes('--yes')) throw new Error('add --yes to confirm revoking this key');
    await revokeKey(clientId, await resolveActor(by));
    console.log(`revoked ${clientId}`);
    return;
  }

  if (command === 'webhook-register') {
    const clientId = flag('key'); if (!clientId) throw new Error('--key <clientId> is required');
    const url = flag('url'); if (!url) throw new Error('--url <webhook url> is required');
    const by = flag('by'); if (!by) throw new Error('--by <admin email> is required');
    const raw = (flag('events') ?? EXTERNAL_WEBHOOK_EVENTS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
    for (const e of raw) if (!(EXTERNAL_WEBHOOK_EVENTS as readonly string[]).includes(e)) throw new Error(`unknown event '${e}' — use ${EXTERNAL_WEBHOOK_EVENTS.join(', ')}`);
    const key = await prisma.externalApiKey.findUnique({ where: { clientId }, select: { id: true } });
    if (!key) throw new Error(`no API key with clientId '${clientId}'`);
    const h = await createWebhook(key.id, { url, events: raw as never[] }, await resolveActor(by));
    console.log(`registered webhook ${h.id} for ${clientId}  events=${raw.join(',')}`);
    console.log(`secret (shown ONCE — sign every delivery with HMAC-SHA256):\n  ${h.secret}`);
    return;
  }

  if (command === 'webhook-list') {
    const clientId = flag('key');
    const key = clientId ? await prisma.externalApiKey.findUnique({ where: { clientId }, select: { id: true } }) : null;
    if (clientId && !key) throw new Error(`no API key with clientId '${clientId}'`);
    const hooks = await listWebhooks(key?.id);
    console.log(`${hooks.length} webhook(s):`);
    for (const h of hooks) {
      console.log(`  ${h.enabled ? '●' : '○'} ${h.id}  ${h.clientId}  ${h.url}  events=${h.events.join(',')}  hint=${h.secretHint}  failures=${h.failureCount}${h.lastDeliveryOk === null ? '' : h.lastDeliveryOk ? '  last=ok' : '  last=failed'}`);
    }
    return;
  }

  if (command === 'webhook-remove') {
    const id = flag('id'); if (!id) throw new Error('--id <webhookId> is required');
    const by = flag('by'); if (!by) throw new Error('--by <admin email> is required');
    if (!process.argv.includes('--yes')) throw new Error('add --yes to confirm removing this webhook');
    await removeWebhook(id, await resolveActor(by));
    console.log(`removed webhook ${id}`);
    return;
  }

  throw new Error(`unknown command '${command ?? ''}' — use list | create | revoke | webhook-register | webhook-list | webhook-remove`);
}

const dbName = (url?: string): string => url?.split('/').pop()?.split('?')[0] ?? '(unset)';

main().catch((err) => { console.error(`❌ ${err instanceof Error ? err.message : err}`); process.exit(1); });