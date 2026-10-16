// READ-ONLY consistency check for pass visibility and the dashboard counts,
// run against whatever database MONGODB_URI / MONGODB_DB point at:
//
//   1. For every user, the database filter (scopeFilter) must select exactly
//      the passes the in-code rule (canSeePass) allows.
//   2. For every user, the badge counts the stats route builds (totals counted
//      by MongoDB + open passes fetched with STATS_PROJECTION) must equal the
//      counts computed from every visible pass in full.
//
// Writes nothing. Exits 1 on any mismatch. Run with: npm run check:scope
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import {
  OPEN_STATUSES, canSeePass, scopeFilter, withScope, STATS_PROJECTION, computeStats, countsOf,
} from '../lib/passRules.js';

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is not set — put it in backend/.env.');
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'gatepass');
const passesCol = db.collection('gatePasses');

const [passes, users] = await Promise.all([
  passesCol.find({}, { projection: { _id: 0 } }).toArray(),
  db.collection('users').find({}, { projection: { _id: 0, passwordHash: 0 } }).toArray(),
]);
console.log(`${passes.length} passes, ${users.length} users\n`);

const now = new Date();
let mismatches = 0;
for (const user of users) {
  const label = `${user.name} (${(user.roles?.length ? user.roles : [user.role]).join('+')})`;
  const scope = scopeFilter(user);

  // 1. Visibility
  const expected = passes.filter(p => canSeePass(p, user));
  const expectedIds = new Set(expected.map(p => p.id));
  const actualIds = new Set((await passesCol.find(scope, { projection: { _id: 0, id: 1 } }).toArray()).map(p => p.id));
  const missing = [...expectedIds].filter(id => !actualIds.has(id));
  const extra = [...actualIds].filter(id => !expectedIds.has(id));

  // 2. Badge counts
  const [groups, openPasses] = await Promise.all([
    passesCol.aggregate([
      { $match: scope },
      { $group: { _id: { status: '$status', type: '$type' }, n: { $sum: 1 } } },
    ]).toArray(),
    passesCol.find(withScope(scope, { status: { $in: OPEN_STATUSES } }), { projection: STATS_PROJECTION }).toArray(),
  ]);
  const viaRoute = computeStats(user, openPasses, groups.map(g => ({ status: g._id.status, type: g._id.type, n: g.n })), now);
  const inFull = computeStats(user, expected, countsOf(expected), now);
  const statDiffs = Object.keys(inFull).filter(k => inFull[k] !== viaRoute[k]);

  const ok = !missing.length && !extra.length && !statDiffs.length;
  if (!ok) mismatches++;
  console.log(`${ok ? '✓' : '✗'} ${label}: sees ${actualIds.size}` +
    (missing.length ? ` · MISSING ${missing.length} (${missing.slice(0, 3).join(', ')})` : '') +
    (extra.length ? ` · EXTRA ${extra.length} (${extra.slice(0, 3).join(', ')})` : '') +
    (statDiffs.length ? ` · STATS DIFFER ${statDiffs.map(k => `${k}: ${inFull[k]}≠${viaRoute[k]}`).join(', ')}` : ''));
}

console.log(mismatches ? `\n${mismatches} USER(S) MISMATCHED` : '\nVISIBILITY AND COUNTS MATCH FOR EVERY USER');
await client.close();
process.exit(mismatches ? 1 : 0);
