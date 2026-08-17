import { MongoClient } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { hashPassword } from '../lib/security.js';

// ─── ROLES ────────────────────────────────────────────────────────────────────
// admin       → full access: manage users, items, branches, view all passes
// manager     → manage passes for their branch; auto-approve own requests
// staff       → create pass requests for their branch
// time_office → CENTRAL role (not branch-bound): confirms actual physical
//               movement for ALL branches — logs departure (outward) and arrival (inward/return)

// ─── STATUS FLOW ──────────────────────────────────────────────────────────────
// pending      → created by staff, awaiting manager approval
// approved     → manager approved; Time Office must now log physical movement
// in_transit   → Time Office logged OUTWARD departure of returnable item; awaiting return
// partial_return → some items returned and logged by Time Office; rest pending
// completed    → all movement fully confirmed by Time Office
// closed       → fully accounted for, but some items were written off (lost/
//                damaged/etc.) by Time Office with a reason instead of returned
// rejected     → denied by manager
//
// Time Office logs TWO things on a pass:
//   outwardLog  → item physically LEFT the premises (stamped by TO for outward passes)
//   inwardLog   → item physically ARRIVED at premises (stamped by TO for inward passes
//                 or for the return leg of a returnable outward pass)

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
  await Promise.all([
    handle.collection('users').createIndex({ id: 1 }, { unique: true }),
    handle.collection('users').createIndex({ email: 1 }, { unique: true }),
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
  { id: 'u1', name: 'Administrator', role: 'admin', branch: 'b1', departmentId: 'd1', email: 'arjun@hotel.com', password: 'admin123', active: true },
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

export const ROLES = ['admin', 'manager', 'staff', 'time_office'];
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
