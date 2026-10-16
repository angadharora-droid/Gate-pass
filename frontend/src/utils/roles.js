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

// Who approves (or rejects) a branch transfer's send-back: the manager of the
// department that received the items, at the destination branch; any
// supermanager of that branch (the only approver when the department has no
// manager, the backup otherwise); admin. Mirrors canApproveSendBack in
// backend/routes/gatePasses.js.
export function canApproveSendBack(user, pass) {
  if (hasRole(user, 'admin')) return true;
  if (!user || user.branch !== pass?.destinationBranch) return false;
  if (hasRole(user, 'supermanager')) return true;
  return hasRole(user, 'manager') && !!user.departmentId &&
    user.departmentId === pass?.receivedLog?.departmentId;
}
