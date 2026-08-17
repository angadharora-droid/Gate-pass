import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db, ROLES, UNITS, CATEGORIES } from '../data/db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { hashPassword } from '../lib/security.js';

// Strip any secret fields before sending a user record to the client.
function enrichUser(u) {
  const { passwordHash, password, ...safe } = u;
  const dept = safe.departmentId ? db.departments.find(d => d.id === safe.departmentId) : null;
  return { ...safe, departmentName: dept?.name || null };
}

// ─── BRANCHES ─────────────────────────────────────────────────────────────────
export const branchesRouter = Router();
branchesRouter.use(authMiddleware);

branchesRouter.get('/', (req, res) => {
  const branches = req.query.all === 'true'
    ? db.branches
    : db.branches.filter(b => b.active !== false);
  res.json(branches);
});

branchesRouter.post('/', requireRole('admin'), (req, res) => {
  const { name, location } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Branch name required' });
  if (db.branches.find(b => b.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: 'Branch with this name already exists' });
  }
  const branch = {
    id: uuidv4(),
    name: name.trim(),
    location: location?.trim() || '',
    active: true,
  };
  db.branches.push(branch);
  res.status(201).json(branch);
});

branchesRouter.patch('/:id', requireRole('admin'), (req, res) => {
  const branch = db.branches.find(b => b.id === req.params.id);
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  const { name, location, active } = req.body;
  if (name !== undefined) branch.name = name.trim();
  if (location !== undefined) branch.location = location.trim();
  if (active !== undefined) branch.active = active;
  res.json(branch);
});

branchesRouter.delete('/:id', requireRole('admin'), (req, res) => {
  const branch = db.branches.find(b => b.id === req.params.id);
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  branch.active = false;
  res.json({ success: true });
});

// ─── USERS ────────────────────────────────────────────────────────────────────
export const usersRouter = Router();
usersRouter.use(authMiddleware);

usersRouter.get('/', requireRole('admin', 'manager', 'time_office'), (req, res) => {
  let users = db.users.map(enrichUser);
  // Managers only see users in their branch
  if (req.user.role === 'manager') {
    users = users.filter(u => u.branch === req.user.branch);
  }
  // time_office only needs names to pick a Receiver on inward entries —
  // active users, minimal fields, no emails
  if (req.user.role === 'time_office') {
    users = users
      .filter(u => u.active !== false)
      .map(u => ({ id: u.id, name: u.name, role: u.role, branch: u.branch, departmentId: u.departmentId, departmentName: u.departmentName }));
  }
  res.json(users);
});

usersRouter.post('/', requireRole('admin'), (req, res) => {
  const { name, email, password, role, branch, departmentId } = req.body;
  if (!name?.trim() || !email?.trim() || !password || !role || !branch) {
    return res.status(400).json({ error: 'name, email, password, role, branch are required' });
  }
  if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` });
  if (db.users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'Email already in use' });
  }
  const branchObj = db.branches.find(b => b.id === branch);
  if (!branchObj) return res.status(400).json({ error: 'Branch not found' });

  if (role !== 'time_office' && !departmentId) {
    return res.status(400).json({ error: 'Department is required for this role' });
  }
  if (departmentId) {
    const dept = db.departments.find(d => d.id === departmentId);
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
  db.users.push(user);
  res.status(201).json(enrichUser(user));
});

usersRouter.patch('/:id', requireRole('admin'), (req, res) => {
  const user = db.users.find(u => u.id === req.params.id);
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

  if (nextRole !== 'time_office' && !nextDepartmentId) {
    return res.status(400).json({ error: 'Department is required for this role' });
  }
  if (nextDepartmentId) {
    const dept = db.departments.find(d => d.id === nextDepartmentId);
    if (!dept || dept.active === false) return res.status(400).json({ error: 'Department not found or inactive' });
    if (dept.branchId !== nextBranch) return res.status(400).json({ error: 'Department must belong to the selected branch' });
  }
  if (departmentId !== undefined) user.departmentId = departmentId || null;
  if (active !== undefined) user.active = active;
  res.json(enrichUser(user));
});

usersRouter.delete('/:id', requireRole('admin'), (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot deactivate yourself' });
  }
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.active = false;
  res.json({ success: true });
});

// ─── META (reference lists) ────────────────────────────────────────────────────
export const metaRouter = Router();
metaRouter.use(authMiddleware);
metaRouter.get('/roles', (_, res) => res.json(ROLES));
metaRouter.get('/units', (_, res) => res.json(UNITS));
metaRouter.get('/categories', (_, res) => res.json(CATEGORIES));

// ─── DEPARTMENTS ─────────────────────────────────────────────────────────────
export const departmentsRouter = Router();
departmentsRouter.use(authMiddleware);

departmentsRouter.get('/', (req, res) => {
  const { branch, all } = req.query;
  let departments = all === 'true'
    ? db.departments
    : db.departments.filter(d => d.active !== false);
  if (branch) departments = departments.filter(d => d.branchId === branch);
  res.json(departments);
});

departmentsRouter.post('/', requireRole('admin'), (req, res) => {
  const { name, branchId } = req.body;
  if (!name?.trim() || !branchId) return res.status(400).json({ error: 'name and branchId are required' });

  const branch = db.branches.find(b => b.id === branchId && b.active !== false);
  if (!branch) return res.status(400).json({ error: 'Branch not found or inactive' });

  const exists = db.departments.find(d => d.branchId === branchId && d.name.toLowerCase() === name.trim().toLowerCase());
  if (exists) return res.status(400).json({ error: 'Department with this name already exists in that branch' });

  const dept = { id: uuidv4(), branchId, name: name.trim(), active: true };
  db.departments.push(dept);
  res.status(201).json(dept);
});

departmentsRouter.patch('/:id', requireRole('admin'), (req, res) => {
  const dept = db.departments.find(d => d.id === req.params.id);
  if (!dept) return res.status(404).json({ error: 'Department not found' });

  const { name, branchId, active } = req.body;

  const nextBranchId = branchId !== undefined ? branchId : dept.branchId;
  if (branchId !== undefined) {
    const branch = db.branches.find(b => b.id === branchId && b.active !== false);
    if (!branch) return res.status(400).json({ error: 'Branch not found or inactive' });
  }

  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) return res.status(400).json({ error: 'Name required' });
    const exists = db.departments.find(d => d.id !== dept.id && d.branchId === nextBranchId && d.name.toLowerCase() === trimmed.toLowerCase());
    if (exists) return res.status(400).json({ error: 'Department with this name already exists in that branch' });
    dept.name = trimmed;
  }
  if (branchId !== undefined) dept.branchId = branchId;
  if (active !== undefined) dept.active = active;
  res.json(dept);
});

departmentsRouter.delete('/:id', requireRole('admin'), (req, res) => {
  const dept = db.departments.find(d => d.id === req.params.id);
  if (!dept) return res.status(404).json({ error: 'Department not found' });
  dept.active = false;
  res.json({ success: true });
});

