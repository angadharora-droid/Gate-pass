import { Router } from 'express';
import { db, logAudit } from '../data/db.js';
import { verifyPassword, signToken } from '../lib/security.js';
import { authMiddleware } from '../middleware/auth.js';

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

function safeUserView(user) {
  const { passwordHash, password, ...safe } = user;
  const branch = db.branches.find(b => b.id === user.branch);
  const dept = user.departmentId ? db.departments.find(d => d.id === user.departmentId) : null;
  return { ...safe, branchName: branch?.name, departmentName: dept?.name || null };
}

// POST /api/auth/login
router.post('/login', rateLimitLogin, (req, res) => {
  const { email, password } = req.body || {};
  const user = typeof email === 'string'
    ? db.users.find(u => u.email === email.toLowerCase().trim())
    : null;

  // Always run a verification (even with a dummy hash) to keep timing uniform,
  // and never reveal whether it was the email or the password that was wrong.
  const ok = user && user.active !== false && verifyPassword(password, user.passwordHash);
  if (!ok) {
    recordFailure(req._loginIp);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  attempts.delete(req._loginIp); // clear throttle on success
  const token = signToken(user.id);
  logAudit('LOGIN', user.id, user.id, { email: user.email });
  res.json({ token, user: safeUserView(user) });
});

// GET /api/auth/me  (requires a valid token)
router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: safeUserView(req.user) });
});

export default router;
