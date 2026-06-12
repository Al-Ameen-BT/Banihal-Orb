// Shared DTO shapes for the in-app Ticketing Tool. These are OUR contract with
// the client UI — the external ticketing API is mapped onto these shapes inside
// ticketing.client.ts, so swapping fallback → real API never touches the UI.

export type TicketStatus = 'TODO' | 'IN_PROGRESS' | 'COMPLETED';
export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Ticket {
  id: string;
  subject: string;
  description: string;
  issueType: string;
  status: TicketStatus;
  priority: TicketPriority;
  projectId: string | null;
  assignee: string | null;
  raisedBy: { name: string; email: string } | null;
  createdAt: string;   // ISO
  updatedAt: string;   // ISO
  completedAt: string | null;
  // True when an ORG_ADMIN has forwarded this ticket to the platform
  // Administrators (annotated from our TicketEscalation table).
  escalated?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  category: string;
  priority: TicketPriority;
  assignees: string[];
  createdAt: string;
}

export interface TicketFilters {
  status?: TicketStatus;
  projectId?: string;
  mine?: string;        // raisedBy email — "my tickets" view
  since?: string;       // createdAt > since (alert polling)
  search?: string;
}

export interface CreateTicketInput {
  subject: string;
  description: string;
  issueType: string;
  priority: TicketPriority;
  projectId?: string | null;
  raisedBy: { name: string; email: string };
}

export interface UpdateTicketInput {
  status?: TicketStatus;
  priority?: TicketPriority;
  assignee?: string | null;
  projectId?: string | null;
}

export interface CreateProjectInput {
  name: string;
  description: string;
  category: string;
  priority: TicketPriority;
  assignees: string[];
}
