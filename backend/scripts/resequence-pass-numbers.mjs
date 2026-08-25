// One-off migration: re-sequence every pass number so each series (IR / INR /
// OR / ONR) counts its OWN chronological sequence starting at 01 — e.g. the
// first returnable outward pass is GPE-OR-2026-01, and the first inward
// non-returnable is GPE-INR-2026-01, regardless of which came first overall.
// This replaces the earlier scheme where one global sequence was shared across
// all types.
//
// New passes already draw from per-series atomic counters (generatePassNumber
// in data/db.js); this brings the EXISTING rows in line: passes are ordered by
// createdAt, numbered 1..N within their own series, the letters are recomputed
// from each pass's stored type/direction/returnable (ground truth), and the
// year segment comes from the pass's own createdAt. Afterwards each series
// counter is synced so the next pass continues its own sequence, and the old
// shared counter is removed.
//
// NOTE: pass numbers are printed/quoted identifiers — documents printed before
// this run keep showing the old numbers, and audit-log entries keep the number
// that was current when they were written. Run the dry run first and make sure
// that trade-off is fine.
//
// Safe to re-run: a second run finds every number already correct and only
// re-syncs the counters.
//
// Usage:
//   node scripts/resequence-pass-numbers.mjs           # dry run — prints the plan only
//   node scripts/resequence-pass-numbers.mjs --apply   # actually writes the changes
//
// Needs MONGODB_URI (and optionally MONGODB_DB) pointing at the REAL database
// — put them in backend/.env, or export them in the shell, before running.
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { passNumberPrefix, passNumberCode, PASS_NUMBER_CODES } from '../data/db.js';

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

const seriesSeq = Object.fromEntries(PASS_NUMBER_CODES.map(c => [c, 0]));
let changed = 0, skipped = 0;

for (const p of passes) {
  const code = passNumberCode(p.type, !!p.returnable);
  const seq = ++seriesSeq[code];
  const year = p.createdAt ? new Date(p.createdAt).getFullYear() : new Date().getFullYear();
  const newPassNumber =
    `${passNumberPrefix(p.direction)}-${code}-${year}-${String(seq).padStart(2, '0')}`;

  if (newPassNumber === p.passNumber) { skipped++; continue; }

  console.log(`${p.passNumber}  →  ${newPassNumber}`);
  changed++;
  if (APPLY) {
    await db.collection('gatePasses').updateOne({ id: p.id }, { $set: { passNumber: newPassNumber } });
  }
}

if (APPLY) {
  // Each series' next pass must continue after its renumbered tail
  for (const code of PASS_NUMBER_CODES) {
    await db.collection('counters').updateOne(
      { _id: `passNumber:${code}` },
      { $set: { seq: seriesSeq[code] } },
      { upsert: true },
    );
  }
  // The old shared counter is obsolete under the per-series scheme
  await db.collection('counters').deleteOne({ _id: 'passNumber' });
}

console.log(`\n${changed} to change, ${skipped} already correct, ${passes.length} passes total.`);
console.log('Series totals: ' + PASS_NUMBER_CODES.map(c => `${c}=${seriesSeq[c]}`).join('  '));
console.log(APPLY
  ? 'Applied — per-series counters synced, so each series continues its own numbering.'
  : 'Dry run only — re-run with --apply to write these changes.');

await client.close();
