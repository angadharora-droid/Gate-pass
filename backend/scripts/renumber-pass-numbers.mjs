// One-off migration: rewrite every existing pass number into the current
// scheme (see passNumberPrefix / passNumberCode in data/db.js) —
//   GPI = internal (branch transfer)   GPE = external (vendor/person)
//   IR  = inward,  returnable          INR = inward,  non-returnable
//   OR  = outward, returnable          ONR = outward, non-returnable
// e.g. GPI-OR-2026-0001, GPE-INR-2026-0002
//
// The year and sequence number are read straight off the OLD pass number and
// carried over unchanged — only the letters before them are recomputed, from
// each pass's own stored type/direction/returnable fields (ground truth,
// unaffected by whichever numbering scheme was in place when it was created).
//
// Safe to re-run: a pass already in the current format is left untouched, so
// this can be re-run after further scheme tweaks without redoing finished work.
//
// Usage:
//   node scripts/renumber-pass-numbers.mjs           # dry run — prints the plan only
//   node scripts/renumber-pass-numbers.mjs --apply   # actually writes the changes
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
// Matches the year + sequence tail regardless of what prefix/code came before
// it, so this works whether the pass is still in the very first format
// (GP-OIR-2026-0001), last iteration's draft (GP-OR-2026-0001), or already
// current.
const TAIL = /-(\d{4})-(\d+)$/;

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'gatepass');
const passes = await db.collection('gatePasses')
  .find({}, { projection: { id: 1, passNumber: 1, type: 1, direction: 1, returnable: 1 } })
  .toArray();

let changed = 0, skipped = 0, unparsed = 0;

for (const p of passes) {
  const m = String(p.passNumber || '').match(TAIL);
  if (!m) { unparsed++; console.log(`? unparsed passNumber, left alone: ${p.passNumber} (id ${p.id})`); continue; }

  const [, year, seq] = m;
  const newPassNumber = `${passNumberPrefix(p.direction)}-${passNumberCode(p.type, !!p.returnable)}-${year}-${seq}`;

  if (newPassNumber === p.passNumber) { skipped++; continue; }

  console.log(`${p.passNumber}  →  ${newPassNumber}`);
  changed++;
  if (APPLY) {
    await db.collection('gatePasses').updateOne({ id: p.id }, { $set: { passNumber: newPassNumber } });
  }
}

console.log(`\n${changed} to change, ${skipped} already correct, ${unparsed} unparsed.`);
console.log(APPLY ? 'Applied.' : 'Dry run only — re-run with --apply to write these changes.');

await client.close();
