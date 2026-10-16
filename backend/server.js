import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import authRouter from './routes/auth.js';
import gatePassRouter from './routes/gatePasses.js';
import { branchesRouter, usersRouter, metaRouter, departmentsRouter, itemsRouter, vendorsRouter } from './routes/misc.js';
import { connectDb, closeDb, pingDb, dbc, NO_ID } from './data/db.js';
import { authMiddleware, requireRole } from './middleware/auth.js';
import { asyncHandler } from './lib/asyncHandler.js';
import { assertTokenSecret } from './lib/security.js';

const app = express();
const PORT = Number(process.env.PORT) || 4000;
// How long in-flight requests get to finish on SIGTERM before we exit anyway.
// Keep it under Railway's RAILWAY_DEPLOYMENT_DRAINING_SECONDS.
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

// Deployed behind a reverse proxy (Railway): trust one hop so req.ip is the
// real client IP from X-Forwarded-For, not the proxy — otherwise the login
// rate limiter lumps every user into a single shared bucket.
app.set('trust proxy', 1);

// Don't advertise the framework.
app.disable('x-powered-by');

// Baseline security headers. (This is a JSON API, so a strict, locked-down CSP
// is appropriate — nothing here renders HTML.)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  // While shutting down, don't let browsers reuse this connection for the
  // next request — it should go to the deployment replacing this one.
  if (shuttingDown) res.setHeader('Connection', 'close');
  next();
});

// gzip/brotli responses — pass lists are large, repetitive JSON.
app.use(compression());

// Production frontend origin(s), comma-separated — e.g. https://gatepass.vercel.app
// Tolerant of trailing slashes and case: a browser Origin header is always
// lowercase with no trailing slash, so normalise what the operator configured.
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || '')
  .split(',').map(s => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // Allow non-browser requests (no Origin header)
    if (!origin) return cb(null, true);
    // Allow any localhost port for local dev (Vite may auto-pick 3001, etc.)
    if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin.toLowerCase())) return cb(null, true);
    return cb(null, false);
  },
}));

// Cap request bodies to limit abuse / accidental huge payloads.
app.use(express.json({ limit: '256kb' }));

app.use('/api/auth', authRouter);
app.use('/api/gate-passes', gatePassRouter);
app.use('/api/branches', branchesRouter);
app.use('/api/departments', departmentsRouter);
app.use('/api/users', usersRouter);
app.use('/api/items', itemsRouter);
app.use('/api/vendors', vendorsRouter);
app.use('/api/meta', metaRouter);

// Audit log (admin only)
app.get('/api/audit', authMiddleware, requireRole('admin'), asyncHandler(async (req, res) => {
  const [entries, users] = await Promise.all([
    dbc('auditLog').find({}, NO_ID).sort({ timestamp: -1 }).limit(100).toArray(),
    dbc('users').find({}, NO_ID).toArray(),
  ]);
  const logs = entries.map(l => {
    const user = users.find(u => u.id === l.userId);
    return { ...l, userName: user?.name || l.userId };
  });
  res.json(logs);
}));

app.get('/api/health', asyncHandler(async (_, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  const dbOk = await pingDb();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'connected' : 'unreachable',
    timestamp: new Date().toISOString(),
  });
}));

// Unknown routes → JSON 404 (not an HTML stack page).
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler — returns JSON and never leaks stack traces to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  // HttpError (lib/httpError.js): a deliberate response, e.g. 409 on a
  // concurrent pass update — its message is written for the user
  if (err?.expose && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Connect to MongoDB Atlas (and seed an empty database) BEFORE accepting
// requests — if the database is unreachable, fail fast with a clear error.
try {
  assertTokenSecret();
  await connectDb();
  console.log('✓ Connected to MongoDB');
  if (ALLOWED_ORIGINS.length) {
    console.log(`✓ CORS allowed origins: ${ALLOWED_ORIGINS.join(', ')} (+ localhost)`);
  } else {
    console.warn('⚠  FRONTEND_ORIGIN not set — only localhost origins allowed; deployed frontends will hit CORS errors.');
  }
} catch (err) {
  console.error('✗ Startup failed:', err.message);
  process.exit(1);
}

const server = app.listen(PORT, () => {
  console.log(`\n🚀 GatePass API running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
// Railway sends SIGTERM when a new deploy replaces this one. Stop accepting
// connections, let in-flight requests finish (a guard half-way through
// logging a pass), then close MongoDB and exit. Railway force-kills after its
// draining window, so this needs RAILWAY_DEPLOYMENT_DRAINING_SECONDS set above
// SHUTDOWN_TIMEOUT_MS, and the start command should be `node server.js` —
// `npm start` can swallow SIGTERM instead of passing it on to node.
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — finishing in-flight requests…`);
  server.close(async () => {
    await closeDb().catch(() => {});
    console.log('✓ Shut down cleanly');
    process.exit(0);
  });
  // Keep-alive sockets with no request in progress would hold close() open
  server.closeIdleConnections?.();
  setTimeout(() => {
    console.warn('⚠  Requests still open after the shutdown timeout — exiting anyway');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

