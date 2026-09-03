import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbc, NO_ID, ROLES, NO_DEPT_ROLES, UNITS, CATEGORIES, normalizeItemName } from '../data/db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { hasRole, rolesOf, primaryRole } from '../lib/roles.js';
import { hashPassword } from '../lib/security.js';
import { asyncHandler } from '../lib/asyncHandler.js';

// Strip any secret fields before sending a user record to the client.
// `departments` is the pre-fetched departments list (one query per request,
// not one per user).
function enrichUser(u, departments) {
  const { passwordHash, password, ...safe } = u;
  const dept = safe.departmentId ? departments.find(d => d.id === safe.departmentId) : null;
  return { ...safe, departmentName: dept?.name || null };
}

// ─── BRANCHES ─────────────────────────────────────────────────────────────────
export const branchesRouter = Router();
branchesRouter.use(authMiddleware);

branchesRouter.get('/', asyncHandler(async (req, res) => {
  const filter = req.query.all === 'true' ? {} : { active: { $ne: false } };
  res.json(await dbc('branches').find(filter, NO_ID).toArray());
}));

branchesRouter.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const { name, location } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Branch name required' });
  const branches = await dbc('branches').find({}, NO_ID).toArray();
  if (branches.find(b => b.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: 'Branch with this name already exists' });
  }
  const branch = {
    id: uuidv4(),
    name: name.trim(),
    location: location?.trim() || '',
    active: true,
  };
  await dbc('branches').insertOne({ ...branch });
  res.status(201).json(branch);
}));

branchesRouter.patch('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const branch = await dbc('branches').findOne({ id: req.params.id }, NO_ID);
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  const { name, location, active } = req.body;
  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) return res.status(400).json({ error: 'Branch name required' });
    const siblings = await dbc('branches').find({}, NO_ID).toArray();
    if (siblings.find(b => b.id !== branch.id && b.name.toLowerCase() === trimmed.toLowerCase())) {
      return res.status(400).json({ error: 'Branch with this name already exists' });
    }
    branch.name = trimmed;
  }
  if (location !== undefined) branch.location = location.trim();
  if (active !== undefined) branch.active = active;
  await dbc('branches').replaceOne({ id: branch.id }, branch);
  res.json(branch);
}));

branchesRouter.delete('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const branchId = req.params.id;
  // A branch with active people or in-flight passes still has a working gate —
  // deactivating it would strand those users and passes behind a hidden branch.
  const [activeUsers, openPasses] = await Promise.all([
    dbc('users').countDocuments({ branch: branchId, active: { $ne: false } }),
    dbc('gatePasses').countDocuments({
      status: { $in: ['pending', 'approved', 'in_transit', 'partial_return'] },
      $or: [{ sourceBranch: branchId }, { destinationBranch: branchId }],
    }),
  ]);
  if (activeUsers > 0)
    return res.status(400).json({ error: `Cannot deactivate: ${activeUsers} active user(s) belong to this branch. Move or deactivate them first.` });
  if (openPasses > 0)
    return res.status(400).json({ error: `Cannot deactivate: ${openPasses} open pass(es) still reference this branch. Complete or close them first.` });
  const { matchedCount } = await dbc('branches').updateOne({ id: branchId }, { $set: { active: false } });
  if (!matchedCount) return res.status(404).json({ error: 'Branch not found' });
  res.json({ success: true });
}));

// ─── USERS ────────────────────────────────────────────────────────────────────
export const usersRouter = Router();
usersRouter.use(authMiddleware);

// Who can approve MY gate passes: the manager(s) of my own department plus
// every supermanager of my branch. Open to all roles (staff need it on the
// create form) — returns minimal fields only.
usersRouter.get('/approvers', asyncHandler(async (req, res) => {
  const candidates = await dbc('users').find({
    active: { $ne: false },
    branch: req.user.branch,
    // Match a primary OR secondary approver role
    $or: [
      { role:  { $in: ['manager', 'supermanager'] } },
      { roles: { $in: ['manager', 'supermanager'] } },
    ],
  }, NO_ID).toArray();
  const approvers = candidates
    .filter(u => hasRole(u, 'supermanager') ||
      (req.user.departmentId && u.departmentId === req.user.departmentId))
    // Grouping role for the picker: supermanager wins when someone holds both
    .map(u => ({ id: u.id, name: u.name, role: hasRole(u, 'supermanager') ? 'supermanager' : 'manager' }));
  res.json(approvers);
}));

usersRouter.get('/', requireRole('admin', 'manager', 'time_office'), asyncHandler(async (req, res) => {
  const [allUsers, departments] = await Promise.all([
    dbc('users').find({}, NO_ID).toArray(),
    dbc('departments').find({}, NO_ID).toArray(),
  ]);
  let users = allUsers.map(u => enrichUser(u, departments));
  if (hasRole(req.user, 'admin')) {
    // full directory
  } else if (hasRole(req.user, 'manager')) {
    // Managers only see users in their branch
    users = users.filter(u => u.branch === req.user.branch);
  } else {
    // Gate-only accounts need names to pick a Receiver on inward entries and
    // transfer receipts — active users of THEIR OWN branch, minimal fields,
    // no emails. A gate account never needs the whole staff directory.
    users = users
      .filter(u => u.active !== false && u.branch === req.user.branch)
      .map(u => ({ id: u.id, name: u.name, role: u.role, branch: u.branch, departmentId: u.departmentId, departmentName: u.departmentName }));
  }
  res.json(users);
}));

// Login IDs let staff without an email address sign in: short usernames,
// no '@' (so the login endpoint can tell them apart from emails).
const LOGIN_ID_RE = /^[a-z0-9._-]{3,30}$/;
function normalizeLoginId(raw) {
  return String(raw || '').toLowerCase().trim();
}

usersRouter.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const { name, email, loginId, password, role, roles, branch, departmentId } = req.body;
  // A user can hold SEVERAL roles (e.g. supermanager + time_office). Clients
  // send `roles` (array); a bare `role` still works for single-role accounts.
  const finalRoles = [...new Set(Array.isArray(roles) && roles.length ? roles : (role ? [role] : []))];
  if (!name?.trim() || !password || !finalRoles.length || !branch) {
    return res.status(400).json({ error: 'name, password, role(s), branch are required' });
  }
  const cleanEmail = email?.trim() ? email.toLowerCase().trim() : null;
  const cleanLoginId = normalizeLoginId(loginId) || null;
  // Not everyone has an email — but everyone needs SOME way to sign in
  if (!cleanEmail && !cleanLoginId) {
    return res.status(400).json({ error: 'Provide a login ID or an email address' });
  }
  if (cleanLoginId && !LOGIN_ID_RE.test(cleanLoginId)) {
    return res.status(400).json({ error: 'Login ID must be 3-30 characters: letters, numbers, dot, dash or underscore' });
  }
  if (!finalRoles.every(r => ROLES.includes(r)))
    return res.status(400).json({ error: `Roles must be from: ${ROLES.join(', ')}` });
  // Department applies as soon as ANY held role needs one
  const needsDept = finalRoles.some(r => !NO_DEPT_ROLES.includes(r));
  if (cleanEmail && await dbc('users').findOne({ email: cleanEmail })) {
    return res.status(400).json({ error: 'Email already in use' });
  }
  if (cleanLoginId && await dbc('users').findOne({ loginId: cleanLoginId })) {
    return res.status(400).json({ error: 'Login ID already in use' });
  }
  const branchObj = await dbc('branches').findOne({ id: branch }, NO_ID);
  if (!branchObj) return res.status(400).json({ error: 'Branch not found' });

  if (needsDept && !departmentId) {
    return res.status(400).json({ error: 'Department is required for this role' });
  }
  if (needsDept && departmentId) {
    const dept = await dbc('departments').findOne({ id: departmentId }, NO_ID);
    if (!dept || dept.active === false) return res.status(400).json({ error: 'Department not found or inactive' });
    if (dept.branchId !== branch) return res.status(400).json({ error: 'Department must belong to the selected branch' });
  }

  const user = {
    id: uuidv4(),
    name: name.trim(),
    // Absent identifiers are OMITTED (not null) — the sparse unique indexes
    // skip missing fields but would collide on repeated nulls
    ...(cleanEmail ? { email: cleanEmail } : {}),
    ...(cleanLoginId ? { loginId: cleanLoginId } : {}),
    passwordHash: hashPassword(password),
    role: primaryRole(finalRoles),   // display / legacy primary
    roles: finalRoles,               // the full held set
    branch,
    departmentId: needsDept ? (departmentId || null) : null,
    active: true,
  };
  await dbc('users').insertOne({ ...user });
  const departments = await dbc('departments').find({}, NO_ID).toArray();
  res.status(201).json(enrichUser(user, departments));
}));

usersRouter.patch('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const user = await dbc('users').findOne({ id: req.params.id }, NO_ID);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { name, email, loginId, password, role, roles, branch, departmentId, active } = req.body;

  // Role changes: accept `roles` (array) or a bare `role` from older clients
  if (roles !== undefined || role !== undefined) {
    const nextRoles = [...new Set(Array.isArray(roles) && roles.length ? roles : (role ? [role] : []))];
    if (!nextRoles.length || !nextRoles.every(r => ROLES.includes(r)))
      return res.status(400).json({ error: `Roles must be from: ${ROLES.join(', ')}` });
    if (req.params.id === req.user.id && !nextRoles.includes('admin'))
      return res.status(400).json({ error: 'Cannot remove your own admin role' });
    user.roles = nextRoles;
    user.role = primaryRole(nextRoles);
  }

  if (name !== undefined) user.name = name.trim();
  if (email !== undefined) {
    const cleanEmail = email?.trim() ? email.toLowerCase().trim() : null;
    if (cleanEmail && cleanEmail !== user.email &&
        await dbc('users').findOne({ email: cleanEmail, id: { $ne: user.id } })) {
      return res.status(400).json({ error: 'Email already in use' });
    }
    // Clearing an identifier removes the field (sparse index skips missing keys)
    if (cleanEmail) user.email = cleanEmail; else delete user.email;
  }
  if (loginId !== undefined) {
    const cleanLoginId = normalizeLoginId(loginId) || null;
    if (cleanLoginId && !LOGIN_ID_RE.test(cleanLoginId)) {
      return res.status(400).json({ error: 'Login ID must be 3-30 characters: letters, numbers, dot, dash or underscore' });
    }
    if (cleanLoginId && cleanLoginId !== user.loginId &&
        await dbc('users').findOne({ loginId: cleanLoginId, id: { $ne: user.id } })) {
      return res.status(400).json({ error: 'Login ID already in use' });
    }
    if (cleanLoginId) user.loginId = cleanLoginId; else delete user.loginId;
  }
  if (!user.email && !user.loginId) {
    return res.status(400).json({ error: 'User must keep a login ID or an email address to sign in' });
  }
  if (password !== undefined && password) user.passwordHash = hashPassword(password);
  if (branch !== undefined) user.branch = branch;

  const nextDepartmentId = departmentId !== undefined ? (departmentId || null) : user.departmentId;
  const nextBranch = branch !== undefined ? branch : user.branch;
  // Department applies as soon as ANY held role needs one
  const needsDept = rolesOf(user).some(r => !NO_DEPT_ROLES.includes(r));

  if (!needsDept) {
    // Gate/supermanager-only accounts are branch-bound with no department —
    // enforce server-side rather than trusting the client to send null
    user.departmentId = null;
  } else {
    if (!nextDepartmentId) {
      return res.status(400).json({ error: 'Department is required for this role' });
    }
    const dept = await dbc('departments').findOne({ id: nextDepartmentId }, NO_ID);
    if (!dept || dept.active === false) return res.status(400).json({ error: 'Department not found or inactive' });
    if (dept.branchId !== nextBranch) return res.status(400).json({ error: 'Department must belong to the selected branch' });
    if (departmentId !== undefined) user.departmentId = departmentId || null;
  }
  if (active !== undefined) user.active = active;
  await dbc('users').replaceOne({ id: user.id }, user);
  const departments = await dbc('departments').find({}, NO_ID).toArray();
  res.json(enrichUser(user, departments));
}));

usersRouter.delete('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot deactivate yourself' });
  }
  const { matchedCount } = await dbc('users').updateOne({ id: req.params.id }, { $set: { active: false } });
  if (!matchedCount) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
}));

// ─── ITEMS MASTER ─────────────────────────────────────────────────────────────
// One shared, searchable item list holding ONLY items that were entered on a
// gate pass / inward entry in this app (no bulk catalogue — see
// dropSeededItems in data/db.js). Every pass form searches it; any
// authenticated user can add a missing item, and items typed free-hand on
// passes are added automatically server-side.
export const itemsRouter = Router();
itemsRouter.use(authMiddleware);

itemsRouter.get('/', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  // Pass forms ask for a short suggestion list; the Admin → Items tab pulls
  // the whole master (it only holds items entered on passes, so it stays small)
  const limit = Math.min(Number(req.query.limit) || 20, 5000);
  // Admins managing the list may see removed items too (?all=true); pass
  // forms only ever get active ones for suggestions.
  const withInactive = req.query.all === 'true' && hasRole(req.user, 'admin');
  const base = withInactive ? {} : { active: { $ne: false } };
  const projection = { projection: { _id: 0, id: 1, code: 1, name: 1, category: 1, unit: 1, active: 1 } };
  const publish = (list) => res.json(list.map(i => ({ ...i, active: i.active !== false })));
  if (!q) {
    return publish(await dbc('items').find(base, projection).sort({ name: 1 }).limit(limit).toArray());
  }
  // Rank prefix matches above substring matches: a plain substring search
  // sorted alphabetically buries the item the user is actually typing (items
  // merely CONTAINING "sam" alphabetically beat "SAMSUNG…") — so names/codes
  // STARTING with the query fill the list first, and substring matches only
  // top up the remaining slots.
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyEsc = normalizeItemName(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const starts = await dbc('items')
    .find({ ...base, $or: [
      { nameKey: { $regex: '^' + keyEsc } },          // normalized prefix, uses the nameKey index
      { code: { $regex: '^' + esc, $options: 'i' } },
    ] }, projection)
    .sort({ name: 1 })
    .limit(limit)
    .toArray();
  let items = starts;
  if (starts.length < limit) {
    const seen = new Set(starts.map(i => i.id));
    const contains = await dbc('items')
      .find({ ...base, name: { $regex: esc, $options: 'i' } }, projection)
      .sort({ name: 1 })
      .limit(limit + seen.size)
      .toArray();
    items = [...starts, ...contains.filter(i => !seen.has(i.id))].slice(0, limit);
  }
  publish(items);
}));

// Idempotent by normalized name: adding an existing item returns it unchanged
itemsRouter.post('/', asyncHandler(async (req, res) => {
  const { name, unit, category, code } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Item name is required' });
  const nameKey = normalizeItemName(name);
  const existing = await dbc('items').findOne({ nameKey }, NO_ID);
  if (existing) return res.json(existing);
  const item = {
    id: uuidv4(),
    code: code?.trim() || '',
    name: name.trim(),
    nameKey,
    category: category?.trim() || '',
    unit: UNITS.includes(unit) ? unit : 'pcs',
    uom: '',
    active: true,
    source: 'user',
    addedBy: req.user.id,
  };
  await dbc('items').insertOne({ ...item });
  res.status(201).json(item);
}));

// Admin edit: name / code / unit / category, plus restore (active: true).
// A rename also rewrites the item's name on every pass line that used the old
// spelling (case/space-insensitive), so reports and the register stay
// consistent with the list — same rule as renaming a vendor.
itemsRouter.patch('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const item = await dbc('items').findOne({ id: req.params.id }, NO_ID);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const { name, code, unit, category, active } = req.body || {};
  const oldName = item.name;
  if (name !== undefined) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'Item name is required' });
    const nameKey = normalizeItemName(trimmed);
    const clash = await dbc('items').findOne({ nameKey, id: { $ne: item.id } }, NO_ID);
    if (clash) return res.status(400).json({ error: `Item "${clash.name}" already exists` });
    item.name = trimmed;
    item.nameKey = nameKey;
  }
  if (code !== undefined) item.code = String(code || '').trim();
  if (category !== undefined) item.category = String(category || '').trim();
  if (unit !== undefined) {
    if (!UNITS.includes(unit)) return res.status(400).json({ error: `Unit must be one of: ${UNITS.join(', ')}` });
    item.unit = unit;
  }
  if (active !== undefined) item.active = !!active;
  await dbc('items').replaceOne({ id: item.id }, item);
  if (item.name !== oldName) {
    // "dinner  plate" / "Dinner Plate" / "DINNER PLATE" all mean the old item
    const pattern = '^\\s*' + oldName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\s*$';
    const match = { $regex: pattern, $options: 'i' };
    await dbc('gatePasses').updateMany(
      { 'items.itemName': match },
      { $set: { 'items.$[el].itemName': item.name } },
      { arrayFilters: [{ 'el.itemName': match }] },
    );
  }
  res.json({ ...item, active: item.active !== false });
}));

// Remove from the suggestion list (deactivate — restorable via PATCH).
// Pass lines keep the item's name as plain text, so history is untouched.
itemsRouter.delete('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { matchedCount } = await dbc('items').updateOne({ id: req.params.id }, { $set: { active: false } });
  if (!matchedCount) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true });
}));

// ─── VENDORS MASTER ───────────────────────────────────────────────────────────
// FIXED list of inward source parties (vendors/couriers/etc.) maintained by
// admins only. Security must pick "Received From" from this list on inward
// entries — POST /gate-passes/inward rejects any name that isn't on it.
// Removal deactivates (like branches/departments) so the name can be restored;
// passes keep the vendor's name as plain text, so history is never affected.
export const vendorsRouter = Router();
vendorsRouter.use(authMiddleware);

const vendorPublic = (v) => ({ id: v.id, name: v.name, active: v.active !== false });

vendorsRouter.get('/', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  // Admins managing the list may see removed vendors too (?all=true); everyone
  // else only ever gets active names for picking. The list is short (a few
  // hundred names at most), so callers may pull ALL of it — Security should
  // see every vendor when the "Received From" box is focused, not a page.
  const withInactive = req.query.all === 'true' && hasRole(req.user, 'admin');
  const limit = Math.min(Number(req.query.limit) || 10, 1000);
  const filter = withInactive ? {} : { active: { $ne: false } };
  if (q) {
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.name = { $regex: esc, $options: 'i' };
  }
  const vendors = await dbc('vendors')
    .find(filter, { projection: { _id: 0, id: 1, name: 1, active: 1 } })
    .sort({ name: 1 })
    .limit(limit)
    .toArray();
  res.json(vendors.map(vendorPublic));
}));

// Add a vendor. Names are unique case/space-insensitively; adding a name that
// was removed earlier restores that record instead of creating a duplicate.
vendorsRouter.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Vendor name is required' });
  const nameKey = normalizeItemName(name);
  const existing = await dbc('vendors').findOne({ nameKey }, NO_ID);
  if (existing) {
    if (existing.active !== false)
      return res.status(400).json({ error: `Vendor "${existing.name}" already exists` });
    await dbc('vendors').updateOne({ id: existing.id }, { $set: { name, active: true } });
    return res.json(vendorPublic({ ...existing, name, active: true }));
  }
  const vendor = {
    id: uuidv4(), name, nameKey, active: true,
    source: 'admin', addedBy: req.user.id, createdAt: new Date().toISOString(),
  };
  await dbc('vendors').insertOne({ ...vendor });
  res.status(201).json(vendorPublic(vendor));
}));

// Rename / restore / remove. A rename also rewrites the name on every inward
// entry that used the old spelling, so reports and the register stay
// consistent with the list (same idea as scripts/merge-vendors.mjs).
vendorsRouter.patch('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const vendor = await dbc('vendors').findOne({ id: req.params.id }, NO_ID);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
  const { name, active } = req.body || {};
  const oldName = vendor.name;
  if (name !== undefined) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'Vendor name is required' });
    const nameKey = normalizeItemName(trimmed);
    const clash = await dbc('vendors').findOne({ nameKey, id: { $ne: vendor.id } }, NO_ID);
    if (clash) return res.status(400).json({ error: `Vendor "${clash.name}" already exists` });
    vendor.name = trimmed;
    vendor.nameKey = nameKey;
  }
  if (active !== undefined) vendor.active = !!active;
  await dbc('vendors').replaceOne({ id: vendor.id }, vendor);
  if (vendor.name !== oldName) {
    await dbc('gatePasses').updateMany(
      { type: 'inward', $or: [{ vendorId: vendor.id }, { destinationPerson: oldName }] },
      { $set: { destinationPerson: vendor.name } },
    );
  }
  res.json(vendorPublic(vendor));
}));

vendorsRouter.delete('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { matchedCount } = await dbc('vendors').updateOne({ id: req.params.id }, { $set: { active: false } });
  if (!matchedCount) return res.status(404).json({ error: 'Vendor not found' });
  res.json({ success: true });
}));

// ─── META (reference lists) ────────────────────────────────────────────────────
export const metaRouter = Router();
metaRouter.use(authMiddleware);
metaRouter.get('/roles', (_, res) => res.json(ROLES));
metaRouter.get('/units', (_, res) => res.json(UNITS));
metaRouter.get('/categories', (_, res) => res.json(CATEGORIES));

// ─── DEPARTMENTS ─────────────────────────────────────────────────────────────
export const departmentsRouter = Router();
departmentsRouter.use(authMiddleware);

departmentsRouter.get('/', asyncHandler(async (req, res) => {
  const { branch, all } = req.query;
  const filter = all === 'true' ? {} : { active: { $ne: false } };
  if (branch) filter.branchId = branch;
  res.json(await dbc('departments').find(filter, NO_ID).toArray());
}));

departmentsRouter.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const { name, branchId } = req.body;
  if (!name?.trim() || !branchId) return res.status(400).json({ error: 'name and branchId are required' });

  const branch = await dbc('branches').findOne({ id: branchId, active: { $ne: false } }, NO_ID);
  if (!branch) return res.status(400).json({ error: 'Branch not found or inactive' });

  const siblings = await dbc('departments').find({ branchId }, NO_ID).toArray();
  if (siblings.find(d => d.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: 'Department with this name already exists in that branch' });
  }

  const dept = { id: uuidv4(), branchId, name: name.trim(), active: true };
  await dbc('departments').insertOne({ ...dept });
  res.status(201).json(dept);
}));

departmentsRouter.patch('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const dept = await dbc('departments').findOne({ id: req.params.id }, NO_ID);
  if (!dept) return res.status(404).json({ error: 'Department not found' });

  const { name, branchId, active } = req.body;

  const nextBranchId = branchId !== undefined ? branchId : dept.branchId;
  if (branchId !== undefined) {
    const branch = await dbc('branches').findOne({ id: branchId, active: { $ne: false } }, NO_ID);
    if (!branch) return res.status(400).json({ error: 'Branch not found or inactive' });
  }

  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) return res.status(400).json({ error: 'Name required' });
    const siblings = await dbc('departments').find({ branchId: nextBranchId }, NO_ID).toArray();
    if (siblings.find(d => d.id !== dept.id && d.name.toLowerCase() === trimmed.toLowerCase())) {
      return res.status(400).json({ error: 'Department with this name already exists in that branch' });
    }
    dept.name = trimmed;
  }
  if (branchId !== undefined) dept.branchId = branchId;
  if (active !== undefined) dept.active = active;
  await dbc('departments').replaceOne({ id: dept.id }, dept);
  res.json(dept);
}));

departmentsRouter.delete('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { matchedCount } = await dbc('departments').updateOne({ id: req.params.id }, { $set: { active: false } });
  if (!matchedCount) return res.status(404).json({ error: 'Department not found' });
  res.json({ success: true });
}));
