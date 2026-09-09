// UI-facing DTOs for the rebuilt Ticketing module (full b2b_ticket schema).
// These are OUR contract with the client; the Prisma rows are mapped onto them in
// ticketing.client.ts so the verbose introspected relation names never leak out.

import type { SlaStatus, SlaEvaluation } from './services/slaService';

export type TicketStatus = 'todo' | 'in_progress' | 'client_pending' | 'completed';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TicketType = 'bug' | 'feature' | 'task' | 'story';
export type ProjectPriority = 'low' | 'medium' | 'high';

export interface PersonRef { id: string; name: string; email: string | null }

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
  resolvedAt: string | null;
  sla: { id: string; name: string; responseTime: number; resolutionTime: number; timeUnit: string } | null;
  slaStatus: SlaStatus;
  slaRemainingSeconds: number | null;
  slaDeadline: string | null;
  // Dual SLA (report §7.4): resolution mirrors the flat slaStatus fields above; response is
  // an approximation (elapsed-vs-responseTime — no first-response timestamp exists).
  responseSla: SlaEvaluation;
  resolutionSla: SlaEvaluation;
  pausedTime: string | null;
  totalPausedTime: number;
  counts: { comments: number; attachments: number; watchers: number };
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDTO {
  id: string;
  name: string;
  description: string | null;
  status: string;
  category: string;
  type: string;
  priority: ProjectPriority;
  leadId: string;
  lead: PersonRef | null;
  settings: unknown;
  memberCount: number;
  ticketCount: number;
  createdAt: string;
}

export interface SlaDTO {
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

export interface AttachmentDTO {
  id: string;
  originalName: string | null;
  mimeType: string | null;
  size: number | null;
  kind: 'ticket' | 'comment';
  uploadedBy: PersonRef | null;
  createdAt: string;
}

export interface CommentDTO {
  id: string;
  content: string;
  author: PersonRef | null;
  attachments: AttachmentDTO[];
  createdAt: string;
}

export interface ActivityDTO {
  id: string;
  type: string;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  description: string | null;
  user: PersonRef | null;
  createdAt: string;
}

export interface TicketFilters {
  status?: TicketStatus;
  priority?: TicketPriority;
  type?: TicketType;
  projectId?: string;
  assigneeId?: string;
  mineUserId?: string; // reporter OR assignee = this ticketing user id
  reporterOrAssigneeIn?: string[]; // tenant scope: reporter OR assignee ∈ these ids
  since?: string;
  search?: string;
  escalatedOnly?: boolean; // admin "Escalated" category → labels has 'escalated'
}
