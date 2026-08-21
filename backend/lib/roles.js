// ─── MULTI-ROLE SUPPORT ──────────────────────────────────────────────────────
// A user can hold several roles at once (e.g. supermanager + time_office: they
// approve passes AND run the gate). `user.role` remains the PRIMARY role (used
// for display and as the fallback for accounts created before this feature);
// `user.roles` is the full set. Every permission check goes through hasRole so
// a secondary role grants exactly the same powers as a primary one.

// Highest first — the primary role is the most powerful one held.
export const ROLE_PRECEDENCE = ['admin', 'supermanager', 'manager', 'staff', 'time_office'];

export function rolesOf(user) {
  if (Array.isArray(user?.roles) && user.roles.length) return user.roles;
  return user?.role ? [user.role] : [];
}

export function hasRole(user, ...wanted) {
  const held = rolesOf(user);
  return wanted.some(r => held.includes(r));
}

// Derive the primary role from a set, by precedence.
export function primaryRole(roles) {
  return ROLE_PRECEDENCE.find(r => roles.includes(r)) || roles[0] || null;
}
