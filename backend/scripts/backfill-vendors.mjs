// One-off backfill: seed the vendors master from vendor names already sitting
// on existing inward gate passes (destinationPerson) — the vendors collection
// only started growing automatically once upsertVendor was wired into
// POST /gate-passes/inward, so anything logged before that never made it in.
//
// Safe to re-run: skips any name already known (by normalized nameKey).
//
// Usage:
//   node scripts/backfill-vendors.mjs           # dry run — prints the plan only
//   node scripts/backfill-vendors.mjs --apply   # actually writes the changes
//
// Needs MONGODB_URI (and optionally MONGODB_DB) pointing at the REAL database
// — put them in backend/.env, or export them in the shell, before running.
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { normalizeItemName } from '../data/db.js';

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is not set — point it at the production Atlas cluster before running this.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'gatepass');

const passes = await db.collection('gatePasses')
  .find(
    { type: 'inward', destinationPerson: { $exists: true, $ne: null, $nin: [''] } },
    { projection: { destinationPerson: 1 } },
  )
  .toArray();

const existingVendors = await db.collection('vendors').find({}, { projection: { nameKey: 1 } }).toArray();
const known = new Set(existingVendors.map(v => v.nameKey));

const toAdd = new Map(); // nameKey -> display name (first spelling seen wins)
for (const p of passes) {
  const name = String(p.destinationPerson || '').trim();
  if (!name) continue;
  const nameKey = normalizeItemName(name);
  if (known.has(nameKey) || toAdd.has(nameKey)) continue;
  toAdd.set(nameKey, name);
}

console.log(`${passes.length} inward passes scanned, ${known.size} vendor(s) already known, ${toAdd.size} new vendor name(s) found:`);
for (const [, name] of toAdd) console.log(`  + ${name}`);

if (APPLY && toAdd.size) {
  const now = new Date().toISOString();
  const docs = [...toAdd].map(([nameKey, name]) => ({
    id: uuidv4(), name, nameKey, active: true, source: 'backfill', addedBy: null, createdAt: now,
  }));
  await db.collection('vendors').insertMany(docs);
}

console.log(`\n${toAdd.size} to add.`);
console.log(APPLY ? 'Applied.' : 'Dry run only — re-run with --apply to write these changes.');

await client.close();
