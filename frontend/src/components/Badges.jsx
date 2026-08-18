// Core terms (Outward/Inward, Returnable/Non-returnable, Internal/External)
// stay as-is; statuses use simple everyday words.
// Keys cover both stored statuses and the derived lifecycle stages the server
// computes as `displayStatus` (items_out / in_transit / at_destination /
// return_approved / returning). This map is THE label source — import it
// instead of redefining labels elsewhere.
export const STATUS_LABELS = {
  pending:         'Waiting Approval',
  approved:        'Approved',
  items_out:       'Items Out',        // out with a person/vendor (external)
  in_transit:      'In Transit',       // moving between branches
  at_destination:  'At Destination',   // received; with the receiver there
  return_approved: 'Send-Back Approved',
  returning:       'Returning',        // dispatched back to the source branch
  completed:       'Completed',
  closed:          'Closed',
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
