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

    // Don't retry: auth endpoints, already-retried requests, or silent-check requests
    const isAuthEndpoint = original.url?.includes('/auth/');
    const isPublicPage = typeof window !== 'undefined' &&
      ['/login', '/register'].some((p) => window.location.pathname.startsWith(p));

    if (error.response?.status === 401 && !original._retry && !original._skipRetry && !isAuthEndpoint && !isPublicPage) {
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
        // Only redirect if not already on /login
        if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
          window.location.href = '/login';
        }
        return Promise.reject(error);
      }
    }

    return Promise.reject(error);
  },
);

export default api;

// Typed API helpers
export const authApi = {
  register: (data: unknown) => api.post('/auth/register', data),
  login: (data: unknown) => api.post('/auth/login', data),
  logout: () => api.post('/auth/logout'),
};

export const usersApi = {
  getMe: () => api.get('/users/me'),
  updateMe: (data: unknown) => api.patch('/users/me', data),
  list: (params?: Record<string, unknown>) => api.get('/users', { params }),
  invite: (data: unknown) => api.post('/users/invite', data),
  changeRole: (id: string, data: unknown) => api.patch(`/users/${id}/role`, data),
  remove: (id: string) => api.delete(`/users/${id}`),
};

export const orgsApi = {
  getMe: () => api.get('/organizations/me'),
  updateMe: (data: unknown) => api.patch('/organizations/me', data),
  updateSecurity: (data: unknown) => api.patch('/organizations/me/security', data),
  getUsage: () => api.get('/organizations/me/usage'),
  getServices: () => api.get('/organizations/me/services'),
};

export const dashboardApi = {
  getKpis: () => api.get('/dashboard/kpis'),
  getQueue: (params?: Record<string, unknown>) => api.get('/dashboard/queue', { params }),
};

export const saasAdminApi = {
  listOrgs: (params?: Record<string, unknown>) => api.get('/saas-admin/orgs', { params }),
  updateOrg: (id: string, data: unknown) => api.patch(`/saas-admin/orgs/${id}`, data),
  impersonate: (userId: string) => api.post(`/saas-admin/impersonate/${userId}`),
  getMetrics: () => api.get('/saas-admin/metrics'),
  getTopClients: (limit?: number) => api.get('/saas-admin/top-clients', { params: limit ? { limit } : undefined }),
  getOrgsOverview: () => api.get('/saas-admin/orgs/overview'),
  listAdmins: () => api.get('/saas-admin/admins'),
  getOrgDetail: (id: string) => api.get(`/saas-admin/orgs/${id}/detail`),
  updateUser: (id: string, data: unknown) => api.patch(`/saas-admin/users/${id}`, data),
  removeUser: (id: string) => api.delete(`/saas-admin/users/${id}`),
  resetUserPassword: (id: string) => api.post(`/saas-admin/users/${id}/reset-password`),
  listRequests: (params?: Record<string, unknown>) => api.get('/saas-admin/requests', { params }),
  updateRequest: (id: string, data: unknown) => api.patch(`/saas-admin/requests/${id}`, data),
  listServices: (params?: Record<string, unknown>) => api.get('/saas-admin/services', { params }),
  updateService: (id: string, data: unknown) => api.patch(`/saas-admin/services/${id}`, data),
  renewService: (id: string, data?: unknown) => api.post(`/saas-admin/services/${id}/renew`, data ?? { months: 12 }),
  listFlags: () => api.get('/saas-admin/flags'),
  toggleFlag: (key: string, data: unknown) => api.patch(`/saas-admin/flags/${key}`, data),
};
