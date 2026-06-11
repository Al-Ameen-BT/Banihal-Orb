import { z } from 'zod';

export const RegisterSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z
    .string()
    .min(12)
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/,
      'Password must contain uppercase, lowercase, number, and special character',
    ),
  organizationName: z.string().min(2).max(100),
  contactNumber: z.string().min(7, 'Contact number is required').max(20),
});

// Joining an existing organization — the org is resolved from the work-email
// domain server-side, so no organization name is collected here.
export const RegisterUserSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z
    .string()
    .min(12)
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/,
      'Password must contain uppercase, lowercase, number, and special character',
    ),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const UpdateMeSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  mfaEnabled: z.boolean().optional(),
});

export const InviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(80),
  role: z.enum(['USER', 'ORG_ADMIN']),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type RegisterUserInput = z.infer<typeof RegisterUserSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type UpdateMeInput = z.infer<typeof UpdateMeSchema>;
export type InviteUserInput = z.infer<typeof InviteUserSchema>;

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

// ─── Chat analytics (ADMINISTRATOR) ──────────────────────────────────────────
export interface ChatAnalytics {
  totalSessions: number;
  totalMessages: number;
  activeChatUsers: number;
  perOrg: Array<{ customerId: string; name: string; sessions: number; messages: number }>;
  daily: Array<{ date: string; messages: number }>;
}
