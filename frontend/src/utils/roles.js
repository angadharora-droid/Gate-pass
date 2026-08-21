// A user can hold several roles at once (e.g. supermanager + time_office).
// `user.role` is the primary (display) role; `user.roles` is the full set.
// Every permission check goes through hasRole so a secondary role grants the
// same powers as a primary one. Mirrors backend/lib/roles.js.
export function rolesOf(user) {
  if (Array.isArray(user?.roles) && user.roles.length) return user.roles;
  return user?.role ? [user.role] : [];
}

export function hasRole(user, ...wanted) {
  const held = rolesOf(user);
  return wanted.some(r => held.includes(r));
}
