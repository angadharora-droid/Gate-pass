// End-to-end smoke test: starts the real server against a DISPOSABLE database
// (`gatepass_smoke`) on whatever MongoDB cluster MONGODB_URI points at, and
// walks the core flows through the HTTP API — starting from the minimal seed
// (a single admin), exactly like a fresh production boot. The smoke database
// is dropped before and after the run; the real `gatepass` database is never
// touched. Run with: npm run test:smoke   (needs MONGODB_URI in env or .env)
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const PORT = 4271;
const BASE = `http://127.0.0.1:${PORT}/api`;
const SMOKE_DB = 'gatepass_smoke';

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is not set — put it in backend/.env (see .env.example) to run the smoke test.');
  process.exit(1);
}

// Start from a clean slate so seeding and assertions are deterministic.
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
await client.connect();
await client.db(SMOKE_DB).dropDatabase();

process.env.MONGODB_DB = SMOKE_DB;
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

// ─── Minimal seed ─────────────────────────────────────────────────────────────
const bad = await api('POST', '/auth/login', { body: { email: 'arjun@hotel.com', password: 'wrong' } });
check('rejects bad password', bad.status === 401);

const admin = await login('arjun@hotel.com', 'admin123');
check('seed admin can log in', typeof admin === 'string');

const me = await api('GET', '/auth/me', { token: admin });
check('admin enriched with seed branch/department', me.json?.user?.branchName === 'Main Branch' && me.json?.user?.departmentName === 'Administration');
check('user payload has no passwordHash/_id', me.json?.user?.passwordHash === undefined && me.json?.user?._id === undefined);

const noToken = await api('GET', '/gate-passes');
check('rejects missing token', noToken.status === 401);

const emptyPasses = await api('GET', '/gate-passes', { token: admin });
check('no mock gate passes seeded', Array.isArray(emptyPasses.json) && emptyPasses.json.length === 0, `got ${emptyPasses.json?.length}`);
const seedBranches = await api('GET', '/branches', { token: admin });
check('only the bootstrap branch seeded', seedBranches.json?.length === 1 && seedBranches.json[0].name === 'Main Branch');
const seedUsers = await api('GET', '/users', { token: admin });
check('only the admin user seeded', seedUsers.json?.length === 1 && seedUsers.json[0].role === 'admin');

// ─── Admin bootstraps the org (the real first-run flow) ──────────────────────
const b1 = seedBranches.json[0].id;
const d1 = (await api('GET', '/departments', { token: admin })).json[0].id;

const mkUser = (name, email, role, departmentId) =>
  api('POST', '/users', { token: admin, body: { name, email, password: 'secret1', role, branch: b1, departmentId } });

const managerUser = await mkUser('Manager One', 'manager@test.com', 'manager', d1);
const staffUser   = await mkUser('Staff One', 'staff@test.com', 'staff', d1);
const toUser      = await mkUser('Guard One', 'guard@test.com', 'time_office', null);
check('admin creates manager/staff/time_office', managerUser.status === 201 && staffUser.status === 201 && toUser.status === 201);

const timeOfficeNoDept = await api('POST', '/users', { token: admin, body: { name: 'X', email: 'x@test.com', password: 'p', role: 'staff', branch: b1 } });
check('staff without department rejected', timeOfficeNoDept.status === 400);

const manager = await login('manager@test.com', 'secret1');
const staff = await login('staff@test.com', 'secret1');
const timeOffice = await login('guard@test.com', 'secret1');
check('created users can log in', true);

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
check('numbering starts at 0001 on fresh db', created.json?.passNumber === 'GP-OER-' + new Date().getFullYear() + '-0001', created.json?.passNumber);
const passId = created.json?.id;

const staffApprove = await api('PATCH', `/gate-passes/${passId}/status`, { token: staff, body: { action: 'approve' } });
check('staff cannot approve', staffApprove.status === 403);

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
    branchId: b1, departmentId: d1, receiverId: managerUser.json.id, inwardType: 'non_returnable',
    documentType: 'Invoice', documentNo: 'INV-9999', carriedBy: 'Courier Guy',
    items: [{ itemName: 'Spare Parts', quantity: 2, unit: 'box' }],
  },
});
check('security logs direct inward → completed', inward.status === 201 && inward.json?.status === 'completed' && inward.json?.inwardLog?.guardName === 'Guard One');

// ─── Stats & audit ────────────────────────────────────────────────────────────
const stats = await api('GET', '/gate-passes/meta/stats', { token: admin });
check('stats totals add up', stats.json?.total === 2 && stats.json?.closed === 1, JSON.stringify(stats.json));

const audit = await api('GET', '/audit', { token: admin });
check('audit log recorded with user names', audit.status === 200 && audit.json?.length >= 6 && audit.json?.every(l => l.userName));
const auditDenied = await api('GET', '/audit', { token: manager });
check('audit is admin-only', auditDenied.status === 403);

// ─── Admin CRUD guards ───────────────────────────────────────────────────────
const newBranch = await api('POST', '/branches', { token: admin, body: { name: 'Second Branch', location: 'Elsewhere' } });
check('admin creates branch', newBranch.status === 201);
const dupBranch = await api('POST', '/branches', { token: admin, body: { name: 'second branch' } });
check('duplicate branch name rejected (case-insensitive)', dupBranch.status === 400);

// ─── Inter-branch transfer: source dispatches, destination receives ──────────
const b2 = newBranch.json.id;
const toUser2 = await api('POST', '/users', {
  token: admin,
  body: { name: 'Guard Two', email: 'guard2@test.com', password: 'secret1', role: 'time_office', branch: b2 },
});
check('admin creates time_office at second branch', toUser2.status === 201);
const timeOffice2 = await login('guard2@test.com', 'secret1');

const dept2 = await api('POST', '/departments', { token: admin, body: { name: 'Housekeeping', branchId: b2 } });
const staff2User = await api('POST', '/users', {
  token: admin,
  body: { name: 'Staff Two', email: 'staff2@test.com', password: 'secret1', role: 'staff', branch: b2, departmentId: dept2.json?.id },
});
check('admin creates department + staff at second branch', dept2.status === 201 && staff2User.status === 201);
const staff2 = await login('staff2@test.com', 'secret1');
const d2 = dept2.json.id;
const r2 = staff2User.json.id;

const transfer = await api('POST', '/gate-passes', {
  token: manager,
  body: {
    type: 'outward', direction: 'internal', destinationBranch: b2,
    returnable: false, purpose: 'Extra crockery for banquet',
    items: [{ itemName: 'Dinner Plates', quantity: 50, unit: 'pcs' }],
  },
});
check('manager creates internal transfer (auto-approved)', transfer.status === 201 && transfer.json?.status === 'approved');
const transferId = transfer.json?.id;

const wrongGateOut = await api('PATCH', `/gate-passes/${transferId}/log-outward`, { token: timeOffice2, body: { guardName: 'Binu' } });
check('destination gate cannot mark items out', wrongGateOut.status === 403);

const earlyReceive = await api('PATCH', `/gate-passes/${transferId}/receive`, { token: timeOffice2, body: { guardName: 'Binu' } });
check('cannot receive before source marks items out', earlyReceive.status === 400);

const dispatched = await api('PATCH', `/gate-passes/${transferId}/log-outward`, { token: timeOffice, body: { guardName: 'Ajay' } });
check('internal transfer dispatch → in_transit (not completed)', dispatched.status === 200 && dispatched.json?.status === 'in_transit');

const destStats = await api('GET', '/gate-passes/meta/stats', { token: timeOffice2 });
check('transfer counts as incoming at destination branch', destStats.json?.incomingTransfers === 1, JSON.stringify(destStats.json));

const destList = await api('GET', '/gate-passes', { token: timeOffice2 });
check('destination TO sees only passes touching their branch', destList.json?.length === 1 && destList.json?.[0]?.id === transferId, `got ${destList.json?.length}`);

const wrongGateIn = await api('PATCH', `/gate-passes/${transferId}/receive`, { token: timeOffice, body: { guardName: 'Ajay', departmentId: d2, receiverId: r2 } });
check('source gate cannot mark items in', wrongGateIn.status === 403);

const noReceiver = await api('PATCH', `/gate-passes/${transferId}/receive`, { token: timeOffice2, body: { guardName: 'Binu' } });
check('receive without department/receiver rejected', noReceiver.status === 400);

const received = await api('PATCH', `/gate-passes/${transferId}/receive`, { token: timeOffice2, body: { guardName: 'Binu', departmentId: d2, receiverId: r2 } });
check('destination receives transfer → completed', received.status === 200 && received.json?.status === 'completed' && received.json?.receivedLog?.receiverUser?.name === 'Staff Two');

const reReceive = await api('PATCH', `/gate-passes/${transferId}/receive`, { token: timeOffice2, body: { guardName: 'Binu', departmentId: d2, receiverId: r2 } });
check('double receive rejected', reReceive.status === 400);

const crossInward = await api('POST', '/gate-passes/inward', {
  token: timeOffice2,
  body: {
    branchId: b1, departmentId: d1, receiverId: managerUser.json.id, inwardType: 'non_returnable',
    carriedBy: 'Courier Guy', items: [{ itemName: 'Boxes', quantity: 1, unit: 'box' }],
  },
});
check('time_office cannot log direct inward for another branch', crossInward.status === 403);

// ─── Returnable transfer: receive → send-back approval → return out → return ──
const rTransfer = await api('POST', '/gate-passes', {
  token: manager,
  body: {
    type: 'outward', direction: 'internal', destinationBranch: b2,
    returnable: true, purpose: 'Projector for conference', expectedReturnDate: '2099-01-01T00:00:00Z',
    items: [{ itemName: 'Projector', quantity: 1, unit: 'pcs' }],
  },
});
const rId = rTransfer.json?.id;
check('manager creates returnable transfer', rTransfer.status === 201 && rTransfer.json?.status === 'approved');

await api('PATCH', `/gate-passes/${rId}/log-outward`, { token: timeOffice, body: { guardName: 'Ajay' } });
const rReceived = await api('PATCH', `/gate-passes/${rId}/receive`, { token: timeOffice2, body: { guardName: 'Binu', departmentId: d2, receiverId: r2 } });
check('returnable transfer received → stays in_transit', rReceived.status === 200 && rReceived.json?.status === 'in_transit');

const earlyBack = await api('PATCH', `/gate-passes/${rId}/log-inward`, {
  token: timeOffice, body: { guardName: 'Ajay', returns: [{ index: 0, quantity: 1 }] },
});
check('source cannot log return before destination marks it out', earlyBack.status === 400);

const wrongApprover = await api('PATCH', `/gate-passes/${rId}/return-request`, { token: manager });
check('source-branch manager cannot approve the send-back', wrongApprover.status === 403);

const sendBack = await api('PATCH', `/gate-passes/${rId}/return-request`, { token: staff2 });
check('receiver approves send-back', sendBack.status === 200 && !!sendBack.json?.returnRequest);

const wrongReturnOut = await api('PATCH', `/gate-passes/${rId}/return-outward`, { token: timeOffice, body: { guardName: 'Ajay' } });
check('source gate cannot mark the return out', wrongReturnOut.status === 403);

const returnOut = await api('PATCH', `/gate-passes/${rId}/return-outward`, { token: timeOffice2, body: { guardName: 'Binu' } });
check('destination gate marks return out', returnOut.status === 200 && !!returnOut.json?.returnOutwardLog);

const backHome = await api('PATCH', `/gate-passes/${rId}/log-inward`, {
  token: timeOffice, body: { guardName: 'Ajay', returns: [{ index: 0, quantity: 1 }] },
});
check('source logs full return → completed', backHome.status === 200 && backHome.json?.status === 'completed');

const dupUser = await api('POST', '/users', {
  token: admin,
  body: { name: 'Dup', email: 'MANAGER@test.com', password: 'x', role: 'staff', branch: b1, departmentId: d1 },
});
check('duplicate email rejected (case-insensitive)', dupUser.status === 400);

const deact = await api('DELETE', `/users/${staffUser.json.id}`, { token: admin });
check('admin deactivates user', deact.status === 200);
const deadLogin = await api('POST', '/auth/login', { body: { email: 'staff@test.com', password: 'secret1' } });
check('deactivated user cannot log in', deadLogin.status === 401);

// ─── Done ─────────────────────────────────────────────────────────────────────
console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} SMOKE TEST(S) FAILED`);
await client.db(SMOKE_DB).dropDatabase();
await client.close();
process.exit(failures === 0 ? 0 : 1);
