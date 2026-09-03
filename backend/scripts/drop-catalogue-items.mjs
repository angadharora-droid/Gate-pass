// Remove the bulk-imported Excel item catalogue from the items master RIGHT
// NOW, without waiting for a backend restart. Runs exactly the same cleanup
// the server performs on boot (dropSeededItems in data/db.js): catalogue rows
// (source 'ids') that were never used on a pass are deleted; the ones that
// WERE used on a pass are kept. Idempotent — re-running is a no-op.
//
// Usage:
//   node scripts/drop-catalogue-items.mjs
//
// Needs MONGODB_URI (and optionally MONGODB_DB) pointing at the REAL database
// — put them in backend/.env, or export them in the shell, before running.
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { connectDb, dbc } from '../data/db.js';

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is not set — point it at the production Atlas cluster before running this.');
  process.exit(1);
}

const probe = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
await probe.connect();
const before = probe.db(process.env.MONGODB_DB || 'gatepass').collection('items');
console.log(`Before: ${await before.countDocuments()} items, of which ${await before.countDocuments({ source: 'ids' })} from the Excel catalogue`);
await probe.close();

await connectDb();   // boots the data layer → runs the catalogue cleanup

const items = dbc('items');
console.log(`After:  ${await items.countDocuments()} items, of which ${await items.countDocuments({ source: 'ids' })} from the Excel catalogue`);
process.exit(0);
