// Date-range helpers shared by the Gate Passes list, Reports, and the page
// queries in queries.js. All range math is LOCAL time, so the buckets match
// the dates the tables display (UTC boundaries would put the first local hours
// of a day in the previous day for IST users).

export function pad2(n) {
  return String(n).padStart(2, '0');
}

// "YYYY-MM-DD" for a date input, in local time
export const toDateInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export function firstOfMonth() {
  const d = new Date();
  return toDateInput(new Date(d.getFullYear(), d.getMonth(), 1));
}

// From/To are inclusive calendar days; either side may be left empty for an
// open-ended range. Returns Date bounds, `end` exclusive.
export function rangeToBounds(fromDate, toDate) {
  const parse = (s) => {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const start = parse(fromDate);
  const endDay = parse(toDate);
  const end = endDay ? new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1) : null;
  return { start, end };
}

// A bound for the server (ISO instant), or null when open-ended / incomplete
export const isoOrNull = d => (d && !isNaN(d.getTime()) ? d.toISOString() : null);
