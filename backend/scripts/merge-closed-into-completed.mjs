// One-off cleanup: the separate 'closed' status (fully accounted, but with
// write-offs) was merged into 'completed' — the closure records on each pass
// carry the write-off story, so the split status added a distinction nobody
// needed. New code never writes 'closed' and normalizes old rows at read time
// (displayStatusOf); this rewrites the stored rows so the data matches.
//
// Safe to re-run: no-ops once no 'closed' rows remain.
//
// Usage:
//   node scripts/merge-closed-into-completed.mjs           # dry run — prints the plan only
//   node scripts/merge-closed-into-completed.mjs --apply   # actually writes the changes
//
// Needs MONGODB_URI (and optionally MONGODB_DB) pointing at the REAL database
// — put them in backend/.env, or export them in the shell, before running.
import 'dotenv/config';
import { MongoClient } from 'mongodb';

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is not set — point it at the production Atlas cluster before running this.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'gatepass');

const closedRows = await db.collection('gatePasses')
  .find({ status: 'closed' }, { projection: { passNumber: 1, status: 1 } })
  .toArray();

if (!closedRows.length) {
  console.log("No 'closed' passes found — nothing to do.");
} else {
  for (const p of closedRows) console.log(`  ${p.passNumber}: closed → completed`);
  if (APPLY) {
    const res = await db.collection('gatePasses').updateMany(
      { status: 'closed' },
      { $set: { status: 'completed' } },
    );
    console.log(`Updated ${res.modifiedCount} pass(es).`);
  } else {
    console.log(`Dry run — ${closedRows.length} pass(es) would be updated. Re-run with --apply to write.`);
  }
}

await client.close();
