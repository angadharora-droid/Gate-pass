import { MongoClient } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { hashPassword } from '../lib/security.js';

// ─── ROLES ────────────────────────────────────────────────────────────────────
// admin       → full access: manage users, items, branches, sees every pass
// supermanager→ branch-level approver (no department); staff may route passes
//               to them; sees routed/decided passes + unrouted pending pool +
//               incoming branch transfers
// manager     → department-level approver; sees their department's passes,
//               anything routed to/decided by them, incoming branch transfers;
//               auto-approves own requests
// staff       → creates pass requests routed to a chosen approver; sees ONLY
//               their own passes and transfer items in their custody
// time_office → BRANCH-BOUND gate role: sees every pass crossing their gate;
//               logs departures/returns as the source branch, receives internal
//               transfers as the destination
// (visibility rules live in scopePasses, routes/gatePasses.js — a user holding
//  several roles sees the union)

// ─── STATUS FLOW ──────────────────────────────────────────────────────────────
// draft        → saved by a self-approving role (manager/supermanager/admin)
//                without deciding it yet; private to its creator until they
//                PATCH /:id/submit-draft, which self-approves it like normal
// pending      → created by staff, awaiting manager approval
// approved     → manager approved; source-branch Time Office must now log departure
// in_transit   → items are OUT: a returnable pass awaiting return, or an internal
//                branch transfer awaiting receipt at the destination branch
// partial_return → part of the pass is accounted for, the rest still out:
//                some items returned at the source gate, OR some written off
//                with a reason at the destination branch (PATCH /close-items)
// completed    → all movement fully accounted for by Time Office — items came
//                back and/or were written off with a reason (the closure
//                records carry the write-off story)
// closed       → LEGACY: old rows where the accounting included write-offs;
//                merged into 'completed' — displayStatusOf and all filters
//                treat it as completed (scripts/merge-closed-into-completed.mjs
//                rewrites stored rows)
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
  await dropSeededItems();
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
    // Items master: searched constantly from the pass forms
    handle.collection('items').createIndex({ id: 1 }, { unique: true }),
    handle.collection('items').createIndex({ nameKey: 1 }),
    handle.collection('items').createIndex({ code: 1 }),
    // Vendors master: searched from the New Inward form
    handle.collection('vendors').createIndex({ id: 1 }, { unique: true }),
    handle.collection('vendors').createIndex({ nameKey: 1 }),
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
  // Items master: NOT seeded. It holds only item names that were actually
  // entered on a gate pass or inward entry in this app (see upsertMasterItems),
  // so the suggestions people see are the things that really move through
  // the gate — not a bulk catalogue.

  // Initialise the per-series pass-number counters — one for each of IR / INR /
  // OR / ONR — from whatever passes exist (none on a fresh database → every
  // series starts at …-01).
  const missingCodes = [];
  for (const code of PASS_NUMBER_CODES) {
    if (!await handle.collection('counters').findOne({ _id: `passNumber:${code}` })) missingCodes.push(code);
  }
  if (missingCodes.length) {
    const passes = await handle.collection('gatePasses')
      .find({}, { projection: { passNumber: 1, type: 1, returnable: 1 } }).toArray();
    for (const code of missingCodes) {
      const seq = Math.max(0, ...passes
        .filter(p => passNumberCode(p.type, !!p.returnable) === code)
        .map(p => extractSequence(p.passNumber)));
      await handle.collection('counters').updateOne(
        { _id: `passNumber:${code}` },
        { $setOnInsert: { seq } },
        { upsert: true },
      );
    }
  }
}

// ─── ONE-TIME CLEANUP: DROP THE BULK-IMPORTED ITEM CATALOGUE ─────────────────
// Earlier builds seeded the items master from an Excel export (~17k rows,
// stored with source: 'ids'). The master is now meant to hold ONLY items that
// were entered on a gate pass / inward entry in this app, so on boot any
// leftover catalogue rows are removed. Rows from the catalogue that WERE used
// on a pass are kept (re-tagged as 'user') so nothing people actually logged
// disappears from the list. Idempotent — a no-op once no 'ids' rows remain.
async function dropSeededItems() {
  const items = handle.collection('items');
  const leftover = await items.countDocuments({ source: 'ids' });
  if (!leftover) return;

  const used = new Set();
  const cursor = handle.collection('gatePasses').find({}, { projection: { 'items.itemName': 1 } });
  for await (const p of cursor) {
    for (const li of p.items || []) {
      const key = normalizeItemName(li.itemName);
      if (key) used.add(key);
    }
  }
  const usedKeys = [...used];
  let kept = 0;
  for (let i = 0; i < usedKeys.length; i += 1000) {
    const { modifiedCount } = await items.updateMany(
      { source: 'ids', nameKey: { $in: usedKeys.slice(i, i + 1000) } },
      { $set: { source: 'user' } },
    );
    kept += modifiedCount;
  }
  const { deletedCount } = await items.deleteMany({ source: 'ids' });
  console.log(`✓ Items master cleanup: removed ${deletedCount} catalogue item(s), kept ${kept} that were used on passes`);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
// Prefix of a pass number — which side of the gate it crosses:
//   GPI = internal (branch-to-branch transfer)   GPE = external (vendor/person)
export function passNumberPrefix(direction) {
  return direction === 'internal' ? 'GPI' : 'GPE';
}

// Code segment of a pass number — type crossed with returnable:
//   IR  = inward,  returnable      INR = inward,  non-returnable
//   OR  = outward, returnable      ONR = outward, non-returnable
export const PASS_NUMBER_CODES = ['IR', 'INR', 'OR', 'ONR'];
export function passNumberCode(type, returnable) {
  return type === 'inward'
    ? (returnable ? 'IR' : 'INR')
    : (returnable ? 'OR' : 'ONR');
}

// Atomic per-series counter — each code (IR / INR / OR / ONR) keeps its own
// sequence starting at 01. Safe even with concurrent pass creation.
export async function generatePassNumber({ type, direction, returnable } = {}) {
  const code = passNumberCode(type, returnable);
  const doc = await dbc('counters').findOneAndUpdate(
    { _id: `passNumber:${code}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  const year = new Date().getFullYear();
  return `${passNumberPrefix(direction)}-${code}-${year}-${String(doc.seq).padStart(2, '0')}`;
}

// Case/space-insensitive identity for item names, so "Dinner Plate" typed on a
// pass matches "DINNER  PLATE" in the master instead of creating a duplicate.
export function normalizeItemName(name) {
  return String(name || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

// Add any names the master doesn't know yet — called whenever a pass or a
// direct inward entry is logged, so the shared list grows organically.
export async function upsertMasterItems(items, userId) {
  for (const li of items || []) {
    const nameKey = normalizeItemName(li.itemName);
    if (!nameKey) continue;
    const exists = await dbc('items').findOne({ nameKey }, NO_ID);
    if (exists) continue;
    await dbc('items').insertOne({
      id: uuidv4(),
      code: li.code?.trim() || '',
      name: li.itemName.trim(),
      nameKey,
      category: '',
      unit: li.unit || 'pcs',
      uom: '',
      active: true,
      source: 'user',
      addedBy: userId || null,
    });
  }
}

// The vendors master is a FIXED list maintained by admins (routes/misc.js).
// Security picks "Received From" from it on inward entries — nothing is added
// automatically. Looks a vendor up by id first, then by normalized name, so
// both a picked suggestion and an exactly-typed known name resolve.
export async function findActiveVendor({ id, name } = {}) {
  const active = { active: { $ne: false } };
  if (id) {
    const byId = await dbc('vendors').findOne({ id, ...active }, NO_ID);
    if (byId) return byId;
  }
  const nameKey = normalizeItemName(name);
  if (!nameKey) return null;
  return dbc('vendors').findOne({ nameKey, ...active }, NO_ID);
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
