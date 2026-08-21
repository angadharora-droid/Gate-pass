import { MongoClient } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { hashPassword } from '../lib/security.js';

// ─── ROLES ────────────────────────────────────────────────────────────────────
// admin       → full access: manage users, items, branches, view all passes
// manager     → manage passes for their branch; auto-approve own requests
// staff       → create pass requests for their branch
// time_office → BRANCH-BOUND gate role: confirms actual physical movement at
//               their own branch's gate only — logs departures/returns as the
//               source branch, and receives internal transfers as the destination

// ─── STATUS FLOW ──────────────────────────────────────────────────────────────
// pending      → created by staff, awaiting manager approval
// approved     → manager approved; source-branch Time Office must now log departure
// in_transit   → items are OUT: a returnable pass awaiting return, or an internal
//                branch transfer awaiting receipt at the destination branch
// partial_return → some items returned and logged by Time Office; rest pending
// completed    → all movement fully confirmed by Time Office
// closed       → fully accounted for, but some items were written off (lost/
//                damaged/etc.) by Time Office with a reason instead of returned
// rejected     → denied by manager
//
// Gate logs on a pass (each stamped at its own branch's gate):
//   outwardLog       → item physically LEFT the source branch (source TO)
//   receivedLog      → internal transfer ARRIVED at the destination branch
//                      (destination TO, recording the receiving department +
//                      receiver — completes a non-returnable transfer)
//   returnRequest    → the RECEIVER approved the items going back (returnable
//                      transfers only; puts the pass in the destination TO's queue)
//   returnOutwardLog → return physically LEFT the destination branch (destination TO)
//   inwardLog        → item ARRIVED back at the source branch (return leg of a
//                      returnable outward pass, or a direct inward gate entry)
//   returnCycles     → archive of finished send-back cycles: when a return
//                      arrives only PARTIALLY, returnRequest/returnOutwardLog
//                      are reset so the destination can run another cycle for
//                      the remaining items; the finished cycle is pushed here.
//
// DISPLAY STAGE: the stored status stays coarse; enrichPass adds a derived
// `displayStatus` (see displayStatusOf in routes/gatePasses.js) so the UI can
// show exactly where the items are: items_out (external), in_transit (between
// branches), at_destination (with the receiver), return_approved, returning.
//
// GATE REGISTERS (Time Office UI): everything is gate-centric — the Outward
// register lists movements LEAVING a branch's gate (dispatches + send-backs),
// the Inward register lists everything ARRIVING (direct inward entries,
// incoming transfers to mark in, returns to log back).

// ─── CONNECTION (MongoDB Atlas) ───────────────────────────────────────────────
// MONGODB_URI must point at a MongoDB Atlas cluster (or any MongoDB instance),
// e.g. mongodb+srv://user:password@cluster0.xxxxx.mongodb.net
let client = null;
let handle = null;

// Collection accessor — everything reads/writes through this.
export function dbc(name) {
  if (!handle) throw new Error('Database not connected — connectDb() must run before handling requests');
  return handle.collection(name);
}

// Mongo's internal _id never leaves the API; records are keyed by their `id` field.
export const NO_ID = { projection: { _id: 0 } };

export async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set. Point it at your MongoDB Atlas cluster (see .env.example).');
  }
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  handle = client.db(process.env.MONGODB_DB || 'gatepass');
  await ensureIndexes();
  await seedIfEmpty();
  return handle;
}

export async function pingDb() {
  try {
    await handle.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

async function ensureIndexes() {
  // Email became OPTIONAL when login IDs were introduced (not every staff
  // member has one) — its unique index must be sparse so several email-less
  // users can coexist. Replace the old non-sparse index if this database
  // predates the change.
  const users = handle.collection('users');
  try {
    const existing = await users.indexes();
    const emailIdx = existing.find(i => i.key?.email === 1 && !i.sparse);
    if (emailIdx) await users.dropIndex(emailIdx.name);
  } catch { /* fresh database — no indexes yet */ }

  await Promise.all([
    users.createIndex({ id: 1 }, { unique: true }),
    users.createIndex({ email: 1 }, { unique: true, sparse: true }),
    users.createIndex({ loginId: 1 }, { unique: true, sparse: true }),
    handle.collection('branches').createIndex({ id: 1 }, { unique: true }),
    handle.collection('departments').createIndex({ id: 1 }, { unique: true }),
    handle.collection('gatePasses').createIndex({ id: 1 }, { unique: true }),
    handle.collection('gatePasses').createIndex({ createdAt: -1 }),
    handle.collection('auditLog').createIndex({ timestamp: -1 }),
  ]);
}

// ─── SEED DATA ────────────────────────────────────────────────────────────────
// Inserted only when the database is empty (first boot against a fresh cluster).
// Minimal bootstrap: one admin account plus the branch/department it belongs to
// (users must belong to a branch, and non-time_office roles need a department).
// Everything else — branches, departments, users, passes — is created by the
// admin from inside the app. The seed password is hashed before insert; change
// it after the first login.
const SEED_USERS = [
  { id: 'u1', name: 'Administrator', role: 'admin', branch: 'b1', departmentId: 'd1', loginId: 'admin', email: 'arjun@hotel.com', password: 'admin123', active: true },
];

const SEED_BRANCHES = [
  { id: 'b1', name: 'Main Branch', location: '', active: true },
];

// Departments are admin-defined per branch; users are assigned to a department
const SEED_DEPARTMENTS = [
  { id: 'd1', branchId: 'b1', name: 'Administration', active: true },
];

function extractSequence(passNumber) {
  if (!passNumber) return 0;
  const m = String(passNumber).match(/(\d+)(?!.*\d)/);
  return m ? Number(m[1]) : 0;
}

async function seedIfEmpty() {
  if (await handle.collection('users').countDocuments() === 0) {
    // Hash seed passwords before insert; user records only ever carry `passwordHash`.
    await handle.collection('users').insertMany(SEED_USERS.map(({ password, ...u }) => ({
      ...u, passwordHash: hashPassword(password),
    })));
  }
  if (await handle.collection('branches').countDocuments() === 0) {
    await handle.collection('branches').insertMany(SEED_BRANCHES.map(b => ({ ...b })));
  }
  if (await handle.collection('departments').countDocuments() === 0) {
    await handle.collection('departments').insertMany(SEED_DEPARTMENTS.map(d => ({ ...d })));
  }
  // Initialise the pass-number counter from whatever passes exist (none on a
  // fresh database → numbering starts at GP-…-0001).
  if (!await handle.collection('counters').findOne({ _id: 'passNumber' })) {
    const passes = await handle.collection('gatePasses').find({}, { projection: { passNumber: 1 } }).toArray();
    const seq = Math.max(0, ...passes.map(p => extractSequence(p.passNumber)));
    await handle.collection('counters').updateOne(
      { _id: 'passNumber' },
      { $setOnInsert: { seq } },
      { upsert: true },
    );
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
// Atomic counter — safe even with concurrent pass creation.
export async function generatePassNumber({ type, direction, returnable } = {}) {
  const doc = await dbc('counters').findOneAndUpdate(
    { _id: 'passNumber' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  const year = new Date().getFullYear();
  const t = type === 'inward' ? 'I' : 'O';
  const d = direction === 'internal' ? 'I' : 'E';
  const r = returnable ? 'R' : 'N';
  return `GP-${t}${d}${r}-${year}-${String(doc.seq).padStart(4, '0')}`;
}

export async function logAudit(action, userId, targetId, details) {
  await dbc('auditLog').insertOne({
    id: uuidv4(),
    action,
    userId,
    targetId,
    details,
    timestamp: new Date().toISOString(),
  });
}

// supermanager → branch-level approver: no department; staff may route any of
// their passes to a supermanager of their branch instead of the department manager
export const ROLES = ['admin', 'supermanager', 'manager', 'staff', 'time_office'];
// Roles that are branch-bound with no department attachment
export const NO_DEPT_ROLES = ['time_office', 'supermanager'];
export const UNITS = ['pcs', 'set', 'kg', 'litre', 'box', 'bag', 'roll', 'pair', 'dozen'];

// Nature of a direct inward entry logged by Security at the gate.
// Same two choices as outward: 'returnable' means the item entered temporarily
// and must go back out later (e.g. a vendor technician's tools).
export const INWARD_TYPES = [
  { id: 'returnable',     label: 'Returnable' },
  { id: 'non_returnable', label: 'Non-Returnable' },
];

export const DOCUMENT_TYPES = ['Invoice', 'Delivery Challan', 'Purchase Order', 'Courier Slip', 'Return Gate Pass', 'None'];
export const CATEGORIES = ['Electronics', 'Furniture', 'Crockery', 'Kitchen Tools', 'Consumable', 'Stationery', 'Linen', 'Cleaning', 'Tools', 'Other'];
