// In production, VITE_API_URL is the backend origin (e.g. the Railway URL) —
// baked in at build time. When unset (local dev), the relative /api path is
// proxied to localhost:4000 by Vite (see vite.config.js).
const API_ORIGIN = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const BASE = `${API_ORIGIN}/api`;
const TOKEN_KEY = 'token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => { if (t) localStorage.setItem(TOKEN_KEY, t); };
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

function getHeaders() {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...getHeaders(), ...options.headers },
  });

  // An expired/invalid token on any authenticated call forces a clean re-login.
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    clearToken();
    if (window.location.pathname !== '/login') window.location.assign('/login');
  }

  let data = {};
  try { data = await res.json(); } catch { /* non-JSON / empty body */ }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export const api = {
  // Auth
  login: (email, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => request('/auth/me'),

  // Gate passes
  getPasses: (filters = {}) => {
    const q = new URLSearchParams(filters).toString();
    return request(`/gate-passes${q ? '?' + q : ''}`);
  },
  getPass: (id) => request(`/gate-passes/${id}`),
  createPass: (data) => request('/gate-passes', { method: 'POST', body: JSON.stringify(data) }),
  // Direct inward entry logged by Security at the gate (no approval flow)
  createInward: (data) => request('/gate-passes/inward', { method: 'POST', body: JSON.stringify(data) }),
  approvePass: (id, action) => request(`/gate-passes/${id}/status`, { method: 'PATCH', body: JSON.stringify({ action }) }),
  // Manager/admin edit of a still-pending pass (before approval)
  revisePass: (id, data) => request(`/gate-passes/${id}/revise`, { method: 'PATCH', body: JSON.stringify(data) }),
  logOutward: (id, payload) => request(`/gate-passes/${id}/log-outward`, { method: 'PATCH', body: JSON.stringify(payload) }),
  logInward: (id, payload) => request(`/gate-passes/${id}/log-inward`, { method: 'PATCH', body: JSON.stringify(payload) }),
  // Destination branch marks an internal transfer's items in (with dept + receiver)
  receivePass: (id, payload) => request(`/gate-passes/${id}/receive`, { method: 'PATCH', body: JSON.stringify(payload) }),
  // Receiver approves the items going back to the source branch
  requestReturn: (id, payload = {}) => request(`/gate-passes/${id}/return-request`, { method: 'PATCH', body: JSON.stringify(payload) }),
  // Destination branch gate marks the approved return physically out
  returnOutward: (id, payload) => request(`/gate-passes/${id}/return-outward`, { method: 'PATCH', body: JSON.stringify(payload) }),
  getStats: () => request('/gate-passes/meta/stats'),

  // Admin edit (used by Reports)
  updatePass: (id, patch) => request(`/gate-passes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // Branches
  getBranches: (all = false) => request(`/branches${all ? '?all=true' : ''}`),
  createBranch: (data) => request('/branches', { method: 'POST', body: JSON.stringify(data) }),
  updateBranch: (id, data) => request(`/branches/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteBranch: (id) => request(`/branches/${id}`, { method: 'DELETE' }),

  // Departments
  getDepartments: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/departments${q ? '?' + q : ''}`);
  },
  createDepartment: (data) => request('/departments', { method: 'POST', body: JSON.stringify(data) }),
  updateDepartment: (id, data) => request(`/departments/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDepartment: (id) => request(`/departments/${id}`, { method: 'DELETE' }),

  // Users
  getUsers: () => request('/users'),
  createUser: (data) => request('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id, data) => request(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),

  // Meta
  getMeta: () => Promise.all([
    request('/meta/roles'),
    request('/meta/units'),
    request('/meta/categories'),
  ]).then(([roles, units, categories]) => ({ roles, units, categories })),

  // Audit log
  getAuditLog: () => request('/audit'),
};

