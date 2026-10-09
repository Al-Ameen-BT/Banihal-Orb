import { z } from 'zod';
import { refineBotChange } from '../squid/squid.schema';

// ─── Host-worker request schemas (ADR-002 reverse control plane) ────────────
// A worker on client infrastructure calls /api/bot-worker/:botId/* and
// authenticates with its `wrk_` key on every call (Bearer + request HMAC). The
// bot's Slack tokens only leave the platform over `provision`, once.

export const ProvisionSchema = z.object({
  // Opaque worker self-identity (uuid). Binding it to the bot row is what lets
  // a duplicate instance be told to die and a retried provision (lost response)
  // be recognized as the SAME worker rather than a second one.
  instanceId: z.string().min(8).max(128).optional(),
});

export const HEARTBEAT_STATUSES = ['CONNECTED', 'DISCONNECTED', 'ERROR', 'INACTIVE'] as const;

export const HeartbeatSchema = z.object({
  // Host-side view of the worker process holding the Slack connection.
  status: z.enum(HEARTBEAT_STATUSES),
  // True while the Socket Mode WebSocket is actually open (host-discovered).
  socketConnected: z.boolean().optional(),
  // Monotonic-ish counters for the dashboard, ms-epoch of the last Slack event
  // and total messages bridged since the worker started.
  lastEventAt: z.number().int().nonnegative().optional(),
  msgCount: z.number().int().nonnegative().optional(),
  instanceId: z.string().min(8).max(128),
  version: z.string().max(64).optional(),
  lastError: z.string().max(1000).optional(),
});

// One Slack event the worker would otherwise handle itself. The platform is the
// authority for identity linking, assistant chat and approval decisions; the
// worker posts the reply back (it is the only holder of the live Slack tokens).
export const MessageSchema = z.object({
  type: z.enum(['message', 'block_actions']),
  user: z.string().min(1).max(64),
  channel: z.string().min(1).max(128),
  text: z.string().max(4000).optional(),
  // block_actions: the approval-card payload (action_id + ticket id value).
  actions: z
    .array(z.object({ action_id: z.string().min(1), value: z.string().optional(), type: z.string() }))
    .optional(),
  // Where the worker will POST the replacement card after a block_actions resolve.
  response_url: z.string().url().optional(),
  message_ts: z.string().max(64).optional(),
});

export type ProvisionInput = z.infer<typeof ProvisionSchema>;
export type HeartbeatInput = z.infer<typeof HeartbeatSchema>;
export type MessageInput = z.infer<typeof MessageSchema>;

// ─── Squid host bot dialect (workerMode = SQUID_BOT) ─────────────────────────
// request / state / command-result — plan v2 §5.1–5.3. The bot holds its own
// Slack tokens; these three routes are its whole control channel. Validation of
// the change itself is the SHARED refineBotChange (same rules as the web door,
// D2), so Slack and web requests can never diverge.

export const BOT_COMMAND_TYPES = ['allow', 'deny', 'extend', 'full-net', 'lock-net'] as const;

export const RequestSchema = z.object({
  instanceId: z.string().min(8).max(128).optional(),
  type: z.enum(BOT_COMMAND_TYPES),
  payload: z.object({
    ip: z.string().trim().min(1).max(64),
    // The bot's `<domain|destination_ip>` — classified, not double-validated.
    domain: z.string().trim().min(1).max(255).optional(),
    hours: z.number().finite().positive().max(876_000).optional(),
  }),
  requester: z.object({
    slackUserId: z.string().min(1).max(64),
    slackUserName: z.string().max(120).optional(),
    channelId: z.string().max(128).optional(),
  }),
}).superRefine((v, ctx) =>
  refineBotChange(
    { action: v.type, ip: v.payload.ip, domain: v.payload.domain, hours: v.payload.hours },
    ctx,
    ['payload'],
  ),
);

/** One rule as the /state snapshot/delta carries it (epoch seconds, null = indefinite). */
const StateRuleSchema = z.object({
  ip: z.string().trim().min(1).max(64),
  domain: z.string().trim().min(1).max(255),
  isDestIp: z.boolean().optional(),
  expires: z.number().int().nonnegative().nullable().optional(),
  app: z.string().max(64).nullable().optional(),
});

export const StateSchema = z.object({
  instanceId: z.string().min(8).max(128),
  version: z.string().max(64).optional(),
  status: z.enum(['CONNECTED', 'DISCONNECTED', 'ERROR']),
  socketConnected: z.boolean().optional(),
  lastEventAt: z.number().int().nonnegative().optional(),
  msgCount: z.number().int().nonnegative().optional(),
  squid: z.object({
    active: z.boolean(),
    parseOk: z.boolean().optional(),
    lastReloadAt: z.number().int().nonnegative().optional(),
  }).optional(),
  counts: z.object({ domains: z.number().int().nonnegative() }).optional(),
  discovery: z.object({
    domain: z.string().max(255),
    deps: z.array(z.string().max(255)).max(2000).optional(),
    at: z.number().int().nonnegative().optional(),
  }).nullable().optional(),
  // Full snapshot (replaces everything for this bot) — optional; deltas below
  // are the incremental path.
  rules: z.array(StateRuleSchema).max(20_000).optional(),
  // Incremental changes since the last poll, incl. host-side expiry removals.
  rulesDelta: z.array(StateRuleSchema.extend({ op: z.enum(['up', 'down']) })).max(1000).optional(),
  lastError: z.string().max(1000).optional(),
  // Optional piggybacked ack (the bot may confirm the last command here instead
  // of a separate /command-result round trip).
  requestContext: z.object({ commandIdAcked: z.string().max(64).nullable().optional() }).optional(),
});

export const CommandResultSchema = z.object({
  commandId: z.string().min(1).max(64),
  instanceId: z.string().min(8).max(128).optional(),
  ok: z.boolean(),
  detail: z.string().max(2000).optional(),
  at: z.number().int().nonnegative().optional(),
});

export type RequestInput = z.infer<typeof RequestSchema>;
export type StateInput = z.infer<typeof StateSchema>;
export type CommandResultInput = z.infer<typeof CommandResultSchema>;