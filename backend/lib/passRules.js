import { hasRole, rolesOf } from './roles.js';

// ─── PASS RULES SHARED BY ROUTES AND SCRIPTS ─────────────────────────────────
// Who may see a pass, who may approve its send-back, and the dashboard counts
// built on them. Kept free of database/Express imports so scripts can load it.

// Statuses where something can still happen to a pass (approval, gate log,
// return). Every actionable count and queue only ever looks at these.
export const OPEN_STATUSES = ['pending', 'approved', 'in_transit', 'partial_return'];

// ─── VISIBILITY ───────────────────────────────────────────────────────────────
// Visibility follows INVOLVEMENT, not just the branch:
//   draft        → only its own creator (and admin) — it isn't real yet
//   admin        → everything
//   time_office  → every pass crossing THEIR gate (source or destination = their
//                  branch) — the gate must log all of it
//   staff        → only passes they created, and transfer items in their custody
//   manager      → their own department's passes, anything routed to / decided
//                  by them, the branch's unrouted pending pool, and internal
//                  transfers arriving at their branch
//   supermanager → anything routed to / decided by them, the unrouted pending
//                  pool, and internal transfers arriving at their branch
// A user holding several roles sees the union of those views.
//
// The rule exists twice: canSeePass checks one pass already in hand, and
// scopeFilter is the same rule as a MongoDB query, so lists and counts are
// filtered by the database instead of loading every pass. The two MUST stay
// in step — scripts/check-scope.mjs compares them for every user on real data,
// and the smoke test compares them for every role through the API.
export function canSeePass(p, user) {
  if (hasRole(user, 'admin')) return true;
  const roles = rolesOf(user);

  // A draft isn't real yet — only its creator can see it. This must come
  // first: it overrides every other rule below (branch gate, department
  // traffic, approval pools), none of which should apply to something
  // nobody has decided to submit.
  if (p.status === 'draft') return p.createdBy === user.id;

  // Gate view: everything physically crossing my branch's gate
  if (roles.includes('time_office') && user.branch &&
      (p.sourceBranch === user.branch || p.destinationBranch === user.branch)) return true;

  // Personal involvement — applies to every role
  if (p.createdBy === user.id) return true;
  if (p.approverId === user.id || p.approvedBy === user.id) return true;
  if (p.receivedLog?.receiverId === user.id) return true;
  if (p.returnRequest?.requestedBy === user.id) return true;
  if (p.sendBackRequest?.requestedBy === user.id) return true;

  const isApproverRole = roles.includes('manager') || roles.includes('supermanager');
  if (isApproverRole && user.branch) {
    // The branch's unrouted pending passes are the shared approval pool
    // (legacy passes and routed passes whose approver has left)
    if (p.status === 'pending' && !p.approverId && p.sourceBranch === user.branch) return true;
    // Incoming transfers land at my branch — receipts and send-back
    // approvals are this branch's approvers' responsibility
    if (p.direction === 'internal' && p.destinationBranch === user.branch) return true;
  }
  if (roles.includes('manager')) {
    // My department's traffic is my responsibility
    if (p.departmentId && p.departmentId === user.departmentId && p.sourceBranch === user.branch) return true;
    if (p.receivedLog?.departmentId && p.receivedLog.departmentId === user.departmentId) return true;
  }
  return false;
}

// canSeePass as a MongoDB filter, clause for clause.
export function scopeFilter(user) {
  if (hasRole(user, 'admin')) return {};
  const roles = rolesOf(user);

  const involved = [
    { createdBy: user.id },
    { approverId: user.id },
    { approvedBy: user.id },
    { 'receivedLog.receiverId': user.id },
    { 'returnRequest.requestedBy': user.id },
    { 'sendBackRequest.requestedBy': user.id },
  ];
  if (roles.includes('time_office') && user.branch) {
    involved.push({ sourceBranch: user.branch }, { destinationBranch: user.branch });
  }
  if ((roles.includes('manager') || roles.includes('supermanager')) && user.branch) {
    involved.push(
      // `!p.approverId` — missing, null or empty
      { status: 'pending', approverId: { $in: [null, ''] }, sourceBranch: user.branch },
      { direction: 'internal', destinationBranch: user.branch },
    );
  }
  if (roles.includes('manager') && user.departmentId) {
    involved.push(
      { departmentId: user.departmentId, sourceBranch: user.branch },
      { 'receivedLog.departmentId': user.departmentId },
    );
  }
  return {
    $or: [
      { status: 'draft', createdBy: user.id },
      { status: { $ne: 'draft' }, $or: involved },
    ],
  };
}

// AND a scope filter with more conditions (admin's scope is empty).
export function withScope(scope, ...more) {
  const clauses = [scope, ...more].filter(c => Object.keys(c).length);
  if (!clauses.length) return {};
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

// ─── SEND-BACK AUTHORITY ──────────────────────────────────────────────────────
// Who approves a send-back: the manager of the department that received the
// items, at the destination branch. A supermanager of that branch can always
// approve too — it's the only approver when the department has no manager,
// and the backup when the manager is away. Admin can always approve.
// Mirrors canApproveSendBack in frontend/src/utils/roles.js.
export function canApproveSendBack(pass, user) {
  if (hasRole(user, 'admin')) return true;
  if (user.branch !== pass.destinationBranch) return false;
  if (hasRole(user, 'supermanager')) return true;
  return hasRole(user, 'manager') && !!user.departmentId &&
    user.departmentId === pass.receivedLog?.departmentId;
}

// Total quantity not yet returned or written off across the pass. Lateness
// keys off this as well as status: once every item is accounted for, the pass
// is done in reality — whatever its stored status says (legacy/backfilled rows
// can lag) — and must never keep showing in the late alerts.
export function outstandingQty(pass) {
  return (pass.items || []).reduce((s, li) =>
    s + Math.max(0, li.quantity - (li.returnedQuantity || 0) - (li.closedQuantity || 0)), 0);
}

// ─── DASHBOARD COUNTS ─────────────────────────────────────────────────────────
// Only the fields computeStats reads — fetched for open passes only, so the
// badge counts never pull item names, documents or remarks.
export const STATS_PROJECTION = {
  _id: 0, id: 1, status: 1, type: 1, direction: 1, returnable: 1,
  sourceBranch: 1, destinationBranch: 1, approverId: 1, expectedReturnDate: 1,
  'items.quantity': 1, 'items.returnedQuantity': 1, 'items.closedQuantity': 1,
  outwardLog: 1, receivedLog: 1, returnRequest: 1, sendBackRequest: 1, returnOutwardLog: 1,
};

// [{ status, type, n }] for a list of passes — what the stats route gets from
// a $group, for callers that already hold the passes (scripts/check-scope.mjs).
export function countsOf(passes) {
  const byKey = new Map();
  for (const p of passes) {
    const key = `${p.status}|${p.type}`;
    const row = byKey.get(key) || { status: p.status, type: p.type, n: 0 };
    row.n += 1;
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

// `passes` = the user's visible passes — every one, or just the open ones
// (every action count below only matches open statuses, so both give the same
// answer). `counts` = [{ status, type, n }] over ALL visible passes.
export function computeStats(user, passes, counts, now = new Date()) {
  const isAdmin = hasRole(user, 'admin');
  const count = (pred) => counts.reduce((s, c) => s + (pred(c) ? c.n : 0), 0);

  // Departures and returns happen at the SOURCE branch gate; receiving a branch
  // transfer happens at the DESTINATION. Non-admins only count their own gate.
  const atMySource = p => isAdmin || p.sourceBranch === user.branch;
  const atMyDest   = p => isAdmin || p.destinationBranch === user.branch;
  const isOpenLeg  = p => ['in_transit', 'partial_return'].includes(p.status);

  // Overdue = my branch's returnable items that should have been back by now
  // and are GENUINELY still out — a completed/closed pass (or one with nothing
  // outstanding) never alerts as late.
  const overdue = passes.filter(p =>
    p.returnable && p.type === 'outward' && isOpenLeg(p) &&
    p.expectedReturnDate && new Date(p.expectedReturnDate) < now &&
    outstandingQty(p) > 0 &&
    atMySource(p)
  );

  const awaitingOutward = passes.filter(p =>
    p.type === 'outward' && p.status === 'approved' && !p.outwardLog && atMySource(p)
  );
  // Pending passes THIS user can actually decide (approver-routing aware) —
  // a pass routed to a colleague is not in my to-do
  const myPendingApprovals = passes.filter(p =>
    p.status === 'pending' &&
    (isAdmin ||
      (hasRole(user, 'manager', 'supermanager') &&
       p.sourceBranch === user.branch &&
       (!p.approverId || p.approverId === user.id)))
  );
  // Returns the source gate could log RIGHT NOW: external items out, or branch
  // transfers whose return the destination has already dispatched. Transfers
  // still sitting with the destination receiver are not actionable here.
  const awaitingInward = passes.filter(p =>
    p.type === 'outward' && p.returnable && isOpenLeg(p) && atMySource(p) &&
    (p.direction !== 'internal' || !p.destinationBranch || !!p.returnOutwardLog)
  );
  // Internal branch transfers dispatched by the source branch, not yet marked in here
  const incomingTransfers = passes.filter(p =>
    p.type === 'outward' && p.direction === 'internal' && p.destinationBranch &&
    p.outwardLog && !p.receivedLog && isOpenLeg(p) && atMyDest(p)
  );
  // Approved send-backs, waiting for the destination gate to mark out
  const awaitingReturnOut = passes.filter(p =>
    p.type === 'outward' && p.direction === 'internal' && p.returnable &&
    p.returnRequest && !p.returnOutwardLog && isOpenLeg(p) && atMyDest(p)
  );
  // Returnable transfers currently in THIS user's custody, send-back not yet
  // requested (once requested, the next move is the manager's)
  const itemsWithMe = passes.filter(p =>
    p.type === 'outward' && p.direction === 'internal' && p.returnable &&
    p.receivedLog?.receiverId === user.id && !p.returnRequest && !p.sendBackRequest &&
    isOpenLeg(p)
  );
  // Receivers' send-back requests THIS user can approve or reject
  const sendBacksToApprove = passes.filter(p =>
    p.sendBackRequest && !p.returnRequest && isOpenLeg(p) &&
    canApproveSendBack(p, user)
  );

  return {
    total:           count(() => true),
    pending:         count(c => c.status === 'pending'),
    approved:        count(c => c.status === 'approved'),
    inTransit:       count(c => c.status === 'in_transit'),
    partialReturn:   count(c => c.status === 'partial_return'),
    // 'closed' merged into 'completed' — legacy rows still count here
    completed:       count(c => ['completed', 'closed'].includes(c.status)),
    rejected:        count(c => c.status === 'rejected'),
    overdueReturns:  overdue.length,
    awaitingOutward: awaitingOutward.length,
    awaitingInward:  awaitingInward.length,
    incomingTransfers: incomingTransfers.length,
    awaitingReturnOut: awaitingReturnOut.length,
    itemsWithMe:       itemsWithMe.length,
    sendBacksToApprove: sendBacksToApprove.length,
    myPendingApprovals: myPendingApprovals.length,
    outward:         count(c => c.type === 'outward'),
    inward:          count(c => c.type === 'inward'),
  };
}
