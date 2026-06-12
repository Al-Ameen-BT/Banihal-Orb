import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

const BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

const api = axios.create({
  baseURL: `${BASE}/api`,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

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
          window.location.href = '/login';
        }
        return Promise.reject(error);
      }
    }

    // 403 — redirect to access-denied page (skip on auth endpoints and silent checks)
    if (status === 403 && !original._skipRetry && !isAuthEndpoint && !currentPath.startsWith('/403')) {
      if (typeof window !== 'undefined') window.location.href = '/403';
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
  logout: () => api.post('/auth/logout'),
};

export const usersApi = {
  getMe: () => api.get('/users/me'),
  updateMe: (data: unknown) => api.patch('/users/me', data),
  changePassword: (data: { currentPassword: string; newPassword: string }) => api.patch('/users/me/password', data),
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

export const dashboardApi = {
  getKpis: () => api.get('/dashboard/kpis'),
  getQueue: (params?: Record<string, unknown>) => api.get('/dashboard/queue', { params }),
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

// In-app Ticketing Tool — proxied through our server to the external ticketing
// system (fallback data served until the external API is configured).
export const ticketingApi = {
  listTickets: (params?: Record<string, unknown>) => api.get('/ticketing/tickets', { params }),
  createTicket: (data: unknown) => api.post('/ticketing/tickets', data),
  updateTicket: (id: string, data: unknown) => api.patch(`/ticketing/tickets/${id}`, data),
  escalateTicket: (id: string, data?: unknown) => api.post(`/ticketing/tickets/${id}/escalate`, data ?? {}),
  getStats: () => api.get('/ticketing/stats'),
  getAnalytics: () => api.get('/ticketing/analytics'),
  listProjects: () => api.get('/ticketing/projects'),
  createProject: (data: unknown) => api.post('/ticketing/projects', data),
  deleteProject: (id: string) => api.delete(`/ticketing/projects/${id}`),
  getReport: (params: Record<string, unknown>) => api.get('/ticketing/reports', { params }),
  getAlerts: (since: string) => api.get('/ticketing/alerts', { params: { since } }),
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
}

export const chatApi = {
  stream: async (
    message: string,
    history: ChatTurn[] = [],
    opts: StreamOptions,
  ): Promise<void> => {
    const { sessionId, onToken, onSession, onDone, onError } = opts;
    let response: Response;
    try {
      response = await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history, ...(sessionId ? { sessionId } : {}) }),
      });
    } catch {
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
  impersonate: (userId: string) => api.post(`/saas-admin/impersonate/${userId}`),
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
  listSadmins: () => api.get('/saas-admin/sadmins'),
  updateSadmin: (id: string, data: unknown) => api.patch(`/saas-admin/sadmins/${id}`, data),
  removeSadmin: (id: string) => api.delete(`/saas-admin/sadmins/${id}`),
  resetSadminPassword: (id: string) => api.post(`/saas-admin/sadmins/${id}/reset-password`),
};
