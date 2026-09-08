import { z } from 'zod';

// Mirrors the server's password policy (12+ chars, mixed case, number, symbol).
const PasswordSchema = z
  .string()
  .min(12)
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/,
    'Password must contain uppercase, lowercase, number, and special character',
  );

export const RegisterSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: PasswordSchema,
  organizationName: z.string().min(2).max(100),
  contactNumber: z.string().min(7, 'Contact number is required').max(20),
});

// Joining an existing organization — the org is resolved from the work-email
// domain server-side, so no organization name is collected here.
export const RegisterUserSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: PasswordSchema,
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ─── 3-tier RBAC: USER → ORG_ADMIN → ADMINISTRATOR ──────────────────────────
export type Role = 'USER' | 'ORG_ADMIN' | 'ADMINISTRATOR';
export type Plan = 'FREE' | 'PRO' | 'ENTERPRISE';
export type ServiceStatus = 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'SUSPENDED';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  mfaEnabled: boolean;
  customerId: string;
  lastLoginAt: string | null;
  createdAt: string;
  emailVerifiedAt: string | null;
  /** Vendor-staff role. Null for customer accounts (USER / ORG_ADMIN). */
  platformRole: { key: string; name: string } | null;
  /**
   * The org's MFA enforcement, carried with the user's own flag so callers can
   * compute EFFECTIVE MFA (see mfaStatus in lib/display). Login has always used
   * `mfaEnabled || customer.mfaRequired`; the UI now agrees.
   */
  customer?: { mfaRequired: boolean } | null;
  /**
   * Platform permission keys, expanded server-side (Administration arrives as
   * the full list). Empty for customer accounts.
   *
   * These drive what the UI OFFERS, never what it permits — every route is
   * independently enforced on the server. Hiding a control here is a courtesy,
   * not a boundary.
   */
  permissions: string[];
}

export interface Customer {
  id: string;
  name: string;
  slug: string;
  plan: Plan;
  suspended: boolean;
  ssoEnabled: boolean;
  mfaRequired: boolean;
  creditLimit: number;
  mailId: string;
  contactPerson: string;
  contactNumber: string;
  domain: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationService {
  id: string;
  name: string;
  description: string | null;
  status: ServiceStatus;
  enabled: boolean;
  monthlyPrice: number;
  purchasedAt: string;
  renewsAt: string;
  lastBilledAt: string | null;
}

// ─── Support tickets (user-initiated service requests) ──────────────────────
export type RequestType = 'SUPPORT' | 'INCIDENT' | 'FEATURE_REQUEST' | 'ONBOARDING' | 'BILLING';
export type RequestStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' | 'ESCALATED';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ServiceRequest {
  id: string;
  customerId: string;
  createdById: string | null;
  type: RequestType;
  status: RequestStatus;
  priority: Priority;
  subject: string;
  description: string | null;
  service: string | null;
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

// Org-admin view: a ticket plus the user who raised it.
export interface OrgServiceRequest extends ServiceRequest {
  createdBy: { id: string; name: string; email: string } | null;
}

// ─── Chat history (persisted assistant conversations) ───────────────────────
export interface ChatSessionSummary {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatSessionMessage {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  createdAt: string;
}

export interface ChatSessionDetail {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ChatSessionMessage[];
}

// ─── Platform announcements (ADMINISTRATOR broadcasts) ──────────────────────
export type AnnouncementLevel = 'INFO' | 'WARNING' | 'CRITICAL';

export interface Announcement {
  id: string;
  title: string;
  message: string;
  level: AnnouncementLevel;
  createdAt: string;
  // Admin-management fields (absent on the org-facing feed)
  customerId?: string | null;
  active?: boolean;
  expiresAt?: string | null;
  customer?: { id: string; name: string } | null;
}

// ─── SLA breach monitor (ADMINISTRATOR) ──────────────────────────────────────
export interface SlaTicket {
  id: string;
  subject: string;
  type: RequestType;
  status: RequestStatus;
  priority: Priority;
  service: string | null;
  assignedTo: string | null;
  createdAt: string;
  slaHours: number;
  slaDeadline: string;
  overdueMs: number;
  customer: { id: string; name: string; plan: Plan };
  createdBy: { id: string; name: string; email: string } | null;
}

export interface SlaBreachReport {
  breached: SlaTicket[];
  approaching: SlaTicket[];
  counts: Record<string, number>;
  totalOpen: number;
}

// ─── In-app Ticketing Tool (rebuilt on the full b2b_ticket platform schema) ──
export type TicketStatus = 'todo' | 'in_progress' | 'client_pending' | 'completed';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TicketType = 'bug' | 'feature' | 'task' | 'story';
export type SlaStatus = 'none' | 'paused' | 'breached' | 'critical' | 'warning' | 'normal';

export interface PersonRef { id: string; name: string; email: string | null }

// One SLA clock (resolution or response). `budgetSeconds` is the policy target; when the
// clock is stopped (completed) `remainingSeconds`/`deadline` are null.
export interface SlaEvaluation {
  status: SlaStatus;
  budgetSeconds: number | null;
  remainingSeconds: number | null;
  deadline: string | null;
}

export interface TicketDTO {
  id: string;
  ticketNumber: string;
  title: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType;
  projectId: string;
  projectName: string | null;
  reporter: PersonRef | null;
  assignee: PersonRef | null;
  customer: { id: string; name: string; email: string | null; contactPerson: string | null } | null;
  storyPoints: number | null;
  dueDate: string | null;
  labels: string[];
  branch: string | null;
  onSiteSupportRequired: boolean;
  reasonForDelay: string | null;
  resolvedMethods: string | null;
  sla: { id: string; name: string; responseTime: number; resolutionTime: number; timeUnit: string } | null;
  slaStatus: SlaStatus;
  slaRemainingSeconds: number | null;
  slaDeadline: string | null;
  responseSla: SlaEvaluation;
  resolutionSla: SlaEvaluation;
  pausedTime: string | null;
  totalPausedTime: number;
  counts: { comments: number; attachments: number; watchers: number };
  createdAt: string;
  updatedAt: string;
}

export interface TicketAttachment {
  id: string;
  originalName: string | null;
  mimeType: string | null;
  size: number | null;
  kind: 'ticket' | 'comment';
  uploadedBy: PersonRef | null;
  createdAt: string;
}

export interface TicketComment {
  id: string;
  content: string;
  author: PersonRef | null;
  attachments: TicketAttachment[];
  createdAt: string;
}

// Notification feed item: an update on a ticket the user reported.
export interface TicketUpdateAlert {
  id: string;
  ticketId: string;
  ticketNumber: string;
  title: string;
  type: string;
  description: string | null;
  createdAt: string;
}

// A durable notification. Unlike TicketUpdateAlert above (recomputed per poll from
// a localStorage watermark), this row persists server-side and carries real read
// state — `readAt` is authoritative and survives a reload.
export interface NotificationDTO {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  actorId: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface TicketActivity {
  id: string;
  type: string;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  description: string | null;
  user: PersonRef | null;
  createdAt: string;
}

// One row of the cross-ticket Activity Log — a TicketActivity plus the ticket it
// belongs to, which the per-ticket feed doesn't need to say.
export interface TicketActivityLogRow extends TicketActivity {
  ticket: { id: string; ticketNumber: string; title: string } | null;
}

export interface TicketProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  category: string;
  type: string;
  priority: 'low' | 'medium' | 'high';
  leadId: string;
  lead: PersonRef | null;
  settings: unknown;
  memberCount: number;
  ticketCount: number;
  createdAt: string;
}

export interface TicketSla {
  id: string;
  name: string;
  description: string | null;
  priority: TicketPriority | null;
  responseTime: number;
  resolutionTime: number;
  timeUnit: 'minutes' | 'hours' | 'days';
  workingDays: number[];
  businessHours: unknown;
  isActive: boolean;
  createdAt: string;
}

export interface TicketStats {
  tickets: {
    total: number; completed: number; inProgress: number; todo: number; clientPending: number;
    highPriority: number; today: number; open: number; completionRate: number;
  };
}

export interface TicketAnalytics {
  issueDistribution: Array<{ issue: string; count: number }>;
  daily: Array<{ date: string; created: number }>;
  byPriority: Array<{ priority: string; count: number }>;
  analyzed: number;
}

// ─── Ticket report ───────────────────────────────────────────────────────────
// Per-ticket rows, grouped. Replaced an aggregate that returned only group counts —
// the Reports tab now picks which ticket columns to show and export, which needs the
// tickets themselves. Mirrors ReportTicketRow / TicketReportResult on the server.
export type TicketReportType = 'client' | 'assignee' | 'overall' | 'sla_breach';

export interface ReportTicketRow {
  id: string;
  ticketNumber: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  projectName: string | null;
  customerId: string | null;
  customerName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  reporterName: string | null;
  reporterEmail: string | null;
  branch: string | null;
  onSiteSupportRequired: boolean;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  dueDate: string | null;
  pausedTime: string | null;
  totalPausedTime: number;
  slaName: string | null;
  slaResolutionSeconds: number | null;
}

export interface TicketReport {
  type: TicketReportType;
  from: string | null;
  to: string | null;
  customerId: string | null;
  assigneeId: string | null;
  groups: Array<{ key: string; label: string; tickets: ReportTicketRow[] }>;
  totals: { tickets: number; open: number; completed: number; breached: number };
  /** True when the row cap was hit — the report covers only part of the range. */
  truncated: boolean;
}

// ─── Slack bots ──────────────────────────────────────────────────────────────
export type BotFieldType = 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'SELECT' | 'CHECKBOX' | 'USER_EMAIL';
export type SlackBotStatus = 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

export interface SlackBotField {
  id: string;
  key: string;
  label: string;
  type: BotFieldType;
  required: boolean;
  options: string[] | null;
  placeholder: string | null;
  helpText: string | null;
  order: number;
}

// Admin registry view — tokens are never returned (only a masked hint + whether set).
export interface SlackBot {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: SlackBotStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  teamName: string | null;
  botUserId: string | null;
  enabled: boolean;
  botTokenHint: string;
  appTokenSet: boolean;
  webhookSet: boolean;
  apiKeySet: boolean;
  apiKeyHint: string | null;
  fieldCount: number;
  orgCount: number;
  createdAt: string;
  // present on the single-bot fetch
  formFields?: SlackBotField[];
  orgIds?: string[];
}

// A delivered temporary AD credential — status/flags only, never the secret.
export interface AdCredentialDelivery {
  id: string;
  ticketNumber: string;
  targetEmail: string;
  status: 'PENDING' | 'DELIVERED' | 'VIEWED' | 'EXPIRED';
  role: 'target' | 'requester' | 'both';
  canReveal: boolean;
  alreadyViewed: boolean;
  expiresAt: string;
  deliveredAt: string;
}

// Org-facing view — what an org-admin needs to assign a bot to a ticket.
export interface OrgBot {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: SlackBotStatus;
  ticketUserId: string | null;
  formFields: SlackBotField[];
}

// ─── Chat analytics (ADMINISTRATOR) ──────────────────────────────────────────
export interface ChatAnalytics {
  totalSessions: number;
  totalMessages: number;
  activeChatUsers: number;
  perOrg: Array<{ customerId: string; name: string; sessions: number; messages: number }>;
  daily: Array<{ date: string; messages: number }>;
}

// ─── Ops dashboard (ORG_ADMIN / ADMINISTRATOR) ───────────────────────────────
// Mirrors `DashboardOverview` in the server's ticketing/services/dashboardAggregate.
// Every panel of the ops dashboard arrives in this one payload; the server does all
// the grouping, so these are plain interfaces rather than zod schemas — nothing on
// the client re-derives them.

export interface DashIssueSlice { label: string; count: number; pct: number }

export interface DashAssignee {
  id: string;
  name: string;
  closed: number;
  open: number;
  closureRate: number;
  /** Open tickets untouched for 72h+ — the queue that went quiet, not merely long. */
  stuck: number;
  slowestTitle: string | null;
  slowestHours: number;
}

export interface DashUser {
  id: string;
  name: string;
  email: string | null;
  open: number;
  total: number;
  completed: number;
  highPriority: number;
  avgOpenAgeHours: number;
  lastActivityAt: string | null;
}

export interface DashOverview {
  generatedAt: string;
  analyzed: number;
  ticketStats: {
    total: number; completed: number; inProgress: number; todo: number;
    clientPending: number; highPriority: number; today: number; open: number;
    completionRate: number;
  };
  projectStats: { total: number; completed: number; active: number; atRisk: number; onTrack: number };
  issueDistribution: {
    top: DashIssueSlice[];
    other: DashIssueSlice;
    total: number;
    top3Pct: number;
    weekDeltaPct: number;
  };
  kpi: {
    ticketsToday: number;
    openTickets: number;
    slaBreachPct: number;
    createdSpark: number[];
    openSpark: number[];
    breachSpark: number[];
    alert: string | null;
  };
  recent: Array<{
    id: string; ticketNumber: string; title: string;
    status: string; priority: string; createdAt: string;
  }>;
  daily: {
    points: Array<{ date: string; created: number; topIssue: string | null }>;
    peakDate: string | null;
    peakCreated: number;
    average: number;
  };
  branches: {
    rows: Array<{ branch: string; count: number; pct: number }>;
    average: number;
    topVsAverage: number | null;
  };
  assignees: DashAssignee[];
  clients: Array<{ id: string; name: string; open: number; total: number; demand: 'high' | 'medium' | 'low' }>;
  users: DashUser[];
}
