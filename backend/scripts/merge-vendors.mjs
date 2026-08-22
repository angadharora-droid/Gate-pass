// One-off cleanup: merge a duplicate/near-duplicate vendor spelling into a
// canonical one. Deactivates the old vendor record (matches how this app
// handles removal everywhere else — branches/departments/users are
// deactivated, never hard-deleted) and repoints any inward pass whose
// destinationPerson used the old spelling, so the underlying data is
// consistent, not just the autocomplete list.
//
// Safe to re-run: no-ops once the old vendor is already inactive.
//
// Usage:
//   node scripts/merge-vendors.mjs "<old name>" "<canonical name>"           # dry run
//   node scripts/merge-vendors.mjs "<old name>" "<canonical name>" --apply   # write changes
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

const args = process.argv.slice(2).filter(a => a !== '--apply');
const APPLY = process.argv.includes('--apply');
const [oldName, canonicalName] = args;
if (!oldName || !canonicalName) {
  console.error('Usage: node scripts/merge-vendors.mjs "<old name>" "<canonical name>" [--apply]');
  process.exit(1);
}

const oldKey = normalizeItemName(oldName);
const canonicalKey = normalizeItemName(canonicalName);
if (oldKey === canonicalKey) {
  console.error('Old and canonical names normalize to the same thing — nothing to merge.');
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'gatepass');

const oldVendor = await db.collection('vendors').findOne({ nameKey: oldKey });
const canonicalVendor = await db.collection('vendors').findOne({ nameKey: canonicalKey });
const affectedPasses = await db.collection('gatePasses')
  .find({ type: 'inward', destinationPerson: oldVendor?.name || oldName }, { projection: { id: 1, passNumber: 1 } })
  .toArray();

console.log(`Old vendor:       ${oldVendor ? `"${oldVendor.name}" (active: ${oldVendor.active !== false})` : 'not found'}`);
console.log(`Canonical vendor: ${canonicalVendor ? `"${canonicalVendor.name}" (already exists)` : `"${canonicalName}" (will be created)`}`);
console.log(`Passes to repoint: ${affectedPasses.length}`);
for (const p of affectedPasses) console.log(`  - ${p.passNumber}`);

if (APPLY) {
  if (!canonicalVendor) {
    await db.collection('vendors').insertOne({
      id: uuidv4(), name: canonicalName.trim(), nameKey: canonicalKey,
      active: true, source: 'merge', addedBy: null, createdAt: new Date().toISOString(),
    });
  }
  if (oldVendor && oldVendor.active !== false) {
    await db.collection('vendors').updateOne({ id: oldVendor.id }, { $set: { active: false } });
  }
  if (affectedPasses.length) {
    await db.collection('gatePasses').updateMany(
      { id: { $in: affectedPasses.map(p => p.id) } },
      { $set: { destinationPerson: canonicalName.trim() } },
    );
  }
}

console.log(APPLY ? '\nApplied.' : '\nDry run only — re-run with --apply to write these changes.');
await client.close();
