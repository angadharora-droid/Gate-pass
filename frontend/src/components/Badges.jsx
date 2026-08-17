// Core terms (Outward/Inward, Returnable/Non-returnable, Internal/External)
// stay as-is; statuses use simple everyday words.
export function StatusBadge({ status }) {
  const labels = {
    pending:        'Waiting Approval',
    approved:       'Approved',
    in_transit:     'Items Out',
    completed:      'Completed',
    closed:         'Closed',
    rejected:       'Rejected',
    partial_return: 'Partly Back',
    overdue:        'Late',
  };
  return (
    <span className={`badge badge-${status}`}>
      {labels[status] || status}
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
