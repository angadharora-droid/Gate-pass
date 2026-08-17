import { Router } from 'express';
import { dbc, NO_ID, logAudit } from '../data/db.js';
import { verifyPassword, signToken } from '../lib/security.js';
import { authMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();

// ─── LOGIN RATE LIMITING ──────────────────────────────────────────────────────
// Simple in-memory throttle to blunt brute-force / credential-stuffing. Keyed by
// client IP. Counts only failed attempts; a success clears the counter.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const attempts = new Map(); // ip -> { count, first }

function rateLimitLogin(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = attempts.get(ip);
  if (rec && now - rec.first < WINDOW_MS && rec.count >= MAX_ATTEMPTS) {
    const retryMins = Math.ceil((WINDOW_MS - (now - rec.first)) / 60000);
    return res.status(429).json({ error: `Too many login attempts. Try again in ${retryMins} minute(s).` });
  }
  req._loginIp = ip;
  next();
}

function recordFailure(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first >= WINDOW_MS) attempts.set(ip, { count: 1, first: now });
  else rec.count += 1;
}

async function safeUserView(user) {
  const { passwordHash, password, ...safe } = user;
  const branch = user.branch ? await dbc('branches').findOne({ id: user.branch }, NO_ID) : null;
  const dept = user.departmentId ? await dbc('departments').findOne({ id: user.departmentId }, NO_ID) : null;
  return { ...safe, branchName: branch?.name, departmentName: dept?.name || null };
}

// POST /api/auth/login
router.post('/login', rateLimitLogin, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const user = typeof email === 'string'
    ? await dbc('users').findOne({ email: email.toLowerCase().trim() }, NO_ID)
    : null;

  // Never reveal whether it was the email or the password that was wrong.
  const ok = user && user.active !== false && verifyPassword(password, user.passwordHash);
  if (!ok) {
    recordFailure(req._loginIp);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  attempts.delete(req._loginIp); // clear throttle on success
  const token = signToken(user.id);
  await logAudit('LOGIN', user.id, user.id, { email: user.email });
  res.json({ token, user: await safeUserView(user) });
}));

// GET /api/auth/me  (requires a valid token)
router.get('/me', authMiddleware, asyncHandler(async (req, res) => {
  res.json({ user: await safeUserView(req.user) });
}));

export default router;
