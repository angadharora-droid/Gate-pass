// One-off migration: re-sequence EVERY pass number into ONE chronological
// global sequence starting at 0001. The sequence is shared across all types
// and prefixes — e.g. GPE-ONR-2026-0001 is followed by GPI-INR-2026-0002 —
// instead of each prefix series counting its own 0001, 0002…
//
// New passes already draw from one shared atomic counter (generatePassNumber
// in data/db.js); this brings the EXISTING rows in line: passes are ordered by
// createdAt, numbered 1..N, the letters are recomputed from each pass's stored
// type/direction/returnable (ground truth), and the year segment comes from
// the pass's own createdAt. Afterwards the counter is synced to N so the next
// pass continues the sequence.
//
// NOTE: pass numbers are printed/quoted identifiers — documents printed before
// this run keep showing the old numbers, and audit-log entries keep the number
// that was current when they were written. Run the dry run first and make sure
// that trade-off is fine.
//
// Safe to re-run: a second run finds every number already correct and only
// re-syncs the counter.
//
// Usage:
//   node scripts/resequence-pass-numbers.mjs           # dry run — prints the plan only
//   node scripts/resequence-pass-numbers.mjs --apply   # actually writes the changes
//
// Needs MONGODB_URI (and optionally MONGODB_DB) pointing at the REAL database
// — put them in backend/.env, or export them in the shell, before running.
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { passNumberPrefix, passNumberCode } from '../data/db.js';

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is not set — point it at the production Atlas cluster before running this.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'gatepass');

const passes = await db.collection('gatePasses')
  .find({}, { projection: { id: 1, passNumber: 1, type: 1, direction: 1, returnable: 1, createdAt: 1 } })
  .toArray();

// Chronological order = the order the passes actually happened in. Ties (and
// missing createdAt, which the app never produces) fall back to the old
// number's own sequence, then id, so re-runs are deterministic.
const oldSeq = p => {
  const m = String(p.passNumber || '').match(/(\d+)(?!.*\d)/);
  return m ? Number(m[1]) : 0;
};
passes.sort((a, b) =>
  (new Date(a.createdAt || 0) - new Date(b.createdAt || 0)) ||
  (oldSeq(a) - oldSeq(b)) ||
  String(a.id).localeCompare(String(b.id)));

let changed = 0, skipped = 0;

for (let i = 0; i < passes.length; i++) {
  const p = passes[i];
  const year = p.createdAt ? new Date(p.createdAt).getFullYear() : new Date().getFullYear();
  const newPassNumber =
    `${passNumberPrefix(p.direction)}-${passNumberCode(p.type, !!p.returnable)}-${year}-${String(i + 1).padStart(4, '0')}`;

  if (newPassNumber === p.passNumber) { skipped++; continue; }

  console.log(`${p.passNumber}  →  ${newPassNumber}`);
  changed++;
  if (APPLY) {
    await db.collection('gatePasses').updateOne({ id: p.id }, { $set: { passNumber: newPassNumber } });
  }
}

if (APPLY) {
  // The next pass must continue after the renumbered tail
  await db.collection('counters').updateOne(
    { _id: 'passNumber' },
    { $set: { seq: passes.length } },
    { upsert: true },
  );
}

console.log(`\n${changed} to change, ${skipped} already correct, ${passes.length} passes total.`);
console.log(APPLY
  ? `Applied — counter set to ${passes.length}, so the next pass is number ${String(passes.length + 1).padStart(4, '0')}.`
  : 'Dry run only — re-run with --apply to write these changes.');

await client.close();
