import { z } from 'zod';
import { BRANCH_NAME_RE } from './aclEngine';

// ─── Org-facing squid proxy management (tenant-scoped) ──────────────────────
const TimeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

export const SiteEntrySchema = z.object({
  value: z.string().trim().min(1).max(255),
  subdomain: z.boolean().default(false),
});

export const AccessWindowSchema = z.object({
  days: z.array(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])).min(1).max(7),
  from: z.string().regex(TimeRe, 'from must be HH:MM (24h)'),
  to: z.string().regex(TimeRe, 'to must be HH:MM (24h)'),
}).refine((w) => w.from < w.to, { message: 'from must be before to', path: ['to'] });

export const FullAccessSchema = z.object({
  src: z.string().trim().min(1).max(64),
  description: z.string().trim().max(200).optional(),
  until: z.string().datetime({ offset: true }).optional(), // ISO — temporary access expires
  window: AccessWindowSchema.optional(),
});

export const CreateProxySchema = z.object({
  name: z.string().regex(BRANCH_NAME_RE, 'Names: 2-32 chars, letters/digits/_/- only'),
  description: z.string().trim().max(500).optional(),
  transport: z.enum(['agent']).default('agent'),
});

export const UpdateProxySchema = z.object({
  name: z.string().regex(BRANCH_NAME_RE, 'Names: 2-32 chars, letters/digits/_/- only').optional(),
  description: z.string().trim().max(500).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

export const ListProxiesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const CreateBranchSchema = z.object({
  name: z.string().regex(BRANCH_NAME_RE, 'Names: 2-32 chars, letters/digits/_/- only'),
  description: z.string().trim().max(500).optional(),
  mode: z.enum(['ADDITIVE', 'EXCLUSIVE']).default('ADDITIVE'),
  bypassApproval: z.boolean().default(false).optional(),
});

export const UpdateBranchSchema = z.object({
  name: z.string().regex(BRANCH_NAME_RE, 'Names: 2-32 chars, letters/digits/_/- only').optional(),
  description: z.string().trim().max(500).nullable().optional(),
  mode: z.enum(['ADDITIVE', 'EXCLUSIVE']).optional(),
  bypassApproval: z.boolean().default(false).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'At least one field required' });

// The traffic-heavy edits. Distinct endpoints so the client posts one concern at
// a time (and each bumps seq exactly once, giving auditors a precise diff).
export const SetBranchListsSchema = z.object({
  sources: z.array(z.string().trim().min(1).max(64)).max(100).default([]),
  whitelist: z.array(SiteEntrySchema).max(2000).default([]),
  blacklist: z.array(SiteEntrySchema).max(2000).default([]),
  bypassApproval: z.boolean().default(false).optional(),
});

export const SetPortsSchema = z.object({
  safePorts: z.array(z.string().trim().min(1).max(16)).max(64).default([]),
  sslPorts: z.array(z.string().trim().min(1).max(16)).max(64).default([]),
  bypassApproval: z.boolean().default(false).optional(),
});

export const SetFullAccessSchema = z.object({
  fullAccess: z.array(FullAccessSchema).max(500).default([]),
  bypassApproval: z.boolean().default(false).optional(),
});

export const VerifyTokenSchema = z.object({
  token: z.string().trim().min(1).max(300),
});

export const AgentResultSchema = z.object({
  seq: z.coerce.number().int().min(0),
  ok: z.boolean(),
  error: z.string().trim().max(500).optional(),
});

// ─── Agent telemetry push ────────────────────────────────────────────────────
export const TelemetryLogLineSchema = z.object({
  ts: z.coerce.number().int().min(0).optional(), // epoch seconds — the log event time
  ip: z.string().trim().max(64).default(''),
  method: z.string().trim().max(16).default(''),
  action: z.enum(['allowed', 'denied']).default('allowed'),
  url: z.string().trim().max(2048).default(''),
});

export const ConfSnapshotSchema = z.object({
  hash: z.string().trim().min(1).max(128),
  capturedAt: z.coerce.number().int().min(0),
  files: z.array(z.object({
    path: z.string().trim().min(1).max(500),
    content: z.string().max(200_000),
  })).max(64),
});

export const TelemetryIngestSchema = z.object({
  seq: z.coerce.number().int().min(0),
  observedAt: z.coerce.number().int().min(0).optional(), // epoch ms; server clock when omitted
  squidVersion: z.string().trim().max(80).optional(),
  uptimeSeconds: z.coerce.number().int().min(0).optional(),
  cpuPercent: z.coerce.number().min(0).max(100).optional(),
  memPercent: z.coerce.number().min(0).max(100).optional(),
  diskPercent: z.coerce.number().min(0).max(100).optional(),
  sessions: z.array(z.string().trim().min(1).max(64)).max(5000).default([]),
  // Slack bot companion service state on the squid host (systemd status). Loose
  // shape so the agent can report whatever the host exposes.
  slackBot: z.object({
    table: z.string().trim().max(80).optional().default('slack-squid-proxy'),
    state: z.enum(['active', 'inactive', 'failed', 'unknown']).default('unknown'),
    lastError: z.string().trim().max(200).optional(),
  }).optional(),
  counters: z.object({
    requests: z.coerce.number().int().min(0).default(0),
    denied: z.coerce.number().int().min(0).default(0),
    bytes: z.coerce.number().int().min(0).default(0),
    clients: z.coerce.number().int().min(0).default(0),
  }).default({}),
  logLines: z.array(TelemetryLogLineSchema).max(500).default([]),
  confHash: z.string().trim().max(128).optional(),
  confSnapshot: ConfSnapshotSchema.optional(),
});

export const ActivityQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  clientIp: z.string().trim().max(64).optional(),
  denied: z.string().optional().refine((v) => v === undefined || v === '' || v === 'true' || v === 'false', { message: 'denied must be true|false' }),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  before: z.coerce.number().int().min(0).optional(), // epoch ms cursor
});

export const ReportQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(7).default(7),
});

export const DependencyScanSchema = z.object({
  url: z.string().url().max(500),
  branchId: z.string().trim().optional(),
});

export type CreateProxyInput = z.infer<typeof CreateProxySchema>;
export type UpdateProxyInput = z.infer<typeof UpdateProxySchema>;
export type ListProxiesInput = z.infer<typeof ListProxiesSchema>;
export type CreateBranchInput = z.infer<typeof CreateBranchSchema>;
export type UpdateBranchInput = z.infer<typeof UpdateBranchSchema>;
export type SetBranchListsInput = z.infer<typeof SetBranchListsSchema>;
export type SetPortsInput = z.infer<typeof SetPortsSchema>;
export type SetFullAccessInput = z.infer<typeof SetFullAccessSchema>;
export type VerifyTokenInput = z.infer<typeof VerifyTokenSchema>;
export type AgentResultInput = z.infer<typeof AgentResultSchema>;
export type TelemetryIngestInput = z.infer<typeof TelemetryIngestSchema>;
export type ActivityQueryInput = z.infer<typeof ActivityQuerySchema>;
export type ReportQueryInput = z.infer<typeof ReportQuerySchema>;
export type DependencyScanInput = z.infer<typeof DependencyScanSchema>;

// ─── New schemas for missing features ─────────────────────────────────────────
export const ReloadProxySchema = z.object({}).strict();
export type ReloadProxyInput = z.infer<typeof ReloadProxySchema>;

export const RestartProxySchema = z.object({}).strict();
export type RestartProxyInput = z.infer<typeof RestartProxySchema>;

export const RescanProxySchema = z.object({}).strict();
export type RescanProxyInput = z.infer<typeof RescanProxySchema>;

export const BandwidthQuerySchema = z.object({
  minutes: z.coerce.number().int().min(1).max(1440).default(60),
}).strict();
export type BandwidthQueryInput = z.infer<typeof BandwidthQuerySchema>;

export const CertificateStatusSchema = z.object({}).strict();
export type CertificateStatusInput = z.infer<typeof CertificateStatusSchema>;

export const GenerateCaSchema = z.object({
  san: z.array(z.string().trim().max(255)).max(50).default([]),
  validityYears: z.coerce.number().int().min(1).max(10).default(2),
}).strict();
export type GenerateCaInput = z.infer<typeof GenerateCaSchema>;

export const ImportCertificateSchema = z.object({
  cert: z.string().min(1),
  key: z.string().min(1),
  keyPassphrase: z.string().max(500).optional(),
  chain: z.string().optional(),
}).strict();
export type ImportCertificateInput = z.infer<typeof ImportCertificateSchema>;

export const GenerateCsrSchema = z.object({
  commonName: z.string().trim().min(1).max(255),
  organization: z.string().trim().max(255).optional(),
  locality: z.string().trim().max(255).optional(),
  state: z.string().trim().max(255).optional(),
  country: z.string().trim().length(2).optional(),
  san: z.array(z.string().trim().max(255)).max(50).default([]),
}).strict();
export type GenerateCsrInput = z.infer<typeof GenerateCsrSchema>;

export const CreateBackupSchema = z.object({
  description: z.string().trim().max(500).optional(),
  emailResults: z.boolean().default(false),
}).strict();
export type CreateBackupInput = z.infer<typeof CreateBackupSchema>;

export const RestoreBackupSchema = z.object({
  backupId: z.string().trim().min(1),
  validateOnly: z.boolean().default(false),
}).strict();
export type RestoreBackupInput = z.infer<typeof RestoreBackupSchema>;

export const FactoryResetSchema = z.object({}).strict();
export type FactoryResetInput = z.infer<typeof FactoryResetSchema>;

export const PackageStatusSchema = z.object({}).strict();
export type PackageStatusInput = z.infer<typeof PackageStatusSchema>;