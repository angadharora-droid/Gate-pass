// ─── BACKGROUND PREFETCH ──────────────────────────────────────────────────────
// Once the page you opened has finished loading, quietly load the data of the
// other main pages your role can open, so opening them later is instant (they
// still refresh in the background — see queryClient.js). Only what each role
// uses: every user downloads this whether they visit the page or not.
// Reports, the heaviest, loads only when the pointer heads for its link.
import { queryClient } from './queryClient';
import { hasRole } from './utils/roles';
import {
  statsQuery, recentPassesQuery, openPassesQuery, passListQuery, passListFilters,
  registerQuery, DEFAULT_REGISTER_DAYS, reportsOverviewQuery, defaultReportRange,
  branchesQuery, departmentsQuery, usersQuery, approversQuery,
} from './queries';

// Prefetching skips data loaded within the last minute, so hovering along the
// sidebar doesn't re-download pages. (Opening a page still refreshes it on its
// own schedule — this only warms the cache.)
const WARM_MS = 60_000;
const warm = (q) => queryClient.prefetchQuery({ ...q, staleTime: Math.max(q.staleTime ?? 0, WARM_MS) });

// Each nav destination → what its page shows first
function pageLoaders(user) {
  const canCreate = hasRole(user, 'admin', 'supermanager', 'manager', 'staff');
  const isGate = hasRole(user, 'admin', 'time_office');
  const isStaff = !hasRole(user, 'manager', 'supermanager', 'admin');
  return {
    '/': () => [statsQuery(), recentPassesQuery(), openPassesQuery()].forEach(warm),
    '/passes': () => queryClient.prefetchInfiniteQuery({
      ...passListQuery(passListFilters()), pages: 1, staleTime: WARM_MS,
    }),
    '/time-office': () => isGate && warm(registerQuery(DEFAULT_REGISTER_DAYS)),
    '/passes/new': () => {
      if (!canCreate) return;
      warm(branchesQuery());
      if (isStaff) warm(approversQuery());
    },
    '/inward/new': () => isGate && [branchesQuery(), departmentsQuery(), usersQuery()].forEach(warm),
    '/reports': () => {
      const { fromDate, toDate } = defaultReportRange();
      warm(reportsOverviewQuery(fromDate, toDate));
      warm(branchesQuery(true));
    },
  };
}

// Pages loaded in the background after the first page — everything but Reports
const IDLE_PAGES = ['/', '/passes', '/time-office', '/passes/new', '/inward/new'];

// Runs `fn` once nothing is loading and the browser is idle, so the page the
// user is looking at always loads first. Returns a cancel function.
function whenIdle(fn) {
  let timer = null;
  let cancelled = false;
  const check = () => {
    if (cancelled) return;
    if (queryClient.isFetching() > 0) { timer = setTimeout(check, 300); return; }
    if (window.requestIdleCallback) window.requestIdleCallback(() => !cancelled && fn(), { timeout: 2000 });
    else fn();
  };
  timer = setTimeout(check, 500);
  return () => { cancelled = true; clearTimeout(timer); };
}

// After sign-in / first load: the main pages, in the background
export function prefetchMainPages(user) {
  return whenIdle(() => {
    const loaders = pageLoaders(user);
    for (const path of IDLE_PAGES) loaders[path]();
  });
}

// Pointer or keyboard focus on a nav link: that page's data, now
export function prefetchPage(path, user) {
  pageLoaders(user)[path]?.();
}
