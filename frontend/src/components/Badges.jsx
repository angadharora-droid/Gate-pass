import { hasRole } from '../utils/roles';

// Core terms (Outward/Inward, Returnable/Non-returnable, Internal/External)
// stay as-is; statuses use simple everyday words.
// Keys cover both stored statuses and the derived lifecycle stages the server
// computes as `displayStatus` (items_out / in_transit / at_destination /
// return_approved / returning). This map is THE label source — import it
// instead of redefining labels elsewhere.
export const STATUS_LABELS = {
  draft:           'Draft',
  pending:         'Waiting Approval',
  approved:        'Approved',
  items_out:       'Items Out',        // out with a person/vendor (external)
  in_transit:      'In Transit',       // moving between branches
  at_destination:  'At Destination',   // received; with the receiver there
  return_approved: 'Send-Back Approved',
  returning:       'Returning',        // dispatched back to the source branch
  completed:       'Completed',
  closed:          'Completed',   // legacy alias — 'closed' was merged into 'completed'
  rejected:        'Rejected',
  partial_return:  'Partly Back',
  overdue:         'Late',
};

// Prefer passing the whole pass — the badge then shows the precise stage
// (displayStatus) with a separate "Late" chip when overdue, so lateness never
// hides WHERE the items are. `status` is a fallback for raw-key callers.
export function StatusBadge({ pass, status }) {
  if (!pass) {
    return <span className={`badge badge-${status}`}>{STATUS_LABELS[status] || status}</span>;
  }
  const key = pass.displayStatus || pass.status;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      <span className={`badge badge-${key}`}>{STATUS_LABELS[key] || key}</span>
      {pass.isOverdue && <span className="badge badge-overdue">Late</span>}
    </span>
  );
}

export function TypeBadge({ type }) {
  return (
    <span className={`badge badge-${type}`}>
      {type === 'outward' ? 'Outward' : 'Inward'}
    </span>
  );
}

// ─── Viewer-relative movement ────────────────────────────────────────────────
// Which way is this pass moving relative to MY branch? A transfer stored as an
// outward pass at Hotel 1 is nevertheless COMING IN for a Hotel 2 user. Direct
// inward entries always come in; everything else goes out. Admin (org-wide
// view) falls back to the stored type.
export function movementFor(pass, user) {
  if (pass.type === 'inward') return 'in';
  const isTransfer = pass.direction === 'internal' && pass.destinationBranch;
  if (isTransfer && !hasRole(user, 'admin') &&
      pass.destinationBranch === user?.branch && pass.sourceBranch !== user?.branch) {
    return 'in';
  }
  return 'out';
}

export function MovementBadge({ pass, user }) {
  const m = movementFor(pass, user);
  // Admin sees the org-wide stored type, so use the plain type words for them —
  // "Coming In / Going Out" is only truthful for branch-scoped viewers.
  const admin = hasRole(user, 'admin');
  return m === 'in'
    ? <span className="badge badge-inward">{admin ? 'Inward' : 'Coming In'}</span>
    : <span className="badge badge-outward">{admin ? 'Outward' : 'Going Out'}</span>;
}

export function ReturnableBadge({ returnable }) {
  return (
    <span className={`tag tag-${returnable ? 'returnable' : 'non-returnable'}`}>
      {returnable ? 'Returnable' : 'Non-returnable'}
    </span>
  );
}

export function DirectionBadge({ direction }) {
  return (
    <span className={`tag tag-${direction}`}>
      {direction === 'internal' ? 'Internal' : 'External'}
    </span>
  );
}
