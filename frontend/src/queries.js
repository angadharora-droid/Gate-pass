// ─── PAGE QUERIES ─────────────────────────────────────────────────────────────
// One definition per piece of page data, used by the page itself AND by the
// background prefetch (prefetch.js). The cache only helps when both ask with
// exactly the same key, so neither builds its own.
import { api } from './utils/api';
import { REFERENCE_STALE_MS } from './queryClient';
import { firstOfMonth, toDateInput, rangeToBounds, isoOrNull } from './utils/dateRange';

// ── Badges & dashboard ───────────────────────────────────────────────────────
export const statsQuery = () => ({ queryKey: ['stats'], queryFn: api.getStats });
export const recentPassesQuery = () => ({ queryKey: ['passes', 'recent'], queryFn: () => api.getPasses({ limit: 6 }) });
export const openPassesQuery = () => ({ queryKey: ['passes', 'open'], queryFn: () => api.getPasses({ open: true }) });

// ── Gate Passes list (infinite scroll) ───────────────────────────────────────
// Passes fetched per page, newest first; scrolling down fetches the next page.
export const PASS_PAGE_SIZE = 100;
export const passListFilters = ({ status = null, movement = null, overdue = false, q = '', fromDate = '', toDate = '' } = {}) => {
  const { start, end } = rangeToBounds(fromDate, toDate);
  return {
    status, movement, overdue: overdue ? 'true' : null, q,
    from: isoOrNull(start), to: isoOrNull(end), limit: PASS_PAGE_SIZE,
  };
};
export const passListQuery = (filters) => ({
  queryKey: ['passes', 'list', filters],
  queryFn: ({ pageParam }) => api.getPasses({ ...filters, before: pageParam }),
  initialPageParam: null,
  // (a backend from before paging existed answers with the whole list)
  getNextPageParam: last => (Array.isArray(last) ? undefined : (last.next ?? undefined)),
});

// ── Time Office registers ────────────────────────────────────────────────────
// Every OPEN pass plus finished ones with gate activity in the last N days
// (null = all time). The window is computed when fetched, so it rolls forward.
export const DEFAULT_REGISTER_DAYS = 7;
export const registerQuery = (periodDays) => ({
  queryKey: ['passes', 'register', periodDays],
  queryFn: () => api.getPasses(periodDays
    ? { activeFrom: new Date(Date.now() - periodDays * 864e5).toISOString(), includeOpen: 'true' }
    : {}),
});

// ── Reports overview (passes created in a date range) ────────────────────────
export const defaultReportRange = () => ({ fromDate: firstOfMonth(), toDate: toDateInput(new Date()) });
export const reportsOverviewQuery = (fromDate, toDate) => ({
  queryKey: ['passes', 'created', fromDate, toDate],
  queryFn: () => {
    const { start, end } = rangeToBounds(fromDate, toDate);
    return api.getPasses({ from: isoOrNull(start), to: isoOrNull(end) });
  },
});

// ── Reference lists (rarely change) ──────────────────────────────────────────
export const branchesQuery = (all = false) => ({
  queryKey: ['branches', all ? 'all' : 'active'], queryFn: () => api.getBranches(all), staleTime: REFERENCE_STALE_MS,
});
export const departmentsQuery = (branch = '') => ({
  queryKey: ['departments', branch || 'any'],
  queryFn: () => api.getDepartments(branch ? { branch } : {}),
  staleTime: REFERENCE_STALE_MS,
});
export const usersQuery = () => ({ queryKey: ['users'], queryFn: () => api.getUsers(), staleTime: REFERENCE_STALE_MS });
export const approversQuery = () => ({ queryKey: ['approvers'], queryFn: api.getApprovers, staleTime: REFERENCE_STALE_MS });
