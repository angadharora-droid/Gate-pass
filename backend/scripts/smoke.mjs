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

// Every outside party on a pass — inward "Received From" AND the outward "To"
// — must come from the admin-maintained vendor list, so seed the parties the
// flows below send things to.
const seededVendors = {};
for (const name of ['Repair Shop', 'Vendor']) {
  const v = await api('POST', '/vendors', { token: admin, body: { name } });
  check(`vendor "${name}" seeded`, v.status === 201, JSON.stringify(v.json));
  seededVendors[name] = v.json?.id;
}
const freeTextTo = await api('POST', '/gate-passes', {
  token: staff,
  body: {
    type: 'outward', direction: 'external', destinationPerson: 'Random Party',
    purpose: 'Test', approverId: managerUser.json.id,
    items: [{ itemName: 'Office Chair', quantity: 1, unit: 'pcs' }],
  },
});
check('outward "To" not on the vendor list rejected', freeTextTo.status === 400, JSON.stringify(freeTextTo.json));
const noTo = await api('POST', '/gate-passes', {
  token: staff,
  body: {
    type: 'outward', direction: 'external',
    purpose: 'Test', approverId: managerUser.json.id,
    items: [{ itemName: 'Office Chair', quantity: 1, unit: 'pcs' }],
  },
});
check('external outward without a "To" vendor rejected', noTo.status === 400, JSON.stringify(noTo.json));

// ─── Create → approve → log-outward → log-inward (full lifecycle) ────────────
const created = await api('POST', '/gate-passes', {
  token: staff,
  body: {
    // Typed exactly (any case/spacing) with no id — resolves to the list entry
    type: 'outward', direction: 'external', destinationPerson: 'repair shop',
    returnable: true, purpose: 'Chair repair', expectedReturnDate: '2099-01-01T00:00:00Z',
    approverId: managerUser.json.id,
    items: [{ itemName: 'Office Chair', quantity: 4, unit: 'pcs' }],
  },
});
check('staff creates pending pass', created.status === 201 && created.json?.status === 'pending', JSON.stringify(created.json));
check('outward "To" stored under the vendor-list spelling with its id',
  created.json?.destinationPerson === 'Repair Shop' && created.json?.vendorId === seededVendors['Repair Shop'],
  JSON.stringify({ to: created.json?.destinationPerson, vendorId: created.json?.vendorId }));
check('numbering starts at 01 on fresh db', created.json?.passNumber === 'GPE-OR-' + new Date().getFullYear() + '-01', created.json?.passNumber);
const passId = created.json?.id;

const staffApprove = await api('PATCH', `/gate-passes/${passId}/status`, { token: staff, body: { action: 'approve' } });
check('staff cannot approve', staffApprove.status === 403);

const approved = await api('PATCH', `/gate-passes/${passId}/status`, { token: manager, body: { action: 'approve' } });
check('manager approves', approved.status === 200 && approved.json?.status === 'approved');

// ─── Gate lock: the manager can edit an approved pass until Time Office locks
//     it; unlock sends it back to the manager for a fix ───────────────────────
const revisePayload = {
  direction: 'external', destinationPerson: 'Repair Shop', returnable: true,
  purpose: 'Chair repair — rush', expectedReturnDate: '2099-01-01T00:00:00Z',
  items: [{ itemName: 'Office Chair', quantity: 4, unit: 'pcs' }],
};
const editApproved = await api('PATCH', `/gate-passes/${passId}/revise`, { token: manager, body: revisePayload });
check('manager edits approved pass before gate acts', editApproved.status === 200 &&
  editApproved.json?.status === 'approved' && editApproved.json?.revisedAfterApproval === true,
  JSON.stringify(editApproved.json));

const staffEditApproved = await api('PATCH', `/gate-passes/${passId}/revise`, { token: staff, body: revisePayload });
check('staff cannot edit an approved pass', staffEditApproved.status === 403);

const managerLock = await api('PATCH', `/gate-passes/${passId}/gate-lock`, { token: manager, body: { action: 'lock' } });
check('manager cannot lock/unlock', managerLock.status === 403);

const lock = await api('PATCH', `/gate-passes/${passId}/gate-lock`, { token: timeOffice, body: { action: 'lock' } });
check('time office locks approved pass', lock.status === 200 && lock.json?.gateLock?.locked === true);

const editLocked = await api('PATCH', `/gate-passes/${passId}/revise`, { token: manager, body: revisePayload });
check('locked pass cannot be edited by the manager', editLocked.status === 403);

const unlock = await api('PATCH', `/gate-passes/${passId}/gate-lock`, { token: timeOffice, body: { action: 'unlock', remarks: 'Qty mismatch at gate' } });
check('time office unlocks (send back) with note', unlock.status === 200 &&
  unlock.json?.gateLock?.locked === false && unlock.json?.sentBack === true &&
  unlock.json?.gateLock?.remarks === 'Qty mismatch at gate');

const editAfterSendBack = await api('PATCH', `/gate-passes/${passId}/revise`, { token: manager, body: revisePayload });
check('manager fixes sent-back pass (clears the flag)', editAfterSendBack.status === 200 &&
  editAfterSendBack.json?.sentBack === false && editAfterSendBack.json?.revisedAfterApproval === true);

const outward = await api('PATCH', `/gate-passes/${passId}/log-outward`, { token: timeOffice, body: { guardName: 'Ajay' } });
check('time office logs outward → in_transit', outward.status === 200 && outward.json?.status === 'in_transit');

const lockAfterOut = await api('PATCH', `/gate-passes/${passId}/gate-lock`, { token: timeOffice, body: { action: 'lock' } });
check('cannot lock once items left the gate', lockAfterOut.status === 400);

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
check('closure of last item → completed (closed merged into completed)',
  closed.status === 200 && closed.json?.status === 'completed' && closed.json?.closures?.length === 1,
  closed.json?.status);
check('earlyReturn flagged (before 2099)', closed.json?.earlyReturn === true);

// Re-read from DB to confirm the mutation was persisted, not just echoed
const reread = await api('GET', `/gate-passes/${passId}`, { token: admin });
check('mutations persisted to MongoDB', reread.json?.status === 'completed' && reread.json?.items?.[0]?.returnedQuantity === 3 && reread.json?.items?.[0]?.closedQuantity === 1);

// ─── Direct inward by Security ───────────────────────────────────────────────
const inwardDenied = await api('POST', '/gate-passes/inward', { token: staff, body: {} });
check('staff cannot log direct inward', inwardDenied.status === 403);

const inward = await api('POST', '/gate-passes/inward', {
  token: timeOffice,
  body: {
    branchId: b1, departmentId: d1, receiverId: managerUser.json.id, inwardType: 'non_returnable',
    documentType: 'Invoice', documentNo: 'INV-9999', carriedBy: 'Courier Guy',
    gst: 18,
    items: [{ itemName: 'Spare Parts', quantity: 2, unit: 'box' }],
  },
});
check('security logs direct inward → completed', inward.status === 201 && inward.json?.status === 'completed' && inward.json?.inwardLog?.guardName === 'Guard One');
check('inward stores GST % on the pass', inward.json?.gst === 18, JSON.stringify(inward.json?.gst));

const badGst = await api('POST', '/gate-passes/inward', {
  token: timeOffice,
  body: {
    branchId: b1, departmentId: d1, receiverId: managerUser.json.id, inwardType: 'non_returnable',
    carriedBy: 'Courier Guy', gst: 150,
    items: [{ itemName: 'Widget', quantity: 1, unit: 'pcs' }],
  },
});
check('GST % out of range rejected', badGst.status === 400, JSON.stringify(badGst.json));
check('legacy single document folded into documents[]', inward.json?.documents?.length === 1 &&
  inward.json?.documents?.[0]?.type === 'Invoice' && inward.json?.documents?.[0]?.number === 'INV-9999');

// Goods can arrive with several papers at once — blank rows are dropped, the
// legacy documentType/documentNo mirror the FIRST document
const multiDoc = await api('POST', '/gate-passes/inward', {
  token: timeOffice,
  body: {
    branchId: b1, departmentId: d1, receiverId: managerUser.json.id, inwardType: 'non_returnable',
    documents: [
      { type: 'Invoice', number: 'INV-1001' },
      { type: 'Delivery Challan', number: 'DC-22' },
      { type: 'None', number: '' },
    ],
    carriedBy: 'Courier Guy',
    items: [{ itemName: 'Printer Toner', quantity: 1, unit: 'box' }],
  },
});
check('inward accepts multiple documents', multiDoc.status === 201 &&
  multiDoc.json?.documents?.length === 2 &&
  multiDoc.json?.documentType === 'Invoice' && multiDoc.json?.documentNo === 'INV-1001' &&
  multiDoc.json?.purpose?.includes('INV-1001') && multiDoc.json?.purpose?.includes('DC-22'),
  JSON.stringify(multiDoc.json));

// Each series (IR / INR / OR / ONR) keeps its OWN sequence starting at 01:
// the outward pass above took OR-…-01, and these two inward entries start the
// INR series at 01 and 02 rather than continuing a shared count.
const yr = new Date().getFullYear();
check('each pass series numbers independently from 01',
  inward.json?.passNumber === `GPE-INR-${yr}-01` && multiDoc.json?.passNumber === `GPE-INR-${yr}-02`,
  `${inward.json?.passNumber} / ${multiDoc.json?.passNumber}`);

const badDoc = await api('POST', '/gate-passes/inward', {
  token: timeOffice,
  body: {
    branchId: b1, departmentId: d1, receiverId: managerUser.json.id, inwardType: 'non_returnable',
    documents: [{ type: 'None', number: 'X-1' }],
    carriedBy: 'Courier Guy',
    items: [{ itemName: 'Widget', quantity: 1, unit: 'pcs' }],
  },
});
check('document number without a type rejected', badDoc.status === 400);

// ─── Vendors: a fixed list admins maintain; inward must pick from it ─────────
const inwardBase = {
  branchId: b1, departmentId: d1, receiverId: managerUser.json.id, inwardType: 'non_returnable',
  carriedBy: 'Courier Guy', items: [{ itemName: 'Envelopes', quantity: 1, unit: 'box' }],
};
const vendorByGuard = await api('POST', '/vendors', { token: timeOffice, body: { name: 'Blue Dart' } });
check('only admins can add vendors', vendorByGuard.status === 403);
const vendorAdd = await api('POST', '/vendors', { token: admin, body: { name: 'Blue Dart' } });
check('admin adds a vendor', vendorAdd.status === 201 && vendorAdd.json?.name === 'Blue Dart', JSON.stringify(vendorAdd.json));
const vendorDup = await api('POST', '/vendors', { token: admin, body: { name: 'blue  DART' } });
check('duplicate vendor spelling rejected', vendorDup.status === 400);

const unknownVendor = await api('POST', '/gate-passes/inward', { token: timeOffice, body: { ...inwardBase, sourceParty: 'Random Courier' } });
check('inward from a vendor not on the list rejected', unknownVendor.status === 400, JSON.stringify(unknownVendor.json));
const knownVendor = await api('POST', '/gate-passes/inward', { token: timeOffice, body: { ...inwardBase, sourceParty: 'blue dart' } });
check('inward from a listed vendor stored under the list spelling',
  knownVendor.status === 201 && knownVendor.json?.destinationPerson === 'Blue Dart' && knownVendor.json?.vendorId === vendorAdd.json?.id,
  JSON.stringify(knownVendor.json));
const vendorSearch = await api('GET', '/vendors?q=blue', { token: timeOffice });
check('security can search the vendor list', vendorSearch.status === 200 && vendorSearch.json?.length === 1);
// Repair Shop + Vendor (seeded above) + Blue Dart — neither the rejected
// outward "Random Party" nor any inward entry added a name
const vendorsNow = await api('GET', '/vendors?all=true&limit=500', { token: admin });
check('logging passes never adds a vendor', vendorsNow.json?.length === 3, `got ${vendorsNow.json?.length}`);

const vendorRename = await api('PATCH', `/vendors/${vendorAdd.json?.id}`, { token: admin, body: { name: 'Blue Dart Express' } });
const renamedPass = await api('GET', `/gate-passes/${knownVendor.json?.id}`, { token: admin });
check('renaming a vendor updates past inward entries',
  vendorRename.status === 200 && renamedPass.json?.destinationPerson === 'Blue Dart Express', JSON.stringify(renamedPass.json?.destinationPerson));

const vendorDel = await api('DELETE', `/vendors/${vendorAdd.json?.id}`, { token: admin });
const afterDel = await api('GET', '/vendors?q=blue', { token: timeOffice });
const inwardAfterDel = await api('POST', '/gate-passes/inward', { token: timeOffice, body: { ...inwardBase, sourceParty: 'Blue Dart Express', vendorId: vendorAdd.json?.id } });
check('removed vendor leaves the pick list and is rejected on inward',
  vendorDel.status === 200 && afterDel.json?.length === 0 && inwardAfterDel.status === 400);
const adminAll = await api('GET', '/vendors?all=true', { token: admin });
check('admin still sees the removed vendor', adminAll.json?.some(v => v.id === vendorAdd.json?.id && v.active === false));
const readd = await api('POST', '/vendors', { token: admin, body: { name: 'Blue Dart Express' } });
check('re-adding a removed vendor restores it', readd.status === 200 && readd.json?.id === vendorAdd.json?.id && readd.json?.active === true);

// ─── Stats & audit ────────────────────────────────────────────────────────────
const stats = await api('GET', '/gate-passes/meta/stats', { token: admin });
check('stats totals add up', stats.json?.total === 4 && stats.json?.completed === 4, JSON.stringify(stats.json));

// ─── Late alert clears the moment the pass is completed ──────────────────────
const latePass = await api('POST', '/gate-passes', {
  token: manager,
  body: {
    type: 'outward', direction: 'external', destinationPerson: 'Repair Shop',
    returnable: true, purpose: 'Overdue drill', expectedReturnDate: '2020-01-01T00:00:00Z',
    items: [{ itemName: 'Drill Machine', quantity: 1, unit: 'pcs' }],
  },
});
await api('PATCH', `/gate-passes/${latePass.json?.id}/log-outward`, { token: timeOffice, body: { guardName: 'Ajay' } });
const lateOut   = await api('GET', `/gate-passes/${latePass.json?.id}`, { token: admin });
const lateStats = await api('GET', '/gate-passes/meta/stats', { token: timeOffice });
check('past-due pass shows as late while out', lateOut.json?.isOverdue === true && lateStats.json?.overdueReturns === 1,
  JSON.stringify({ isOverdue: lateOut.json?.isOverdue, overdueReturns: lateStats.json?.overdueReturns }));

await api('PATCH', `/gate-passes/${latePass.json?.id}/log-inward`, {
  token: timeOffice, body: { guardName: 'Ajay', returns: [{ index: 0, quantity: 1 }] },
});
const lateDone   = await api('GET', `/gate-passes/${latePass.json?.id}`, { token: admin });
const lateStats2 = await api('GET', '/gate-passes/meta/stats', { token: timeOffice });
check('completed late pass leaves the alerts', lateDone.json?.status === 'completed' &&
  lateDone.json?.isOverdue === false && lateStats2.json?.overdueReturns === 0,
  JSON.stringify({ status: lateDone.json?.status, isOverdue: lateDone.json?.isOverdue, overdueReturns: lateStats2.json?.overdueReturns }));

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

const sendBackAsk = await api('PATCH', `/gate-passes/${rId}/return-request`, { token: staff2, body: { remarks: 'Done with it' } });
check('receiver requests the send-back (not yet approved)',
  sendBackAsk.status === 200 && !!sendBackAsk.json?.sendBackRequest && !sendBackAsk.json?.returnRequest &&
  sendBackAsk.json?.displayStatus === 'return_requested', JSON.stringify(sendBackAsk.json?.sendBackRequest));
const askAgain = await api('PATCH', `/gate-passes/${rId}/return-request`, { token: staff2 });
check('double send-back request refused', askAgain.status === 400);
const outBeforeApproval = await api('PATCH', `/gate-passes/${rId}/return-outward`, { token: timeOffice2, body: { guardName: 'Binu' } });
check('gate cannot mark the return out before a manager approves', outBeforeApproval.status === 400);

// Housekeeping at the second branch has no manager yet → its supermanager decides
const super2User = await api('POST', '/users', {
  token: admin,
  body: { name: 'Super Two', email: 'super2@test.com', password: 'secret1', role: 'supermanager', branch: b2 },
});
check('admin creates supermanager at second branch', super2User.status === 201);
const super2 = await login('super2@test.com', 'secret1');
const askedView = await api('GET', `/gate-passes/${rId}`, { token: staff2 });
check('dept without a manager → the branch supermanager is named as approver',
  askedView.json?.sendBackApprovers?.map(a => a.name).join() === 'Super Two', JSON.stringify(askedView.json?.sendBackApprovers));
const super2Stats = await api('GET', '/gate-passes/meta/stats', { token: super2 });
check('supermanager sees the request in their to-do', super2Stats.json?.sendBacksToApprove === 1, JSON.stringify(super2Stats.json));
const staffReject = await api('PATCH', `/gate-passes/${rId}/return-request/reject`, { token: staff2, body: { reason: 'x' } });
check('receiver cannot reject the request', staffReject.status === 403);
const noReasonReject = await api('PATCH', `/gate-passes/${rId}/return-request/reject`, { token: super2 });
check('reject without a reason refused', noReasonReject.status === 400);
const rejectedAsk = await api('PATCH', `/gate-passes/${rId}/return-request/reject`, { token: super2, body: { reason: 'Still needed' } });
check('supermanager rejects the request → items stay with the receiver',
  rejectedAsk.status === 200 && !rejectedAsk.json?.sendBackRequest && !rejectedAsk.json?.returnRequest &&
  rejectedAsk.json?.sendBackRejections?.[0]?.rejectedByUser?.name === 'Super Two' &&
  rejectedAsk.json?.displayStatus === 'at_destination');

await api('PATCH', `/gate-passes/${rId}/return-request`, { token: staff2 });
const sendBack = await api('PATCH', `/gate-passes/${rId}/return-request`, { token: super2 });
check('supermanager approves the new request',
  sendBack.status === 200 && !!sendBack.json?.returnRequest && !sendBack.json?.sendBackRequest &&
  sendBack.json?.returnRequest?.staffRequest?.requestedByUser?.name === 'Staff Two');

const wrongReturnOut = await api('PATCH', `/gate-passes/${rId}/return-outward`, { token: timeOffice, body: { guardName: 'Ajay' } });
check('source gate cannot mark the return out', wrongReturnOut.status === 403);

const returnOut = await api('PATCH', `/gate-passes/${rId}/return-outward`, { token: timeOffice2, body: { guardName: 'Binu' } });
check('destination gate marks return out', returnOut.status === 200 && !!returnOut.json?.returnOutwardLog);

const backHome = await api('PATCH', `/gate-passes/${rId}/log-inward`, {
  token: timeOffice, body: { guardName: 'Ajay', returns: [{ index: 0, quantity: 1 }] },
});
check('source logs full return → completed', backHome.status === 200 && backHome.json?.status === 'completed');

// ─── Partial send-back: once approved, the destination GATE holds the items ──
const pTransfer = await api('POST', '/gate-passes', {
  token: manager,
  body: {
    type: 'outward', direction: 'internal', destinationBranch: b2,
    returnable: true, purpose: 'AV kit for event', expectedReturnDate: '2099-01-01T00:00:00Z',
    items: [
      { itemName: 'Speaker', quantity: 4, unit: 'pcs' },
      { itemName: 'Mic', quantity: 6, unit: 'pcs' },
    ],
  },
});
const pId = pTransfer.json?.id;
await api('PATCH', `/gate-passes/${pId}/log-outward`, { token: timeOffice, body: { guardName: 'Ajay' } });
await api('PATCH', `/gate-passes/${pId}/receive`, { token: timeOffice2, body: { guardName: 'Binu', departmentId: d2, receiverId: r2 } });

const mgr2User = await api('POST', '/users', {
  token: admin,
  body: { name: 'Manager Two', email: 'manager2@test.com', password: 'secret1', role: 'manager', branch: b2, departmentId: d2 },
});
check('admin creates manager at second branch', mgr2User.status === 201);
const manager2 = await login('manager2@test.com', 'secret1');

const staffOff = await api('PATCH', `/gate-passes/${pId}/close-items`, { token: staff2, body: { closures: [{ index: 1, quantity: 1, reason: 'Damaged' }] } });
check('receiver (staff) cannot write off — managers only', staffOff.status === 403);

const preApprovalOff = await api('PATCH', `/gate-passes/${pId}/close-items`, { token: manager2, body: { closures: [{ index: 1, quantity: 1, reason: 'Damaged' }] } });
check('destination manager writes off before send-back approval', preApprovalOff.status === 200 && preApprovalOff.json?.status === 'partial_return');

await api('PATCH', `/gate-passes/${pId}/return-request`, { token: staff2 });
const deptMgrApprove = await api('PATCH', `/gate-passes/${pId}/return-request`, { token: manager2 });
check('receiving department manager approves the send-back', deptMgrApprove.status === 200 && !!deptMgrApprove.json?.returnRequest);
const postApprovalOff = await api('PATCH', `/gate-passes/${pId}/close-items`, { token: manager2, body: { closures: [{ index: 1, quantity: 1, reason: 'Lost' }] } });
check('no write-off at the destination once send-back is approved', postApprovalOff.status === 400);

// Outstanding now: Speaker 4, Mic 5
const overSend = await api('PATCH', `/gate-passes/${pId}/return-outward`, {
  token: timeOffice2, body: { guardName: 'Binu', sends: [{ index: 1, quantity: 4 }], closures: [{ index: 1, quantity: 2, reason: 'Damaged' }] },
});
check('gate cannot send + write off more than outstanding', overSend.status === 400);

const nothingOut = await api('PATCH', `/gate-passes/${pId}/return-outward`, { token: timeOffice2, body: { guardName: 'Binu', sends: [] } });
check('gate must send something unless write-offs settle the pass', nothingOut.status === 400);

const partialOut = await api('PATCH', `/gate-passes/${pId}/return-outward`, {
  token: timeOffice2,
  body: { guardName: 'Binu', sends: [{ index: 0, quantity: 2 }, { index: 1, quantity: 3 }], closures: [{ index: 1, quantity: 1, reason: 'Damaged' }] },
});
check('destination gate sends some and writes some off',
  partialOut.status === 200 &&
  partialOut.json?.returnOutwardLog?.items?.length === 2 &&
  partialOut.json?.items?.[1]?.closedQuantity === 2 &&
  partialOut.json?.closures?.some(c => c.at === 'destination_gate'),
  JSON.stringify(partialOut.json?.returnOutwardLog));
// On the way: Speaker 2, Mic 3. Still at destination: Speaker 2, Mic 1.

const overArrive = await api('PATCH', `/gate-passes/${pId}/log-inward`, { token: timeOffice, body: { guardName: 'Ajay', returns: [{ index: 0, quantity: 3 }] } });
check('source cannot receive more than the destination sent', overArrive.status === 400);

const closeAtDest = await api('PATCH', `/gate-passes/${pId}/log-inward`, {
  token: timeOffice, body: { guardName: 'Ajay', returns: [{ index: 0, quantity: 2 }], closures: [{ index: 1, quantity: 4, reason: 'Lost' }] },
});
check('source cannot close items still at the destination', closeAtDest.status === 400);

const pArrived = await api('PATCH', `/gate-passes/${pId}/log-inward`, {
  token: timeOffice,
  body: { guardName: 'Ajay', returns: [{ index: 0, quantity: 2 }, { index: 1, quantity: 2 }], closures: [{ index: 1, quantity: 1, reason: 'Lost' }] },
});
check('partial arrival → partial_return, fresh send-back cycle opens',
  pArrived.status === 200 && pArrived.json?.status === 'partial_return' &&
  !pArrived.json?.returnRequest && !pArrived.json?.returnOutwardLog && pArrived.json?.returnCycles?.length === 1);
// Still at destination: Speaker 2, Mic 1

const reOff = await api('PATCH', `/gate-passes/${pId}/close-items`, { token: manager2, body: { closures: [{ index: 1, quantity: 1, reason: 'Consumed / Used up' }] } });
check('destination manager can write off again on the new cycle', reOff.status === 200);
const directApprove = await api('PATCH', `/gate-passes/${pId}/return-request`, { token: manager2 });
check('manager can approve directly, with no request first',
  directApprove.status === 200 && !!directApprove.json?.returnRequest && !directApprove.json?.returnRequest?.staffRequest);
const restOut = await api('PATCH', `/gate-passes/${pId}/return-outward`, { token: timeOffice2, body: { guardName: 'Binu' } });
check('return out without counts sends everything left',
  restOut.status === 200 && restOut.json?.returnOutwardLog?.items?.length === 1 && restOut.json?.returnOutwardLog?.items?.[0]?.quantity === 2);
const pFinal = await api('PATCH', `/gate-passes/${pId}/log-inward`, { token: timeOffice, body: { guardName: 'Ajay', returns: [{ index: 0, quantity: 2 }] } });
check('last items arrive → completed', pFinal.status === 200 && pFinal.json?.status === 'completed');

// ─── Send-back approval rules: department, lowering quantities ───────────────
const dept3 = await api('POST', '/departments', { token: admin, body: { name: 'Kitchen', branchId: b2 } });
const mgr3User = await api('POST', '/users', {
  token: admin,
  body: { name: 'Manager Three', email: 'manager3@test.com', password: 'secret1', role: 'manager', branch: b2, departmentId: dept3.json?.id },
});
check('admin creates a manager of another department at the second branch', dept3.status === 201 && mgr3User.status === 201);
const manager3 = await login('manager3@test.com', 'secret1');

const mkReturnableTransfer = async (purpose, items) => {
  const t = await api('POST', '/gate-passes', {
    token: manager,
    body: { type: 'outward', direction: 'internal', destinationBranch: b2, returnable: true, purpose, expectedReturnDate: '2099-01-01T00:00:00Z', items },
  });
  await api('PATCH', `/gate-passes/${t.json?.id}/log-outward`, { token: timeOffice, body: { guardName: 'Ajay' } });
  await api('PATCH', `/gate-passes/${t.json?.id}/receive`, { token: timeOffice2, body: { guardName: 'Binu', departmentId: d2, receiverId: r2 } });
  await api('PATCH', `/gate-passes/${t.json?.id}/return-request`, { token: staff2 });
  return t.json?.id;
};

const lId = await mkReturnableTransfer('Bar stock for event', [
  { itemName: 'Candles', quantity: 4, unit: 'pcs' },
  { itemName: 'Water Bottles', quantity: 4, unit: 'pcs' },
]);
const lView = await api('GET', `/gate-passes/${lId}`, { token: staff2 });
check('dept with a manager → that manager is named as approver',
  lView.json?.sendBackApprovers?.map(a => a.name).join() === 'Manager Two', JSON.stringify(lView.json?.sendBackApprovers));
const otherDept = await api('PATCH', `/gate-passes/${lId}/return-request`, { token: manager3 });
check("another department's manager cannot approve the send-back", otherDept.status === 403);
const otherDeptReject = await api('PATCH', `/gate-passes/${lId}/return-request/reject`, { token: manager3, body: { reason: 'x' } });
check("another department's manager cannot reject it either", otherDeptReject.status === 403);
const noReasonLower = await api('PATCH', `/gate-passes/${lId}/return-request`, { token: super2, body: { closures: [{ index: 1, quantity: 2 }] } });
check('lowering a quantity at approval needs a reason', noReasonLower.status === 400);
const lowered = await api('PATCH', `/gate-passes/${lId}/return-request`, {
  token: super2, body: { closures: [{ index: 1, quantity: 2, reason: 'Consumed / Used up' }] },
});
check('supermanager approves as backup, lowering what goes back (original qty kept)',
  lowered.status === 200 && !!lowered.json?.returnRequest && lowered.json?.status === 'partial_return' &&
  lowered.json?.items?.[1]?.closedQuantity === 2 && lowered.json?.items?.[1]?.quantity === 4 &&
  lowered.json?.closures?.some(c => c.at === 'destination'), JSON.stringify(lowered.json?.items));

const aId = await mkReturnableTransfer('Napkins for event', [{ itemName: 'Napkins', quantity: 3, unit: 'pcs' }]);
const allOff = await api('PATCH', `/gate-passes/${aId}/return-request`, {
  token: manager2, body: { closures: [{ index: 0, quantity: 3, reason: 'Consumed / Used up' }] },
});
check('writing everything off at approval completes the pass, nothing to send',
  allOff.status === 200 && allOff.json?.status === 'completed' && !allOff.json?.returnRequest && !allOff.json?.sendBackRequest);

const dupUser = await api('POST', '/users', {
  token: admin,
  body: { name: 'Dup', email: 'MANAGER@test.com', password: 'x', role: 'staff', branch: b1, departmentId: d1 },
});
check('duplicate email rejected (case-insensitive)', dupUser.status === 400);

const deact = await api('DELETE', `/users/${staffUser.json.id}`, { token: admin });
check('admin deactivates user', deact.status === 200);
const deadLogin = await api('POST', '/auth/login', { body: { email: 'staff@test.com', password: 'secret1' } });
check('deactivated user cannot log in', deadLogin.status === 401);

// ─── Login IDs (staff without email) ─────────────────────────────────────────
const noIdUser = await api('POST', '/users', {
  token: admin,
  body: { name: 'No Identifier', password: 'secret1', role: 'staff', branch: b1, departmentId: d1 },
});
check('user without login ID or email rejected', noIdUser.status === 400);

const loginIdUser = await api('POST', '/users', {
  token: admin,
  body: { name: 'Porter One', loginId: 'Porter.One', password: 'secret1', role: 'staff', branch: b1, departmentId: d1 },
});
check('email-less user created with login ID (normalized)', loginIdUser.status === 201 && loginIdUser.json?.loginId === 'porter.one' && loginIdUser.json?.email === undefined);

const idLogin = await api('POST', '/auth/login', { body: { identifier: 'PORTER.ONE', password: 'secret1' } });
check('login by login ID works (case-insensitive)', idLogin.status === 200 && idLogin.json?.user?.loginId === 'porter.one');

const dupLoginId = await api('POST', '/users', {
  token: admin,
  body: { name: 'Dup Porter', loginId: 'porter.one', password: 'x', role: 'staff', branch: b1, departmentId: d1 },
});
check('duplicate login ID rejected', dupLoginId.status === 400);

const badLoginId = await api('POST', '/users', {
  token: admin,
  body: { name: 'Bad Id', loginId: 'has spaces!', password: 'x', role: 'staff', branch: b1, departmentId: d1 },
});
check('malformed login ID rejected', badLoginId.status === 400);

const secondNoEmail = await api('POST', '/users', {
  token: admin,
  body: { name: 'Porter Two', loginId: 'porter.two', password: 'secret1', role: 'staff', branch: b1, departmentId: d1 },
});
check('second email-less user allowed (sparse email index)', secondNoEmail.status === 201);

const seedIdLogin = await api('POST', '/auth/login', { body: { identifier: 'admin', password: 'admin123' } });
check('seed admin can log in by login ID', seedIdLogin.status === 200);

// ─── Supermanager: staff choose who approves their pass ──────────────────────
const superUser = await api('POST', '/users', {
  token: admin,
  body: { name: 'Super One', loginId: 'super.one', password: 'secret1', role: 'supermanager', branch: b1 },
});
check('supermanager created without department', superUser.status === 201 && superUser.json?.departmentId === null);

const superLogin = await api('POST', '/auth/login', { body: { identifier: 'super.one', password: 'secret1' } });
const superToken = superLogin.json?.token;
const porterToken = idLogin.json?.token;   // staff 'porter.one' from the login-ID section

const noApprover = await api('POST', '/gate-passes', {
  token: porterToken,
  body: {
    type: 'outward', direction: 'external', destinationPerson: 'Vendor',
    purpose: 'Test', items: [{ itemName: 'Box', quantity: 1, unit: 'pcs' }],
  },
});
check('staff pass without an approver rejected', noApprover.status === 400);

const routed = await api('POST', '/gate-passes', {
  token: porterToken,
  body: {
    type: 'outward', direction: 'external', destinationPerson: 'Vendor',
    purpose: 'Cutlery polish', approverId: superUser.json.id,
    items: [{ itemName: 'Box', quantity: 1, unit: 'pcs' }],
  },
});
check('staff pass routed to a supermanager', routed.status === 201 && routed.json?.status === 'pending' && routed.json?.approverUser?.name === 'Super One');

const unchosen = await api('PATCH', `/gate-passes/${routed.json?.id}/status`, { token: manager, body: { action: 'approve' } });
check('unchosen manager cannot approve a routed pass', unchosen.status === 403);

const superApprove = await api('PATCH', `/gate-passes/${routed.json?.id}/status`, { token: superToken, body: { action: 'approve' } });
check('chosen supermanager approves', superApprove.status === 200 && superApprove.json?.status === 'approved');

const superOwnPass = await api('POST', '/gate-passes', {
  token: superToken,
  body: {
    type: 'outward', direction: 'external', destinationPerson: 'Vendor',
    purpose: 'Own errand', items: [{ itemName: 'Bag', quantity: 1, unit: 'pcs' }],
  },
});
check('supermanager pass auto-approved', superOwnPass.status === 201 && superOwnPass.json?.status === 'approved' && superOwnPass.json?.autoApproved === true);

const approverList = await api('GET', '/users/approvers', { token: porterToken });
check('staff approver list = own dept manager + branch supermanagers',
  approverList.status === 200 &&
  approverList.json?.some(a => a.id === superUser.json.id) &&
  approverList.json?.some(a => a.id === managerUser.json.id) &&
  approverList.json?.every(a => ['manager', 'supermanager'].includes(a.role)));

// ─── Multi-role: one account acting as supermanager AND time_office ──────────
const dualUser = await api('POST', '/users', {
  token: admin,
  body: { name: 'Dual One', loginId: 'dual.one', password: 'secret1', roles: ['supermanager', 'time_office'], branch: b1 },
});
check('dual-role user created without department',
  dualUser.status === 201 && dualUser.json?.role === 'supermanager' &&
  Array.isArray(dualUser.json?.roles) && dualUser.json.roles.length === 2);

const dualToken = (await api('POST', '/auth/login', { body: { identifier: 'dual.one', password: 'secret1' } })).json?.token;

const routedToDual = await api('POST', '/gate-passes', {
  token: porterToken,
  body: {
    type: 'outward', direction: 'external', destinationPerson: 'Vendor',
    purpose: 'Bulb replacement', approverId: dualUser.json.id,
    items: [{ itemName: 'Bulbs', quantity: 6, unit: 'pcs' }],
  },
});
check('staff can route to a dual-role approver', routedToDual.status === 201);

const dualApprove = await api('PATCH', `/gate-passes/${routedToDual.json?.id}/status`, { token: dualToken, body: { action: 'approve' } });
check('dual-role account approves via its supermanager role', dualApprove.status === 200 && dualApprove.json?.status === 'approved');

const dualOut = await api('PATCH', `/gate-passes/${routedToDual.json?.id}/log-outward`, { token: dualToken, body: { guardName: 'Dual' } });
check('same account marks items out via its time_office role', dualOut.status === 200 && dualOut.json?.status === 'completed');

const approverList2 = await api('GET', '/users/approvers', { token: porterToken });
check('dual-role account listed as approver in the supermanager group',
  approverList2.json?.some(a => a.id === dualUser.json.id && a.role === 'supermanager'));

// ─── Items master ────────────────────────────────────────────────────────────
// No bulk catalogue: the master holds only what was entered on passes here
const itemSearch = await api('GET', '/items?q=charcoal', { token: porterToken });
check('items master is not pre-seeded from a catalogue', itemSearch.status === 200 && itemSearch.json?.length === 0);
const allItems = await api('GET', '/items?limit=50', { token: porterToken });
check('items master holds only the handful of names used on passes',
  allItems.json?.length > 0 && allItems.json.length < 50, `got ${allItems.json?.length}`);

// The 'Bulbs' item free-typed on the routed pass above must have been auto-added
const autoAdded = await api('GET', '/items?q=bulbs', { token: porterToken });
check('free-typed pass items auto-added to the master', autoAdded.json?.some(i => i.name?.toUpperCase() === 'BULBS'));

const addItem1 = await api('POST', '/items', { token: porterToken, body: { name: 'Custom Widget', unit: 'pcs' } });
const addItem2 = await api('POST', '/items', { token: porterToken, body: { name: 'custom  WIDGET', unit: 'box' } });
check('adding an item is idempotent by normalized name',
  addItem1.status === 201 && addItem2.status === 200 && addItem2.json?.id === addItem1.json?.id);

// Admins edit / remove items; a rename also fixes the name on past pass lines
const itemEditByStaff = await api('PATCH', `/items/${addItem1.json?.id}`, { token: porterToken, body: { name: 'Nope' } });
check('only admins can edit items', itemEditByStaff.status === 403);
const bulbsItem = autoAdded.json?.find(i => i.name?.toUpperCase() === 'BULBS');
const itemRename = await api('PATCH', `/items/${bulbsItem?.id}`, { token: admin, body: { name: 'LED Bulbs', code: 'EL-01', unit: 'box' } });
const bulbsPass = await api('GET', `/gate-passes/${routedToDual.json?.id}`, { token: admin });
check('admin renames an item and past passes follow',
  itemRename.status === 200 && itemRename.json?.name === 'LED Bulbs' && itemRename.json?.code === 'EL-01' && itemRename.json?.unit === 'box' &&
  bulbsPass.json?.items?.[0]?.itemName === 'LED Bulbs', JSON.stringify(bulbsPass.json?.items?.[0]));
const itemClash = await api('PATCH', `/items/${addItem1.json?.id}`, { token: admin, body: { name: 'led  bulbs' } });
check('renaming onto an existing item rejected', itemClash.status === 400);
const itemDel = await api('DELETE', `/items/${addItem1.json?.id}`, { token: admin });
const goneSearch = await api('GET', '/items?q=custom%20widget', { token: porterToken });
const adminItems = await api('GET', '/items?all=true&limit=5000', { token: admin });
check('removed item leaves suggestions but admin still sees it',
  itemDel.status === 200 && !goneSearch.json?.some(i => i.id === addItem1.json?.id) &&
  adminItems.json?.some(i => i.id === addItem1.json?.id && i.active === false));
const itemRestore = await api('PATCH', `/items/${addItem1.json?.id}`, { token: admin, body: { active: true } });
check('removed item can be restored', itemRestore.status === 200 && itemRestore.json?.active === true);

// ─── Involvement-based visibility ────────────────────────────────────────────
// Staff see only their own passes; approvers see only what involves them.
const porterList = await api('GET', '/gate-passes', { token: porterToken });
check('staff see only the passes they created',
  porterList.status === 200 && porterList.json?.length === 2 &&
  porterList.json.every(p => p.createdByUser?.id === loginIdUser.json.id));

const superList = await api('GET', '/gate-passes', { token: superToken });
check('supermanager sees only related passes (routed to them + their own)',
  superList.json?.length === 2 &&
  superList.json.every(p => [routed.json?.id, superOwnPass.json?.id].includes(p.id)));

const mgrList = await api('GET', '/gate-passes', { token: manager });
check('manager does not see the unrelated supermanager pass',
  mgrList.status === 200 && mgrList.json?.every(p => p.id !== superOwnPass.json?.id));
check('manager still sees their department staff\'s routed passes',
  mgrList.json?.some(p => p.id === routed.json?.id));

const probe = await api('GET', `/gate-passes/${superOwnPass.json?.id}`, { token: porterToken });
check('staff cannot open an unrelated pass (scoped 404)', probe.status === 404);

// ─── Outward "To" follows the vendor list: pick by id, revise, rename cascade ─
const acme = await api('POST', '/vendors', { token: admin, body: { name: 'Acme Tools' } });
const acmeBody = {
  direction: 'external', destinationPerson: 'Acme Tools', vendorId: acme.json?.id,
  purpose: 'Grinder service', items: [{ itemName: 'Angle Grinder', quantity: 1, unit: 'pcs' }],
};
const acmePass = await api('POST', '/gate-passes', { token: manager, body: { type: 'outward', ...acmeBody } });
check('outward "To" picked by vendor id', acmePass.status === 201 && acmePass.json?.vendorId === acme.json?.id, JSON.stringify(acmePass.json));
const acmeBadRevise = await api('PATCH', `/gate-passes/${acmePass.json?.id}/revise`,
  { token: manager, body: { ...acmeBody, destinationPerson: 'Somebody Else', vendorId: undefined } });
check('revising "To" to a name not on the vendor list rejected', acmeBadRevise.status === 400, JSON.stringify(acmeBadRevise.json));
const acmeInternal = await api('PATCH', `/gate-passes/${acmePass.json?.id}/revise`,
  { token: manager, body: { ...acmeBody, direction: 'internal', destinationBranch: b2 } });
check('switching to an internal transfer drops the vendor',
  acmeInternal.status === 200 && acmeInternal.json?.vendorId == null && acmeInternal.json?.destinationPerson == null, JSON.stringify(acmeInternal.json));
const acmeBack = await api('PATCH', `/gate-passes/${acmePass.json?.id}/revise`, { token: manager, body: acmeBody });
check('revising back to a listed vendor restores it', acmeBack.status === 200 && acmeBack.json?.vendorId === acme.json?.id, JSON.stringify(acmeBack.json));
const acmeRename = await api('PATCH', `/vendors/${acme.json?.id}`, { token: admin, body: { name: 'Acme Tools Ltd' } });
const acmeAfter = await api('GET', `/gate-passes/${acmePass.json?.id}`, { token: admin });
check('renaming a vendor updates past outward passes too',
  acmeRename.status === 200 && acmeAfter.json?.destinationPerson === 'Acme Tools Ltd', JSON.stringify(acmeAfter.json?.destinationPerson));

// ─── Gate reject: Time Office refuses an approved pass at the gate ──────────
// Same window as lock/unlock (approved, items not yet out, source gate only)
// but terminal: the pass ends as 'rejected', the manager's approval stays on
// record and the gate's reason is stored alongside. (The original staff
// account was deactivated above — the porter is still active, same dept.)
const grPass = await api('POST', '/gate-passes', {
  token: porterToken,
  body: {
    type: 'outward', direction: 'external', destinationPerson: 'Repair Shop',
    returnable: false, purpose: 'Scrap monitors', approverId: managerUser.json.id,
    items: [{ itemName: 'Old Monitor', quantity: 2, unit: 'pcs' }],
  },
});
check('staff creates the pass headed for gate rejection', grPass.status === 201 && grPass.json?.status === 'pending', JSON.stringify(grPass.json));
const grId = grPass.json?.id;
const grPending = await api('PATCH', `/gate-passes/${grId}/gate-reject`, { token: timeOffice, body: { remarks: 'Too early' } });
check('gate cannot reject a pass still waiting for approval', grPending.status === 400, JSON.stringify(grPending.json));
const grApproved = await api('PATCH', `/gate-passes/${grId}/status`, { token: manager, body: { action: 'approve' } });
check('manager approves the pass headed for gate rejection', grApproved.status === 200 && grApproved.json?.status === 'approved');
const grByManager = await api('PATCH', `/gate-passes/${grId}/gate-reject`, { token: manager, body: { remarks: 'Changed my mind' } });
check('manager cannot reject at the gate', grByManager.status === 403);
const grWrongGate = await api('PATCH', `/gate-passes/${grId}/gate-reject`, { token: timeOffice2, body: { remarks: 'Not my gate' } });
check("another branch's gate cannot reject it", grWrongGate.status === 403);
const grNoReason = await api('PATCH', `/gate-passes/${grId}/gate-reject`, { token: timeOffice, body: { remarks: '   ' } });
check('gate reject needs a reason', grNoReason.status === 400);
await api('PATCH', `/gate-passes/${grId}/gate-lock`, { token: timeOffice, body: { action: 'lock' } });
const grStatsBefore = await api('GET', '/gate-passes/meta/stats', { token: timeOffice });
const gr = await api('PATCH', `/gate-passes/${grId}/gate-reject`, { token: timeOffice, body: { remarks: 'Monitors at the gate are not the ones on the pass' } });
check('time office rejects a locked approved pass at the gate',
  gr.status === 200 && gr.json?.status === 'rejected' &&
  gr.json?.gateRejection?.remarks === 'Monitors at the gate are not the ones on the pass' &&
  gr.json?.gateRejection?.rejectedByUser?.id === toUser.json?.id &&
  gr.json?.approvedByUser?.id === managerUser.json?.id && gr.json?.sentBack === false,
  JSON.stringify(gr.json));
const grStatsAfter = await api('GET', '/gate-passes/meta/stats', { token: timeOffice });
check('gate rejection counts as rejected and leaves the gate queue',
  grStatsAfter.json?.rejected === (grStatsBefore.json?.rejected || 0) + 1 &&
  grStatsAfter.json?.awaitingOutward === (grStatsBefore.json?.awaitingOutward || 0) - 1,
  JSON.stringify({ before: grStatsBefore.json, after: grStatsAfter.json }));
const grAgain = await api('PATCH', `/gate-passes/${grId}/gate-reject`, { token: timeOffice, body: { remarks: 'Again' } });
check('cannot reject a pass twice', grAgain.status === 400);
const grOut = await api('PATCH', `/gate-passes/${grId}/log-outward`, { token: timeOffice, body: { guardName: 'Ajay' } });
check('rejected pass cannot be marked out', grOut.status === 400);
const grReapprove = await api('PATCH', `/gate-passes/${grId}/status`, { token: manager, body: { action: 'approve' } });
check('manager cannot re-approve a gate-rejected pass', grReapprove.status === 400);
const grAudit = await api('GET', '/audit', { token: admin });
check('gate rejection is audited with the reason',
  grAudit.json?.some(l => l.action === 'GATE_REJECT' && l.details?.passNumber === grPass.json?.passNumber && l.details?.remarks),
  JSON.stringify(grAudit.json?.filter(l => l.action === 'GATE_REJECT')));

// ─── Due date extension: the approving manager pushes Return By out ─────────
// Only while items are still out, by the manager who approved the pass (or an
// admin — or any source-branch approver once that manager can't act). Every
// extension keeps previous → new on the pass; lateness follows the new date.
const localInput = (days) => {
  const d = new Date(Date.now() + days * 864e5);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const lateDue = localInput(-2);
const ddPass = await api('POST', '/gate-passes', {
  token: porterToken,
  body: {
    type: 'outward', direction: 'external', destinationPerson: 'Repair Shop',
    returnable: true, expectedReturnDate: lateDue, purpose: 'Projector repair',
    approverId: managerUser.json.id,
    items: [{ itemName: 'Projector', quantity: 2, unit: 'pcs' }],
  },
});
check('staff creates the returnable pass headed for a due-date extension', ddPass.status === 201, JSON.stringify(ddPass.json));
const ddId = ddPass.json?.id;
const ddUrl = `/gate-passes/${ddId}/extend-due-date`;
await api('PATCH', `/gate-passes/${ddId}/status`, { token: manager, body: { action: 'approve' } });
const ddEarly = await api('PATCH', ddUrl, { token: manager, body: { expectedReturnDate: localInput(5) } });
check('due date cannot be extended before the items go out', ddEarly.status === 400, JSON.stringify(ddEarly.json));
const ddOut = await api('PATCH', `/gate-passes/${ddId}/log-outward`, { token: timeOffice, body: { guardName: 'Ajay' } });
check('late returnable pass marked out', ddOut.status === 200 && ddOut.json?.isOverdue === true && ddOut.json?.approvedByCanAct === true, JSON.stringify(ddOut.json));
const ddByStaff = await api('PATCH', ddUrl, { token: porterToken, body: { expectedReturnDate: localInput(5) } });
check('staff cannot extend a due date', ddByStaff.status === 403);
const ddByGate = await api('PATCH', ddUrl, { token: timeOffice, body: { expectedReturnDate: localInput(5) } });
check('time office cannot extend a due date', ddByGate.status === 403);
const ddBySuper = await api('PATCH', ddUrl, { token: superToken, body: { expectedReturnDate: localInput(5) } });
check('another approver cannot extend while the approving manager can still act', ddBySuper.status === 403, JSON.stringify(ddBySuper.json));
const ddNoDate = await api('PATCH', ddUrl, { token: manager, body: {} });
check('extension needs a new date', ddNoDate.status === 400);
const ddPast = await api('PATCH', ddUrl, { token: manager, body: { expectedReturnDate: localInput(-1) } });
check('extension to a past date rejected', ddPast.status === 400, JSON.stringify(ddPast.json));
const due1 = localInput(3);
const ddExt1 = await api('PATCH', ddUrl, { token: manager, body: { expectedReturnDate: due1, reason: '  Spare part delayed ' } });
const ext1 = ddExt1.json?.dueDateExtensions?.[0];
check('approving manager extends the due date — previous and new both kept',
  ddExt1.status === 200 && ddExt1.json?.expectedReturnDate === due1 && ddExt1.json?.isOverdue === false &&
  ddExt1.json?.dueDateExtensions?.length === 1 && ext1?.from === lateDue && ext1?.to === due1 &&
  ext1?.extendedByUser?.id === managerUser.json?.id && ext1?.reason === 'Spare part delayed',
  JSON.stringify(ddExt1.json));
const ddNotLater = await api('PATCH', ddUrl, { token: manager, body: { expectedReturnDate: localInput(2) } });
check('extension must be later than the current due date', ddNotLater.status === 400, JSON.stringify(ddNotLater.json));
const due2 = localInput(7);
const ddExt2 = await api('PATCH', ddUrl, { token: admin, body: { expectedReturnDate: due2 } });
check('admin extends again — history chains previous → new',
  ddExt2.status === 200 && ddExt2.json?.dueDateExtensions?.length === 2 &&
  ddExt2.json.dueDateExtensions[1].from === due1 && ddExt2.json.dueDateExtensions[1].to === due2,
  JSON.stringify(ddExt2.json?.dueDateExtensions));
const ddAudit = await api('GET', '/audit', { token: admin });
check('due date extensions are audited',
  ddAudit.json?.filter(l => l.action === 'EXTEND_DUE_DATE' && l.details?.passNumber === ddPass.json?.passNumber).length === 2);
const ddBack = await api('PATCH', `/gate-passes/${ddId}/log-inward`,
  { token: timeOffice, body: { guardName: 'Ajay', returns: [{ index: 0, quantity: 2 }] } });
const ddAfter = await api('PATCH', ddUrl, { token: manager, body: { expectedReturnDate: localInput(9) } });
check('no extension once everything is back', ddBack.json?.status === 'completed' && ddAfter.status === 400, JSON.stringify(ddAfter.json));

// The approving manager leaves — their branch's other approvers take over
const tempMgrUser = await mkUser('Manager Temp', 'mtemp@test.com', 'manager', d1);
const tempMgr = await login('mtemp@test.com', 'secret1');
const ddPass2 = await api('POST', '/gate-passes', {
  token: porterToken,
  body: {
    type: 'outward', direction: 'external', destinationPerson: 'Repair Shop',
    returnable: true, expectedReturnDate: localInput(1), purpose: 'Drill repair',
    approverId: tempMgrUser.json?.id,
    items: [{ itemName: 'Drill', quantity: 1, unit: 'pcs' }],
  },
});
await api('PATCH', `/gate-passes/${ddPass2.json?.id}/status`, { token: tempMgr, body: { action: 'approve' } });
await api('PATCH', `/gate-passes/${ddPass2.json?.id}/log-outward`, { token: timeOffice, body: { guardName: 'Ajay' } });
await api('DELETE', `/users/${tempMgrUser.json?.id}`, { token: admin });
const ddFallback = await api('PATCH', `/gate-passes/${ddPass2.json?.id}/extend-due-date`,
  { token: superToken, body: { expectedReturnDate: localInput(4) } });
check('once the approving manager is gone, a source-branch approver can extend',
  ddFallback.status === 200 && ddFallback.json?.approvedByCanAct === false &&
  ddFallback.json?.dueDateExtensions?.length === 1, JSON.stringify(ddFallback.json));

// ─── Visibility & badge counts are computed by the database ─────────────────
// Lists and counts no longer load every pass: visibility is a MongoDB filter
// (scopeFilter). For every role, the list must hold exactly the passes the
// in-code rule (canSeePass) allows, and the badge counts must equal the ones
// computed from those passes in full. A draft is in the fixtures so its
// creator-only rule is covered too.
const { canSeePass, computeStats, countsOf } = await import('../lib/passRules.js');
const draft = await api('POST', '/gate-passes', {
  token: manager,
  body: {
    type: 'outward', direction: 'external', destinationPerson: 'Repair Shop', returnable: false,
    purpose: 'Draft visibility probe', saveAsDraft: true, items: [{ itemName: 'Probe Item', quantity: 1, unit: 'pcs' }],
  },
});
check('manager saves a draft', draft.status === 201 && draft.json?.status === 'draft', JSON.stringify(draft.json));

const everyPass = (await api('GET', '/gate-passes', { token: admin })).json;
const roleTokens = { manager, timeOffice, timeOffice2, staff2, super2, manager2, manager3, superToken, porterToken, dualToken };
for (const [label, token] of Object.entries(roleTokens)) {
  const me = (await api('GET', '/auth/me', { token })).json?.user;
  const expected = everyPass.filter(p => canSeePass(p, me));
  const list = (await api('GET', '/gate-passes', { token })).json;
  const sameIds = Array.isArray(list) && list.length === expected.length &&
    expected.every(p => list.some(l => l.id === p.id));
  check(`${label}: list = exactly the passes the visibility rule allows`, !!me && sameIds,
    `got ${list?.length}, expected ${expected.length}`);
  const stats = (await api('GET', '/gate-passes/meta/stats', { token })).json;
  const full = computeStats(me, expected, countsOf(expected));
  const diff = Object.keys(full).filter(k => full[k] !== stats?.[k]);
  check(`${label}: badge counts match counts over every visible pass`, !!me && !diff.length,
    diff.map(k => `${k}: ${stats?.[k]} vs ${full[k]}`).join(', '));
}
const toList = (await api('GET', '/gate-passes', { token: timeOffice })).json;
const draftMgrList = (await api('GET', '/gate-passes', { token: manager })).json;
check('a draft is visible to its creator only (not the same-branch gate)',
  draftMgrList.some(p => p.id === draft.json?.id) && !toList.some(p => p.id === draft.json?.id));

// ─── Pass list filters run in the database ───────────────────────────────────
const OPEN = ['pending', 'approved', 'in_transit', 'partial_return'];
const openList = (await api('GET', '/gate-passes?open=true', { token: admin })).json;
check('open=true returns exactly the open passes',
  openList.length === everyPass.filter(p => OPEN.includes(p.status)).length && openList.every(p => OPEN.includes(p.status)));

const page = (await api('GET', '/gate-passes?limit=2', { token: admin })).json;
check('limit returns the newest N with hasMore',
  page?.passes?.length === 2 && page.hasMore === true &&
  page.passes[0].id === everyPass[0].id && page.passes[1].id === everyPass[1].id, JSON.stringify(page?.hasMore));

const someNumber = everyPass[3].passNumber;
const byNumber = (await api('GET', `/gate-passes?passNumber=${encodeURIComponent(someNumber.slice(-6).toLowerCase())}`, { token: admin })).json;
check('pass-number search is a case-insensitive substring match', byNumber.some(p => p.passNumber === someNumber));

// The search box: same fields the list page matches on screen
const screenMatch = (p, term) => [
  p.passNumber, p.sourceBranchName, p.destinationBranchName, p.destinationPerson, p.purpose, p.departmentName,
  ...(p.items || []).map(li => li.itemName),
].some(v => v && String(v).toLowerCase().includes(term));
// item name · department name · branch name · outside party
for (const term of ['drill', 'administration', 'second branch', 'repair']) {
  const found = (await api('GET', `/gate-passes?q=${encodeURIComponent(term)}`, { token: admin })).json;
  const want = everyPass.filter(p => screenMatch(p, term));
  check(`search "${term}" matches what the page would match`,
    want.length > 0 && found.length === want.length && want.every(p => found.some(f => f.id === p.id)),
    `got ${found.length}, expected ${want.length}`);
}

// movement is relative to the viewer's branch (movementFor in Badges.jsx)
const me2 = (await api('GET', '/auth/me', { token: timeOffice2 })).json.user;
const list2 = (await api('GET', '/gate-passes', { token: timeOffice2 })).json;
const movementOf = p => (p.type === 'inward' ||
  (p.direction === 'internal' && p.destinationBranch && p.destinationBranch === me2.branch && p.sourceBranch !== me2.branch)) ? 'in' : 'out';
for (const m of ['in', 'out']) {
  const got = (await api('GET', `/gate-passes?movement=${m}`, { token: timeOffice2 })).json;
  const want = list2.filter(p => movementOf(p) === m);
  check(`movement=${m} for a destination gate`, got.length === want.length && want.every(p => got.some(g => g.id === p.id)),
    `got ${got.length}, expected ${want.length}`);
}

const future = new Date(Date.now() + 365 * 864e5).toISOString();
const noneActive = (await api('GET', `/gate-passes?activeFrom=${future}`, { token: admin })).json;
const openOnly = (await api('GET', `/gate-passes?activeFrom=${future}&includeOpen=true`, { token: admin })).json;
check('activity window excludes passes with nothing in it; includeOpen adds open ones back',
  noneActive.length === 0 && openOnly.length === openList.length);
const sinceThird = everyPass[2].createdAt;
const createdSince = (await api('GET', `/gate-passes?from=${encodeURIComponent(sinceThird)}`, { token: admin })).json;
check('from= keeps passes created at or after the bound',
  createdSince.length ===everyPass.filter(p => p.createdAt >= sinceThird).length);
const badDate = await api('GET', '/gate-passes?from=not-a-date', { token: admin });
check('an invalid date is a 400, not a 500', badDate.status === 400, JSON.stringify(badDate.json));
const injected = (await api('GET', '/gate-passes?status[$ne]=completed', { token: admin })).json;
check('query operators cannot be smuggled in through parameters', injected.length === everyPass.length);
const overdueList = (await api('GET', '/gate-passes?overdue=true', { token: admin })).json;
check('overdue=true returns exactly the late passes',
  overdueList.length === everyPass.filter(p => p.isOverdue).length && overdueList.every(p => p.isOverdue));

const gz = await fetch(`${BASE}/gate-passes`, { headers: { Authorization: `Bearer ${admin}`, 'Accept-Encoding': 'gzip' } });
check('pass lists are sent compressed', gz.headers.get('content-encoding') === 'gzip', gz.headers.get('content-encoding'));

// ─── Concurrent updates: no silent overwrites ────────────────────────────────
// Two guards mark the same pass out at the same moment. Without the versioned
// save both could "succeed" and the second overwrite the first; now exactly
// one wins and the other gets a 400 (already logged) or 409 (changed meanwhile).
let raceWinsOk = true;
let conflicts = 0;
for (let i = 0; i < 4; i++) {
  const p = await api('POST', '/gate-passes', {
    token: manager,
    body: { type: 'outward', direction: 'external', destinationPerson: 'Repair Shop', returnable: false,
      purpose: `Race ${i}`, items: [{ itemName: 'Race Item', quantity: 1, unit: 'pcs' }] },
  });
  const tries = await Promise.all([1, 2].map(() =>
    api('PATCH', `/gate-passes/${p.json?.id}/log-outward`, { token: timeOffice, body: { guardName: 'Ajay' } })));
  const wins = tries.filter(t => t.status === 200).length;
  conflicts += tries.filter(t => t.status === 409).length;
  if (wins !== 1 || !tries.every(t => [200, 400, 409].includes(t.status))) raceWinsOk = false;
  if (i === 0) {
    const after = (await api('GET', `/gate-passes/${p.json?.id}`, { token: admin })).json;
    check('a new pass starts at version 1 and each save bumps it', p.json?.version === 1 && after?.version === 2,
      `${p.json?.version} → ${after?.version}`);
  }
}
check(`simultaneous mark-outs: exactly one wins each time (${conflicts} hit the 409 path)`, raceWinsOk);

const repair = (await api('GET', '/vendors?all=true&q=Repair%20Shop', { token: admin })).json?.[0];
const repairPass = everyPass.find(p => p.destinationPerson === 'Repair Shop' && p.status !== 'draft');
const vBefore = (await api('GET', `/gate-passes/${repairPass.id}`, { token: admin })).json.version || 0;
await api('PATCH', `/vendors/${repair.id}`, { token: admin, body: { name: 'Repair Shop Renamed' } });
const vAfter = (await api('GET', `/gate-passes/${repairPass.id}`, { token: admin })).json.version;
await api('PATCH', `/vendors/${repair.id}`, { token: admin, body: { name: 'Repair Shop' } });
check('a vendor rename bumps the version of the passes it rewrites', vAfter === vBefore + 1, `${vBefore} → ${vAfter}`);

// ─── Admin actions are audited ───────────────────────────────────────────────
const auditProbe = await api('POST', '/users', {
  token: admin, body: { name: 'Audit Probe', loginId: 'audit.probe', password: 'probe-pass-1', roles: ['staff'], branch: b1, departmentId: d1 },
});
await api('PATCH', `/users/${auditProbe.json?.id}`, { token: admin, body: { roles: ['manager'], password: 'probe-pass-2' } });
await api('DELETE', `/users/${auditProbe.json?.id}`, { token: admin });
const probeAudit = (await api('GET', '/audit', { token: admin })).json.filter(l => l.targetId === auditProbe.json?.id);
const upd = probeAudit.find(l => l.action === 'UPDATE_USER');
check('creating, editing and deactivating a user are audited',
  ['CREATE_USER', 'UPDATE_USER', 'DEACTIVATE_USER'].every(a => probeAudit.some(l => l.action === a)) &&
  JSON.stringify(upd?.details?.changes?.roles) === JSON.stringify({ from: ['staff'], to: ['manager'] }) &&
  upd?.details?.passwordReset === true, JSON.stringify(probeAudit.map(l => l.details)));
check('user audit entries carry no password material',
  !/probe-pass|passwordHash|scrypt\$/.test(JSON.stringify(probeAudit)));
const dept4 = await api('POST', '/departments', { token: admin, body: { name: 'Audit Dept', branchId: b1 } });
await api('PATCH', `/departments/${dept4.json?.id}`, { token: admin, body: { name: 'Audit Dept 2' } });
const deptAudit = (await api('GET', '/audit', { token: admin })).json.filter(l => l.targetId === dept4.json?.id);
check('department changes are audited with before → after',
  deptAudit.some(l => l.action === 'CREATE_DEPARTMENT') &&
  deptAudit.some(l => l.action === 'UPDATE_DEPARTMENT' && l.details?.changes?.name?.to === 'Audit Dept 2'));

// ─── Production refuses to start on the public dev JWT secret ────────────────
const { spawnSync } = await import('node:child_process');
const secretCheck = (env) => spawnSync(process.execPath, ['--input-type=module', '-e',
  `import { assertTokenSecret } from ${JSON.stringify(new URL('../lib/security.js', import.meta.url).href)}; assertTokenSecret();`,
], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, encoding: 'utf8' });
check('missing JWT_SECRET on Railway stops startup', secretCheck({ RAILWAY_ENVIRONMENT_NAME: 'production' }).status !== 0);
check('missing JWT_SECRET locally only warns', secretCheck({}).status === 0);
check('JWT_SECRET set on Railway starts normally',
  secretCheck({ RAILWAY_ENVIRONMENT_NAME: 'production', JWT_SECRET: 'x'.repeat(40) }).status === 0);

// ─── Done ─────────────────────────────────────────────────────────────────────
console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} SMOKE TEST(S) FAILED`);
await client.db(SMOKE_DB).dropDatabase();
await client.close();
process.exit(failures === 0 ? 0 : 1);
