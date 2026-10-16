// ─── PAGE DATA CACHE (TanStack Query) ─────────────────────────────────────────
// Pages used to fetch on open and forget on leave, so every visit — including
// going BACK — started blank behind a spinner. Now each page's data is kept:
// a revisit shows it at once and refreshes it quietly in the background.
//   staleTime — data this fresh is shown without asking the server again
//   gcTime    — how long a page's data is kept after leaving it
// Any change made through the API marks everything stale (see api.js), so
// your own actions always show up; other people's arrive on the background
// refresh, and when you switch back to the browser tab.
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 30 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

// Short reference lists (branches, departments, approvers) rarely change
export const REFERENCE_STALE_MS = 5 * 60_000;

// A pass already loaded by any list on screen — Gate Passes, Time Office,
// Dashboard, Reports — so its detail page can show it instantly while the
// full fetch runs. List responses are arrays, { passes }, or infinite pages.
export function findCachedPass(id) {
  for (const [, data] of queryClient.getQueriesData({ queryKey: ['passes'] })) {
    const lists = data?.pages ? data.pages : [data];
    for (const list of lists) {
      const rows = Array.isArray(list) ? list : list?.passes;
      const hit = rows?.find?.(p => p.id === id);
      if (hit) return hit;
    }
  }
  return undefined;
}
