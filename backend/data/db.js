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
// Seed credentials are plaintext here only for readability; they are hashed
// before insert, so no plaintext password is ever stored.
const SEED_USERS = [
  { id: 'u1', name: 'Arjun Mehta',  role: 'admin',       branch: 'b1', departmentId: 'd1', email: 'arjun@hotel.com',  password: 'admin123', active: true },
  { id: 'u2', name: 'Priya Sharma', role: 'manager',     branch: 'b1', departmentId: 'd2', email: 'priya@hotel.com',  password: 'pass123',  active: true },
  { id: 'u3', name: 'Rohan Desai',  role: 'staff',       branch: 'b2', departmentId: 'd6', email: 'rohan@hotel.com',  password: 'pass123',  active: true },
  { id: 'u4', name: 'Sneha Patil',  role: 'manager',     branch: 'b2', departmentId: 'd5', email: 'sneha@hotel.com',  password: 'pass123',  active: true },
  { id: 'u5', name: 'Vikram Joshi', role: 'staff',       branch: 'b1', departmentId: 'd3', email: 'vikram@hotel.com', password: 'pass123',  active: true },
  // time_office is a central role; department is optional
  { id: 'u6', name: 'Karan Tiwari', role: 'time_office', branch: 'b1', departmentId: null, email: 'karan@hotel.com',  password: 'pass123',  active: true },
  { id: 'u7', name: 'Divya Nair',   role: 'time_office', branch: 'b1', departmentId: null, email: 'divya@hotel.com',  password: 'pass123',  active: true },
];

const SEED_BRANCHES = [
  { id: 'b1', name: 'Grand Hotel – Main',  location: 'Nagpur Central', active: true },
  { id: 'b2', name: 'The Café Annexe',     location: 'Dharampeth',     active: true },
  { id: 'b3', name: 'Banquet Hall – West', location: 'Sitabuldi',      active: true },
];

// Departments are admin-defined per branch; users are assigned to a department
const SEED_DEPARTMENTS = [
  { id: 'd1', branchId: 'b1', name: 'Administration', active: true },
  { id: 'd2', branchId: 'b1', name: 'Maintenance', active: true },
  { id: 'd3', branchId: 'b1', name: 'Housekeeping', active: true },
  { id: 'd4', branchId: 'b1', name: 'Accounts', active: true },
  { id: 'd5', branchId: 'b2', name: 'Kitchen', active: true },
  { id: 'd6', branchId: 'b2', name: 'Service', active: true },
  { id: 'd7', branchId: 'b3', name: 'Banquets', active: true },
];

const SEED_GATE_PASSES = [
  {
    id: 'gp001', passNumber: 'GP-OEN-2026-0001',
    type: 'outward', direction: 'external', status: 'completed',
    createdBy: 'u5', departmentId: 'd3', sourceBranch: 'b1', destinationBranch: null,
    destinationPerson: 'Maintenance Team', returnable: false,
    purpose: 'Used for lobby renovation',
    createdAt: '2026-04-20T09:00:00Z',
    approvedBy: 'u2', approvedAt: '2026-04-20T09:30:00Z', autoApproved: false,
    expectedReturnDate: null, linkedPassId: null,
    earlyReturn: false,
    outwardLog: { loggedAt: '2026-04-20T10:05:00Z', loggedBy: 'u6', guardName: 'Ajay', remarks: 'Items verified and dispatched' },
    inwardLog: null,
    items: [{ itemId: null, itemName: 'Cleaning Supplies', quantity: 5, returnedQuantity: 0, unit: 'litre' }],
    remarks: 'Monthly cleaning supplies',
  },
  {
    id: 'gp002', passNumber: 'GP-OIR-2026-0002',
    type: 'outward', direction: 'internal', status: 'in_transit',
    createdBy: 'u5', departmentId: 'd3', sourceBranch: 'b1', destinationBranch: 'b2',
    destinationPerson: null, returnable: true,
    purpose: 'Weekend event at Café',
    createdAt: '2026-04-28T10:00:00Z',
    approvedBy: 'u2', approvedAt: '2026-04-28T10:45:00Z', autoApproved: false,
    expectedReturnDate: '2026-05-05T18:00:00Z', linkedPassId: null,
    earlyReturn: false,
    outwardLog: { loggedAt: '2026-04-28T11:00:00Z', loggedBy: 'u6', guardName: 'Ajay', remarks: 'Loaded on hotel vehicle' },
    inwardLog: null,
    items: [
      { itemId: null, itemName: 'Dinner Plates',  quantity: 50, returnedQuantity: 0, unit: 'pcs' },
      { itemId: null, itemName: 'Folding Tables', quantity: 10, returnedQuantity: 0, unit: 'pcs' },
    ],
    remarks: 'For Sunday brunch event',
  },
  {
    id: 'gp003', passNumber: 'GP-OER-2026-0003',
    type: 'outward', direction: 'external', status: 'approved',
    createdBy: 'u5', departmentId: 'd3', sourceBranch: 'b1', destinationBranch: null,
    destinationPerson: 'Vikram Joshi (Self)', returnable: true,
    purpose: 'Work from home for client presentation',
    createdAt: '2026-05-01T08:00:00Z',
    approvedBy: null, approvedAt: null, autoApproved: false,
    expectedReturnDate: '2026-05-03T09:00:00Z', linkedPassId: null,
    earlyReturn: false,
    outwardLog: null,
    inwardLog: null,
    items: [{ itemId: null, itemName: 'Laptop Dell XPS', quantity: 1, returnedQuantity: 0, unit: 'pcs' }],
    remarks: '',
  },
  // Inward entries are logged DIRECTLY by Security (time_office) at the gate —
  // no request/approval step. The record is completed the moment it is logged.
  {
    id: 'gp004', passNumber: 'GP-IEN-2026-0004',
    type: 'inward', direction: 'external', status: 'completed',
    createdBy: 'u6', departmentId: 'd2', sourceBranch: null, destinationBranch: 'b1',
    destinationPerson: 'SoundTech Pvt Ltd', returnable: false,
    purpose: 'Non-Returnable — Invoice INV-4471',
    createdAt: '2026-04-25T15:30:00Z',
    approvedBy: null, approvedAt: null, autoApproved: false,
    expectedReturnDate: null, linkedPassId: null,
    outwardLog: null,
    earlyReturn: false,
    inwardType: 'non_returnable',
    documentType: 'Invoice', documentNo: 'INV-4471', barcodeRef: '',
    carriedBy: 'Ramesh (SoundTech)', carrierMobile: '98230 11223',
    receiverId: 'u2',
    inwardLog: { loggedAt: '2026-04-25T15:30:00Z', loggedBy: 'u6', guardName: 'Karan Tiwari', remarks: 'Received from vendor, invoice matched' },
    items: [{ itemId: null, itemName: 'PA System', code: 'PA-2200', quantity: 1, returnedQuantity: 0, unit: 'set', rate: 48500, amount: 48500, serialNo: 'ST-88412', remarks: 'With 2 mics' }],
    remarks: 'Vendor: SoundTech Pvt Ltd',
  },
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
  if (await handle.collection('gatePasses').countDocuments() === 0) {
    await handle.collection('gatePasses').insertMany(SEED_GATE_PASSES.map(p => ({ ...p })));
  }
  // Initialise the pass-number counter from whatever passes exist (seeded or real).
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
