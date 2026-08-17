import express from 'express';
import cors from 'cors';
import authRouter from './routes/auth.js';
import gatePassRouter from './routes/gatePasses.js';
import { branchesRouter, usersRouter, metaRouter, departmentsRouter } from './routes/misc.js';
import { db } from './data/db.js';
import { authMiddleware, requireRole } from './middleware/auth.js';

const app = express();
const PORT = Number(process.env.PORT) || 4000;

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
  next();
});

// Production frontend origin(s), comma-separated — e.g. https://gatepass.vercel.app
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // Allow non-browser requests (no Origin header)
    if (!origin) return cb(null, true);
    // Allow any localhost port for local dev (Vite may auto-pick 3001, etc.)
    if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
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
app.use('/api/meta', metaRouter);

// Audit log (admin only)
app.get('/api/audit', authMiddleware, requireRole('admin'), (req, res) => {
  const logs = db.auditLog
    .map(l => {
      const user = db.users.find(u => u.id === l.userId);
      return { ...l, userName: user?.name || l.userId };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 100);
  res.json(logs);
});

app.get('/api/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

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
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 GatePass API running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});

