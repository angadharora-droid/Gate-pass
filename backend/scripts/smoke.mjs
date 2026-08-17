// End-to-end smoke test: boots a throwaway in-memory MongoDB, starts the real
// server against it, and walks the core flows through the HTTP API.
// Run with: npm run test:smoke
import { MongoMemoryServer } from 'mongodb-memory-server';

const PORT = 4271;
const BASE = `http://127.0.0.1:${PORT}/api`;

// Generous launch timeout — the first boot on Windows can be slow while the
// downloaded mongod binary gets scanned by Defender.
const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
process.env.MONGODB_URI = mongod.getUri();
process.env.MONGODB_DB = 'gatepass_smoke';
process.env.JWT_SECRET = 'smoke-test-secret';
process.env.PORT = String(PORT);

await import('../server.js');

// Wait until the server answers
for (let i = 0; ; i++) {
  try {
    const r = await fetch(`${BASE}/health`);
    if (r.ok) break;
  } catch { /* not up yet */ }
  if (i > 50) throw new Error('Server did not start');
  await new Promise(r => setTimeout(r, 200));
}

let failures = 0;
function check(name, cond, extra = '') {
  const mark = cond ? '✓' : '✗';
  console.log(`${mark} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function login(email, password) {
  const { status, json } = await api('POST', '/auth/login', { body: { email, password } });
  if (status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(json)}`);
  return json.token;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
const bad = await api('POST', '/auth/login', { body: { email: 'arjun@hotel.com', password: 'wrong' } });
check('rejects bad password', bad.status === 401);

const admin = await login('arjun@hotel.com', 'admin123');
const manager = await login('priya@hotel.com', 'pass123');
const staff = await login('vikram@hotel.com', 'pass123');
const timeOffice = await login('karan@hotel.com', 'pass123');
check('all seed roles can log in', true);

const me = await api('GET', '/auth/me', { token: staff });
check('GET /auth/me returns user with branch name', me.json?.user?.name === 'Vikram Joshi' && me.json?.user?.branchName === 'Grand Hotel – Main');
check('user payload has no passwordHash', me.json?.user?.passwordHash === undefined && me.json?.user?._id === undefined);

const noToken = await api('GET', '/gate-passes');
check('rejects missing token', noToken.status === 401);

// ─── Seeded data ──────────────────────────────────────────────────────────────
const seeded = await api('GET', '/gate-passes', { token: admin });
check('seed passes present', Array.isArray(seeded.json) && seeded.json.length === 4, `got ${seeded.json?.length}`);
check('passes enriched with names', seeded.json?.every(p => p.createdByUser?.name) === true);
check('no _id leaks in list', JSON.stringify(seeded.json).includes('"_id"') === false);

const branches = await api('GET', '/branches', { token: staff });
check('branches seeded', branches.json?.length === 3, `got ${branches.json?.length}`);

// Staff of b1 should not see the b2-only view leak etc. — staff sees passes touching their branch
const staffList = await api('GET', '/gate-passes', { token: staff });
check('branch scoping applies to staff', staffList.json?.every(p => p.sourceBranch === 'b1' || p.destinationBranch === 'b1'));

// ─── Create → approve → log-outward → log-inward (full lifecycle) ────────────
const created = await api('POST', '/gate-passes', {
  token: staff,
  body: {
    type: 'outward', direction: 'external', destinationPerson: 'Repair Shop',
    returnable: true, purpose: 'Chair repair', expectedReturnDate: '2099-01-01T00:00:00Z',
    items: [{ itemName: 'Office Chair', quantity: 4, unit: 'pcs' }],
  },
});
check('staff creates pending pass', created.status === 201 && created.json?.status === 'pending', JSON.stringify(created.json));
check('pass number generated sequentially', created.json?.passNumber === 'GP-OER-' + new Date().getFullYear() + '-0005', created.json?.passNumber);
const passId = created.json?.id;

const approved = await api('PATCH', `/gate-passes/${passId}/status`, { token: manager, body: { action: 'approve' } });
check('manager approves', approved.status === 200 && approved.json?.status === 'approved');

const outward = await api('PATCH', `/gate-passes/${passId}/log-outward`, { token: timeOffice, body: { guardName: 'Ajay' } });
check('time office logs outward → in_transit', outward.status === 200 && outward.json?.status === 'in_transit');

const partial = await api('PATCH', `/gate-passes/${passId}/log-inward`, {
  token: timeOffice,
  body: { guardName: 'Ajay', returns: [{ index: 0, quantity: 3 }] },
});
check('partial return → partial_return', partial.status === 200 && partial.json?.status === 'partial_return');

const overReturn = await api('PATCH', `/gate-passes/${passId}/log-inward`, {
  token: timeOffice,
  body: { guardName: 'Ajay', returns: [{ index: 0, quantity: 5 }] },
});
check('over-return rejected', overReturn.status === 400);

const closed = await api('PATCH', `/gate-passes/${passId}/log-inward`, {
  token: timeOffice,
  body: { guardName: 'Ajay', returns: [], closures: [{ index: 0, quantity: 1, reason: 'Broken beyond repair' }] },
});
check('closure of last item → closed', closed.status === 200 && closed.json?.status === 'closed', closed.json?.status);
check('earlyReturn flagged (before 2099)', closed.json?.earlyReturn === true);

// Re-read from DB to confirm the mutation was persisted, not just echoed
const reread = await api('GET', `/gate-passes/${passId}`, { token: admin });
check('mutations persisted to MongoDB', reread.json?.status === 'closed' && reread.json?.items?.[0]?.returnedQuantity === 3 && reread.json?.items?.[0]?.closedQuantity === 1);

// ─── Direct inward by Security ───────────────────────────────────────────────
const inwardDenied = await api('POST', '/gate-passes/inward', { token: staff, body: {} });
check('staff cannot log direct inward', inwardDenied.status === 403);

const inward = await api('POST', '/gate-passes/inward', {
  token: timeOffice,
  body: {
    branchId: 'b1', departmentId: 'd2', receiverId: 'u2', inwardType: 'non_returnable',
    documentType: 'Invoice', documentNo: 'INV-9999', carriedBy: 'Courier Guy',
    items: [{ itemName: 'Spare Parts', quantity: 2, unit: 'box' }],
  },
});
check('security logs direct inward → completed', inward.status === 201 && inward.json?.status === 'completed' && inward.json?.inwardLog?.guardName === 'Karan Tiwari');

// ─── Stats & audit ────────────────────────────────────────────────────────────
const stats = await api('GET', '/gate-passes/meta/stats', { token: admin });
check('stats totals add up', stats.json?.total === 6 && stats.json?.closed === 1, JSON.stringify(stats.json));

const audit = await api('GET', '/audit', { token: admin });
check('audit log recorded with user names', audit.status === 200 && audit.json?.length >= 6 && audit.json?.every(l => l.userName));
const auditDenied = await api('GET', '/audit', { token: manager });
check('audit is admin-only', auditDenied.status === 403);

// ─── Admin CRUD ───────────────────────────────────────────────────────────────
const newBranch = await api('POST', '/branches', { token: admin, body: { name: 'Test Branch', location: 'Test' } });
check('admin creates branch', newBranch.status === 201);
const dupBranch = await api('POST', '/branches', { token: admin, body: { name: 'test branch' } });
check('duplicate branch name rejected (case-insensitive)', dupBranch.status === 400);

const newDept = await api('POST', '/departments', { token: admin, body: { name: 'Test Dept', branchId: newBranch.json.id } });
check('admin creates department', newDept.status === 201);

const newUser = await api('POST', '/users', {
  token: admin,
  body: { name: 'Test User', email: 'TEST@hotel.com', password: 'secret1', role: 'staff', branch: newBranch.json.id, departmentId: newDept.json.id },
});
check('admin creates user (email lowercased)', newUser.status === 201 && newUser.json?.email === 'test@hotel.com');
const dupUser = await api('POST', '/users', {
  token: admin,
  body: { name: 'Dup', email: 'test@hotel.com', password: 'x', role: 'staff', branch: newBranch.json.id, departmentId: newDept.json.id },
});
check('duplicate email rejected', dupUser.status === 400);
const newLogin = await login('test@hotel.com', 'secret1');
check('newly created user can log in', typeof newLogin === 'string');

const deact = await api('DELETE', `/users/${newUser.json.id}`, { token: admin });
check('admin deactivates user', deact.status === 200);
const deadLogin = await api('POST', '/auth/login', { body: { email: 'test@hotel.com', password: 'secret1' } });
check('deactivated user cannot log in', deadLogin.status === 401);

// ─── Done ─────────────────────────────────────────────────────────────────────
console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} SMOKE TEST(S) FAILED`);
await mongod.stop();
process.exit(failures === 0 ? 0 : 1);
