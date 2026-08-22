// One-off migration: relabel every existing pass number's code segment to the
// new scheme (see passNumberCode in data/db.js) —
//   IR = inward, returnable        INR = inward, non-returnable
//   OR = outward, returnable       ONR = outward, non-returnable
// Direction (internal/external) no longer appears in the code; the year and
// sequence number are left exactly as they were, so nothing about the counter
// or ordering changes — only the letters between "GP-" and the year.
//
// Safe to re-run: a pass already in the new format is left untouched.
//
// Usage:
//   node scripts/renumber-pass-numbers.mjs           # dry run — prints the plan only
//   node scripts/renumber-pass-numbers.mjs --apply   # actually writes the changes
//
// Needs MONGODB_URI (and optionally MONGODB_DB) pointing at the REAL database
// — put them in backend/.env, or export them in the shell, before running.
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { passNumberCode } from '../data/db.js';

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is not set — point it at the production Atlas cluster before running this.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const OLD_FORMAT = /^GP-([A-Z]{2,3})-(\d{4})-(\d+)$/;

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'gatepass');
const passes = await db.collection('gatePasses').find({}, { projection: { id: 1, passNumber: 1, type: 1, returnable: 1 } }).toArray();

let changed = 0, skipped = 0, unparsed = 0;

for (const p of passes) {
  const m = String(p.passNumber || '').match(OLD_FORMAT);
  if (!m) { unparsed++; console.log(`? unparsed passNumber, left alone: ${p.passNumber} (id ${p.id})`); continue; }

  const [, , year, seq] = m;
  const newCode = passNumberCode(p.type, !!p.returnable);
  const newPassNumber = `GP-${newCode}-${year}-${seq}`;

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
