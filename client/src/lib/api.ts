import axios, { AxiosError, AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';
// Same specifier style as ToastProvider's import so both resolve to ONE module instance
// (a mixed './toast-bus' vs '@/lib/toast-bus' can bundle as two, silently losing the handler).
import { notify } from '@/lib/toast-bus';
import { sessionEnded } from '@/lib/session-bus';

// In the BROWSER, always call the API same-origin via the relative `/api` path
// (the Next.js rewrites() in next.config.js proxies /api/* to NEXT_PUBLIC_API_URL).
// This keeps the httpOnly auth cookie FIRST-PARTY to the page origin, so it is
// visible to the Next.js auth middleware and sent on every request — regardless of
// whether the app is opened from localhost, a LAN IP, or a domain. Using the
// absolute NEXT_PUBLIC_API_URL instead scoped the cookie to the API host, so
// opening the app from any other host redirected every page back to /login.
// During SSR there is no page origin, so fall back to the absolute API origin.
const API_ORIGIN = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';
const BASE = typeof window === 'undefined' ? `${API_ORIGIN}/api` : '/api';

const api = axios.create({
  baseURL: BASE,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

// Per-request opt-out of the JSON default above, for FormData bodies.
const MULTIPART = { headers: { 'Content-Type': undefined } } as const;

let isRefreshing = false;
let refreshSubscribers: Array<(ok: boolean) => void> = [];

function onRefreshComplete(ok: boolean) {
  refreshSubscribers.forEach((cb) => cb(ok));
  refreshSubscribers = [];
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean; _skipRetry?: boolean };
    const status = error.response?.status;

    const isAuthEndpoint = original.url?.includes('/auth/');
    const currentPath = typeof window !== 'undefined' ? window.location.pathname : '';
    const isPublicPage = ['/login', '/register'].some((p) => currentPath.startsWith(p));

    // 401 — attempt token refresh, then redirect to login
    if (status === 401 && !original._retry && !original._skipRetry && !isAuthEndpoint && !isPublicPage) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          refreshSubscribers.push((ok) => {
            if (ok) resolve(api(original));
            else reject(error);
          });
        });
      }

      original._retry = true;
      isRefreshing = true;

      try {
        await api.post('/auth/refresh');
        onRefreshComplete(true);
        isRefreshing = false;
        return api(original);
      } catch {
        onRefreshComplete(false);
        isRefreshing = false;
        if (typeof window !== 'undefined' && !currentPath.startsWith('/login')) {
          // A revoked session (an administrator changed this account's platform
          // role, a password reset, a sign-in elsewhere) is not the same as an
          // idle timeout: bouncing straight to /login left the user staring at a
          // sign-in screen with no idea why. Explain it first and let THEM click
          // through; fall back to the silent redirect when no dialog is mounted.
          const revoked = (error.response?.data as { code?: string } | undefined)?.code === 'SESSION_REVOKED';
          if (!revoked || !sessionEnded()) window.location.href = '/login';
        }
        return Promise.reject(error);
      }
    }

    // 403 — redirect to access-denied page (skip on auth endpoints and silent checks)
    if (status === 403 && !original._skipRetry && !isAuthEndpoint && !currentPath.startsWith('/403')) {
      if (typeof window !== 'undefined') window.location.href = '/403';
      return Promise.reject(error);
    }

    // 429 — surface throttling explicitly. Without this the UI shows a component's
    // generic "could not save" message and the user has no idea they're rate limited.
    // Auth endpoints render the server message inline already, so skip those.
    if (status === 429 && !original._skipRetry && !isAuthEndpoint) {
      const msg = (error.response?.data as { error?: string } | undefined)?.error;
      notify(msg ? `${msg} — please wait a moment and try again.` : 'Too many requests — please wait a moment and try again.', 'error');
      return Promise.reject(error);
    }

    // 5xx — redirect to server error page (skip on silent checks)
    if (status !== undefined && status >= 500 && !original._skipRetry && !currentPath.startsWith('/server-error')) {
      if (typeof window !== 'undefined') window.location.href = '/server-error';
      return Promise.reject(error);
    }

    return Promise.reject(error);
  },
);

export default api;

// Typed API helpers
export const authApi = {
  register: (data: unknown) => api.post('/auth/register', data),
  registerUser: (data: unknown) => api.post('/auth/register-user', data),
  login: (data: unknown) => api.post('/auth/login', data),
  verifyMfa: (data: { challengeId: string; code: string; rememberDevice?: boolean }) => api.post('/auth/mfa/verify', data),
  resendMfa: (data: { challengeId: string }) => api.post('/auth/mfa/resend', data),
  verifyEmail: (data: { token: string }) => api.post('/auth/verify-email', data),
  resendVerification: (data: { email: string }) => api.post('/auth/resend-verification', data),
  // Organization approval. A successful verify sets session cookies — it IS a login.
  // The code itself never travels in either direction of these calls except as the
  // user's own typed input; the server only ever hands back a challenge id.
  verifyOrgApproval: (data: { challengeId: string; code: string }) => api.post('/auth/org-approval/verify', data),
  resendOrgApproval: (data: { challengeId: string }) => api.post('/auth/org-approval/resend', data),
  logout: () => api.post('/auth/logout'),
  forgotPassword: (data: { email: string }) => api.post('/auth/forgot-password', data),
  resetPassword: (data: { token: string; newPassword: string }) => api.post('/auth/reset-password', data),
};

export const usersApi = {
  getMe: () => api.get('/users/me'),
  updateMe: (data: unknown) => api.patch('/users/me', data),
  changePassword: (data: { currentPassword: string; newPassword: string }) => api.patch('/users/me/password', data),
  slackLink: () => api.post('/slack/link'),
  list: (params?: Record<string, unknown>) => api.get('/users', { params }),
  invite: (data: unknown) => api.post('/users/invite', data),
  changeRole: (id: string, data: unknown) => api.patch(`/users/${id}/role`, data),
  remove: (id: string) => api.delete(`/users/${id}`),
};

export const orgsApi = {
  getMe: () => api.get('/organizations/me'),
  updateMe: (data: unknown) => api.patch('/organizations/me', data),
  updateSecurity: (data: unknown) => api.patch('/organizations/me/security', data),
  getServices: () => api.get('/organizations/me/services'),
};


export const requestsApi = {
  create: (data: unknown) => api.post('/requests', data),
  list: (params?: Record<string, unknown>) => api.get('/requests', { params }),
  listOrg: (params?: Record<string, unknown>) => api.get('/requests/org', { params }),
  get: (id: string) => api.get(`/requests/${id}`),
  close: (id: string) => api.patch(`/requests/${id}/close`),
};

export const announcementsApi = {
  list: () => api.get('/announcements'),
};

// Slack bots — ADMINISTRATOR registry (manage bots, forms, org assignment, live status).
export const slackBotsApi = {
  list: () => api.get('/slack-bots'),
  get: (id: string) => api.get(`/slack-bots/${id}`),
  create: (data: unknown) => api.post('/slack-bots', data),
  update: (id: string, data: unknown) => api.patch(`/slack-bots/${id}`, data),
  remove: (id: string) => api.delete(`/slack-bots/${id}`),
  connect: (id: string) => api.post(`/slack-bots/${id}/connect`),
  disconnect: (id: string) => api.post(`/slack-bots/${id}/disconnect`),
  generateApiKey: (id: string) => api.post(`/slack-bots/${id}/api-key`),
  customers: () => api.get('/slack-bots/customers'),
  // form fields
  addField: (id: string, data: unknown) => api.post(`/slack-bots/${id}/fields`, data),
  updateField: (id: string, fieldId: string, data: unknown) => api.patch(`/slack-bots/${id}/fields/${fieldId}`, data),
  deleteField: (id: string, fieldId: string) => api.delete(`/slack-bots/${id}/fields/${fieldId}`),
  // org assignment
  assignOrg: (id: string, customerId: string) => api.post(`/slack-bots/${id}/orgs`, { customerId }),
  unassignOrg: (id: string, customerId: string) => api.delete(`/slack-bots/${id}/orgs/${customerId}`),
};

// Slack bots — ORG-facing (this org's assigned bots + create a bot-assigned ticket).
export const botsApi = {
  list: () => api.get('/bots'),
  createTicket: (id: string, data: unknown) => api.post(`/bots/${id}/tickets`, data),
};

// Secure AD credential deliveries — target user / requesting org-admin only.
export const adSecretsApi = {
  list: () => api.get('/ad-secrets'),
  reveal: (id: string) => api.post(`/ad-secrets/${id}/reveal`),
};

// Squid outbound proxies — ORG-facing (this org's proxies + their ACL config).
// All writes bump the bundle revision; a pull-based agent applies it on next poll.
export const squidApi = {
  list: (params?: Record<string, unknown>) => api.get('/squid', { params }),
  create: (data: { name: string; description?: string; transport?: string }) => api.post('/squid', data),
  get: (id: string) => api.get(`/squid/${id}`),
  update: (id: string, data: unknown) => api.patch(`/squid/${id}`, data),
  remove: (id: string) => api.delete(`/squid/${id}`),
  rotateKey: (id: string) => api.post(`/squid/${id}/rotate-key`),
  bundlePublicKey: () => api.get('/squid/bundle-key'),
  listBranches: (id: string) => api.get(`/squid/${id}/branches`),
  createBranch: (id: string, data: { name: string; description?: string; mode?: string }) => api.post(`/squid/${id}/branches`, data),
  updateBranch: (id: string, branchId: string, data: unknown) => api.patch(`/squid/${id}/branches/${branchId}`, data),
  deleteBranch: (id: string, branchId: string) => api.delete(`/squid/${id}/branches/${branchId}`),
  setBranchLists: (id: string, branchId: string, data: { sources: string[]; whitelist: { value: string; subdomain: boolean }[]; blacklist: { value: string; subdomain: boolean }[] }) =>
    api.put(`/squid/${id}/branches/${branchId}/lists`, data),
  setPorts: (id: string, data: { safePorts?: string[]; sslPorts?: string[]; fullAccess?: unknown[] }) => api.put(`/squid/${id}/ports`, data),
  setFullAccess: (id: string, data: unknown) => api.put(`/squid/${id}/full-access`, data),
  listChangeRequests: (id: string) => api.get(`/squid/${id}/change-requests`),
};

// Squid proxies — STAFF console (cross-tenant read/manage).
export const squidAdminApi = {
  list: (params?: Record<string, unknown>) => api.get('/saas-admin/squid', { params }),
  get: (id: string) => api.get(`/saas-admin/squid/${id}`),
  rotateKey: (id: string) => api.post(`/saas-admin/squid/${id}/rotate-key`),
  lock: (id: string) => api.post(`/saas-admin/squid/${id}/lock`),
  enable: (id: string) => api.post(`/saas-admin/squid/${id}/enable`),
};

// External ticketing API — ADMINISTRATOR registry: machine keys + delivery webhooks.
// Key secrets and webhook secrets come back EXACTLY ONCE on creation (no read path).
export const externalApiKeysApi = {
  list: () => api.get('/external-admin'),
  create: (data: {
    name: string;
    scopes: string[];
    ticketStore: 'default' | 'admin';
    customerIds: string[];
    expiresAt?: string | null;
  }) => api.post('/external-admin', data),
  revoke: (clientId: string) => api.post(`/external-admin/${clientId}/revoke`),
  listWebhooks: (clientId: string) => api.get(`/external-admin/${clientId}/webhooks`),
  createWebhook: (clientId: string, data: { url: string; events: string[] }) =>
    api.post(`/external-admin/${clientId}/webhooks`, data),
  removeWebhook: (id: string) => api.delete(`/external-admin/webhooks/${id}`),
};

// In-app Ticketing Tool — proxied through our server to the external ticketing
// system (fallback data served until the external API is configured).
// Durable notifications with server-side read state — unlike the ticketing
// `*Alerts` feeds below, which recompute from a localStorage watermark and forget
// anything they have already shown.
export const notificationsApi = {
  list: (params?: { limit?: number; before?: string }) => api.get('/notifications', { params }),
  markRead: (id: string) => api.post(`/notifications/${id}/read`),
  markAllRead: () => api.post('/notifications/read-all'),
};

export const ticketingApi = {
  listTickets: (params?: Record<string, unknown>) => api.get('/ticketing/tickets', { params }),
  getTicket: (id: string) => api.get(`/ticketing/tickets/${id}`),
  createTicket: (data: unknown) => api.post('/ticketing/tickets', data),
  updateTicket: (id: string, data: unknown) => api.patch(`/ticketing/tickets/${id}`, data),
  escalate: (id: string) => api.post(`/ticketing/tickets/${id}/escalate`),
  claim: (id: string) => api.post(`/ticketing/admin/tickets/${id}/claim`),
  myUpdates: (since: string) => api.get('/ticketing/my-updates', { params: { since } }),
  adminEscalationAlerts: (since: string) => api.get('/ticketing/admin/escalation-alerts', { params: { since } }),
  getStats: () => api.get('/ticketing/stats'),
  getAnalytics: () => api.get('/ticketing/analytics'),
  listProjects: () => api.get('/ticketing/projects'),
  listAssignees: () => api.get('/ticketing/assignees'),
  // Mention candidates for the @ picker — platform users only (both stores).
  listMentionCandidates: () => api.get('/ticketing/mention-candidates'),
  listCustomers: () => api.get('/ticketing/customers'), // ADMINISTRATOR only (403 otherwise)
  createProject: (data: unknown) => api.post('/ticketing/projects', data),
  updateProject: (id: string, data: unknown) => api.patch(`/ticketing/projects/${id}`, data),
  // `confirm` must be the project's exact name — the server rejects a mismatch with
  // 400 CONFIRM_MISMATCH. Deleting a project takes every ticket under it with it.
  deleteProject: (id: string, confirm: string) =>
    api.delete(`/ticketing/projects/${id}`, { params: { confirm } }),
  listSlas: () => api.get('/ticketing/slas'),
  createSla: (data: unknown) => api.post('/ticketing/slas', data),
  updateSla: (id: string, data: unknown) => api.patch(`/ticketing/slas/${id}`, data),
  deleteSla: (id: string) => api.delete(`/ticketing/slas/${id}`),
  getReport: (params: Record<string, unknown>) => api.get('/ticketing/reports', { params }),
  getAlerts: (since: string) => api.get('/ticketing/alerts', { params: { since } }),
  // Collaboration
  getComments: (id: string) => api.get(`/ticketing/tickets/${id}/comments`),
  // Content-Type MUST be undefined on FormData posts: the instance default above is
  // application/json, and axios then JSON-stringifies the FormData (File → {}), so the
  // request is never multipart and the server sees zero files. Undefined lets the
  // browser set multipart/form-data with its own boundary.
  addComment: (id: string, form: FormData) => api.post(`/ticketing/tickets/${id}/comments`, form, MULTIPART),
  getActivity: (id: string) => api.get(`/ticketing/tickets/${id}/activity`),
  // Cross-ticket activity feed (Activity Log tab). Scoped server-side to the caller's
  // own ticket store and organization.
  listActivityLog: (params?: Record<string, unknown>) => api.get('/ticketing/activity', { params }),
  getTicketAttachments: (id: string) => api.get(`/ticketing/tickets/${id}/attachments`),
  uploadAttachments: (id: string, form: FormData) => api.post(`/ticketing/tickets/${id}/attachments`, form, MULTIPART),
  downloadAttachment: (id: string) => api.get(`/ticketing/attachments/${id}/download`, { responseType: 'blob' }),
  // Same-origin URL for rendering an attachment inline (<img src>): the httpOnly auth
  // cookie rides along, so no blob/objectURL dance is needed.
  attachmentUrl: (id: string) => `${BASE}/ticketing/attachments/${id}/download?inline=1`,
  getWatchers: (id: string) => api.get(`/ticketing/tickets/${id}/watchers`),
  watch: (id: string) => api.post(`/ticketing/tickets/${id}/watch`),
  unwatch: (id: string) => api.delete(`/ticketing/tickets/${id}/watch`),
};

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamOptions {
  sessionId?: string;
  onToken: (token: string) => void;
  onSession?: (sessionId: string) => void;
  onDone?: () => void;
  onError?: (msg: string) => void;
  /** Abort the in-flight reply (the "Stop" button). An abort ends the stream
   *  quietly — onDone, never onError: the user asked for it, it is not a fault. */
  signal?: AbortSignal;
}

export const chatApi = {
  stream: async (
    message: string,
    history: ChatTurn[] = [],
    opts: StreamOptions,
  ): Promise<void> => {
    const { sessionId, onToken, onSession, onDone, onError, signal } = opts;
    let response: Response;
    try {
      // NOTE: BASE already includes the `/api` prefix (browser: '/api'), so the
      // path here is `/chat` — NOT `/api/chat`, which would resolve to a doubled
      // `/api/api/chat` (404). In the browser this hits the same-origin Route
      // Handler at app/api/chat/route.ts, which pipes the backend SSE through
      // without the buffering the next.config rewrite proxy imposes on streams.
      response = await fetch(`${BASE}/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history, ...(sessionId ? { sessionId } : {}) }),
        ...(signal ? { signal } : {}),
      });
    } catch {
      if (signal?.aborted) { onDone?.(); return; }
      onError?.('The assistant is unavailable. Please try again.');
      onDone?.();
      return;
    }

    if (!response.ok || !response.body) {
      onError?.(`Request failed (${response.status})`);
      onDone?.();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line.startsWith('data:')) continue;

          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;

          if (dataStr === '[DONE]') {
            onDone?.();
            return;
          }

          try {
            const event = JSON.parse(dataStr) as { token?: string; error?: string; sessionId?: string };
            if (event.error) {
              onError?.(event.error);
              return;
            }
            if (event.sessionId) onSession?.(event.sessionId);
            if (event.token) onToken(event.token);
          } catch {
            /* ignore keep-alives / non-JSON frames */
          }
        }
      }
    } catch {
      // A mid-stream abort surfaces here as a read error; anything else genuinely
      // broke the connection and still deserves the generic message.
      if (!signal?.aborted) onError?.('The assistant is unavailable. Please try again.');
    } finally {
      reader.releaseLock();
    }

    onDone?.();
  },
  listSessions: () => api.get('/chat/sessions'),
  getSession: (id: string) => api.get(`/chat/sessions/${id}`),
  deleteSession: (id: string) => api.delete(`/chat/sessions/${id}`),
};

export const saasAdminApi = {
  listOrgs: (params?: Record<string, unknown>) => api.get('/saas-admin/orgs', { params }),
  updateOrg: (id: string, data: unknown) => api.patch(`/saas-admin/orgs/${id}`, data),
  // Irreversible. `confirm` must be the org's exact name (the server re-checks it).
  // The two ticket stores are ALWAYS retained — tickets are compliance records.
  deleteOrg: (id: string, data: { confirm: string }) => api.delete(`/saas-admin/orgs/${id}`, { data }),
  listPendingOrgs: () => api.get('/saas-admin/orgs/pending'),
  reissueOrgApproval: (id: string) => api.post(`/saas-admin/orgs/${id}/reissue-approval`),
  impersonate: (userId: string) => api.post(`/saas-admin/impersonate/${userId}`),
  // Step 2: exchange the grant for a session as the target. Sets session cookies,
  // so the browser IS the target user afterwards — reload, don't keep local state.
  redeemImpersonation: (token: string) => api.post('/saas-admin/impersonate', { token }),
  getMetrics: () => api.get('/saas-admin/metrics'),
  getTopClients: (limit?: number) => api.get('/saas-admin/top-clients', { params: limit ? { limit } : undefined }),
  getSlaBreaches: () => api.get('/saas-admin/sla-breaches'),
  listEscalations: (params?: Record<string, unknown>) => api.get('/saas-admin/escalations', { params }),
  updateEscalation: (id: string, data: unknown) => api.patch(`/saas-admin/escalations/${id}`, data),
  getChatAnalytics: () => api.get('/saas-admin/chat-analytics'),
  listAnnouncements: () => api.get('/saas-admin/announcements'),
  createAnnouncement: (data: unknown) => api.post('/saas-admin/announcements', data),
  updateAnnouncement: (id: string, data: unknown) => api.patch(`/saas-admin/announcements/${id}`, data),
  deleteAnnouncement: (id: string) => api.delete(`/saas-admin/announcements/${id}`),
  getOrgsOverview: () => api.get('/saas-admin/orgs/overview'),
  listAdmins: () => api.get('/saas-admin/admins'),
  listAllUsers: () => api.get('/saas-admin/all-users'),
  getOrgDetail: (id: string) => api.get(`/saas-admin/orgs/${id}/detail`),
  updateUser: (id: string, data: unknown) => api.patch(`/saas-admin/users/${id}`, data),
  removeUser: (id: string) => api.delete(`/saas-admin/users/${id}`),
  resetUserPassword: (id: string) => api.post(`/saas-admin/users/${id}/reset-password`),
  getTicketNumberFormat: () => api.get('/saas-admin/ticket-number-format'),
  updateTicketNumberFormat: (data: unknown) => api.put('/saas-admin/ticket-number-format', data),
  listRequests: (params?: Record<string, unknown>) => api.get('/saas-admin/requests', { params }),
  updateRequest: (id: string, data: unknown) => api.patch(`/saas-admin/requests/${id}`, data),
  listServices: (params?: Record<string, unknown>) => api.get('/saas-admin/services', { params }),
  updateService: (id: string, data: unknown) => api.patch(`/saas-admin/services/${id}`, data),
  renewService: (id: string, data?: unknown) => api.post(`/saas-admin/services/${id}/renew`, data ?? { months: 12 }),
  assignService: (customerId: string, data: unknown) => api.post(`/saas-admin/customers/${customerId}/services`, data),
  removeService: (id: string) => api.delete(`/saas-admin/services/${id}`),
  listFlags: () => api.get('/saas-admin/flags'),
  toggleFlag: (key: string, data: unknown) => api.patch(`/saas-admin/flags/${key}`, data),
  // Service catalog (platform master list)
  listCatalog: () => api.get('/saas-admin/catalog'),
  createCatalogItem: (data: unknown) => api.post('/saas-admin/catalog', data),
  updateCatalogItem: (id: string, data: unknown) => api.patch(`/saas-admin/catalog/${id}`, data),
  deleteCatalogItem: (id: string) => api.delete(`/saas-admin/catalog/${id}`),
  // Administrator-only: activity feed + Sadmin management
  getSadminActivity: (limit?: number) => api.get('/saas-admin/activity', { params: limit ? { limit } : undefined }),
  getSystemActivity: (params?: Record<string, unknown>) => api.get('/saas-admin/system-activity', { params }),
  getLoginsByOrg: (params?: Record<string, unknown>) => api.get('/saas-admin/logins-by-org', { params }),
  listSadmins: () => api.get('/saas-admin/sadmins'),
  updateSadmin: (id: string, data: unknown) => api.patch(`/saas-admin/sadmins/${id}`, data),
  removeSadmin: (id: string) => api.delete(`/saas-admin/sadmins/${id}`),
  resetSadminPassword: (id: string) => api.post(`/saas-admin/sadmins/${id}/reset-password`),

  // Platform roles (IAM). inviteStaff is the only path that mints a
  // non-Administration staff account.
  inviteStaff: (data: { email: string; name: string; platformRoleId: string }) => api.post('/saas-admin/staff', data),
  listPlatformRoles: () => api.get('/saas-admin/roles'),
  permissionCatalog: () => api.get('/saas-admin/roles/catalog'),
  createPlatformRole: (data: unknown) => api.post('/saas-admin/roles', data),
  updatePlatformRole: (id: string, data: unknown) => api.patch(`/saas-admin/roles/${id}`, data),
  deletePlatformRole: (id: string) => api.delete(`/saas-admin/roles/${id}`),
};

// Ops dashboard. One aggregate over the whole ticket estate; the server scopes it
// by role (ADMINISTRATOR → admin store, ORG_ADMIN → their own), so the session
// cookie riding along as on every other call is the whole authorization story.
export const dashboardApi = {
  overview: (users = false) => api.get('/ticketing/dashboard', { params: users ? { users: true } : undefined }),
};

// Analytics Agent, signed /v1 surface (server-side credential; ORG_ADMIN+ only).
// `_skipRetry` keeps the 5xx interceptor from bouncing the whole dashboard to
// /server-error when the agent box is down or its TLS cert is unreachable — the
// section renders its own inline "unavailable" line instead.
export const agentApi = {
  topComplaints: () => api.get('/agent/top-complaints', { _skipRetry: true } as AxiosRequestConfig),
};
