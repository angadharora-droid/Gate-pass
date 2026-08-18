import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbc, NO_ID, ROLES, UNITS, CATEGORIES } from '../data/db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
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

usersRouter.get('/', requireRole('admin', 'manager', 'time_office'), asyncHandler(async (req, res) => {
  const [allUsers, departments] = await Promise.all([
    dbc('users').find({}, NO_ID).toArray(),
    dbc('departments').find({}, NO_ID).toArray(),
  ]);
  let users = allUsers.map(u => enrichUser(u, departments));
  // Managers only see users in their branch
  if (req.user.role === 'manager') {
    users = users.filter(u => u.branch === req.user.branch);
  }
  // time_office only needs names to pick a Receiver on inward entries and
  // transfer receipts — active users of THEIR OWN branch, minimal fields,
  // no emails. A gate account never needs the whole staff directory.
  if (req.user.role === 'time_office') {
    users = users
      .filter(u => u.active !== false && u.branch === req.user.branch)
      .map(u => ({ id: u.id, name: u.name, role: u.role, branch: u.branch, departmentId: u.departmentId, departmentName: u.departmentName }));
  }
  res.json(users);
}));

usersRouter.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const { name, email, password, role, branch, departmentId } = req.body;
  if (!name?.trim() || !email?.trim() || !password || !role || !branch) {
    return res.status(400).json({ error: 'name, email, password, role, branch are required' });
  }
  if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` });
  if (await dbc('users').findOne({ email: email.toLowerCase().trim() })) {
    return res.status(400).json({ error: 'Email already in use' });
  }
  const branchObj = await dbc('branches').findOne({ id: branch }, NO_ID);
  if (!branchObj) return res.status(400).json({ error: 'Branch not found' });

  if (role !== 'time_office' && !departmentId) {
    return res.status(400).json({ error: 'Department is required for this role' });
  }
  if (departmentId) {
    const dept = await dbc('departments').findOne({ id: departmentId }, NO_ID);
    if (!dept || dept.active === false) return res.status(400).json({ error: 'Department not found or inactive' });
    if (dept.branchId !== branch) return res.status(400).json({ error: 'Department must belong to the selected branch' });
  }

  const user = {
    id: uuidv4(),
    name: name.trim(),
    email: email.toLowerCase().trim(),
    passwordHash: hashPassword(password),
    role,
    branch,
    departmentId: departmentId || null,
    active: true,
  };
  await dbc('users').insertOne({ ...user });
  const departments = await dbc('departments').find({}, NO_ID).toArray();
  res.status(201).json(enrichUser(user, departments));
}));

usersRouter.patch('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const user = await dbc('users').findOne({ id: req.params.id }, NO_ID);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (req.params.id === req.user.id && req.body.role && req.body.role !== 'admin') {
    return res.status(400).json({ error: 'Cannot remove your own admin role' });
  }
  const { name, email, password, role, branch, departmentId, active } = req.body;
  if (name !== undefined) user.name = name.trim();
  if (email !== undefined) user.email = email.toLowerCase().trim();
  if (password !== undefined && password) user.passwordHash = hashPassword(password);
  if (role !== undefined) user.role = role;
  if (branch !== undefined) user.branch = branch;

  const nextDepartmentId = departmentId !== undefined ? (departmentId || null) : user.departmentId;
  const nextRole = role !== undefined ? role : user.role;
  const nextBranch = branch !== undefined ? branch : user.branch;

  if (nextRole === 'time_office') {
    // Gate accounts are branch-bound with no department — enforce server-side
    // rather than trusting the client to send departmentId: null
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
