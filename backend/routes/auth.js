import { Router } from 'express';
import { dbc, NO_ID, logAudit } from '../data/db.js';
import { verifyPassword, signToken } from '../lib/security.js';
import { authMiddleware } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();

// ─── LOGIN RATE LIMITING ──────────────────────────────────────────────────────
// In-memory throttle that blunts brute-force WITHOUT letting one person's typos
// lock out a whole property: hotels NAT all staff through one public IP, so
// limiting by IP alone turns five failed attempts by ANYONE into a
// building-wide login outage. Failures are counted per IP+account (tight cap),
// with a much coarser per-IP ceiling that still stops credential-stuffing
// sweeps across many accounts. Only failures count; success clears the account.
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_PER_ACCOUNT = 5;        // failures for one email from one IP
const MAX_PER_IP = 30;            // failures across ALL emails from one IP
const attempts = new Map();       // key ("ip" or "ip|email") -> { count, first }

// Drop expired windows so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of attempts) {
    if (now - rec.first >= WINDOW_MS) attempts.delete(key);
  }
}, WINDOW_MS).unref();

function blockedBy(key, max) {
  const rec = attempts.get(key);
  return (rec && Date.now() - rec.first < WINDOW_MS && rec.count >= max) ? rec : null;
}

function rateLimitLogin(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  // `identifier` = login ID or email; `email` kept for older clients
  const who = String(req.body?.identifier ?? req.body?.email ?? '').toLowerCase().trim();
  req._loginIp = ip;
  req._loginKey = `${ip}|${who}`;
  const rec = blockedBy(req._loginKey, MAX_PER_ACCOUNT) || blockedBy(ip, MAX_PER_IP);
  if (rec) {
    const retryMins = Math.ceil((WINDOW_MS - (Date.now() - rec.first)) / 60000);
    return res.status(429).json({ error: `Too many login attempts. Try again in ${retryMins} minute(s).` });
  }
  next();
}

function recordFailure(req) {
  const now = Date.now();
  for (const key of [req._loginKey, req._loginIp]) {
    const rec = attempts.get(key);
    if (!rec || now - rec.first >= WINDOW_MS) attempts.set(key, { count: 1, first: now });
    else rec.count += 1;
  }
}

async function safeUserView(user) {
  const { passwordHash, password, ...safe } = user;
  const branch = user.branch ? await dbc('branches').findOne({ id: user.branch }, NO_ID) : null;
  const dept = user.departmentId ? await dbc('departments').findOne({ id: user.departmentId }, NO_ID) : null;
  return { ...safe, branchName: branch?.name, departmentName: dept?.name || null };
}

// POST /api/auth/login — sign in with a LOGIN ID or an email address.
// Not every staff member has an email, so accounts may carry either (or both).
// Login IDs never contain '@', so the identifier's shape picks the lookup.
router.post('/login', rateLimitLogin, asyncHandler(async (req, res) => {
  const { identifier, email, password } = req.body || {};
  const who = String(identifier ?? email ?? '').toLowerCase().trim();
  const user = who
    ? await dbc('users').findOne(who.includes('@') ? { email: who } : { loginId: who }, NO_ID)
    : null;

  // Never reveal whether it was the identifier or the password that was wrong.
  const ok = user && user.active !== false && verifyPassword(password, user.passwordHash);
  if (!ok) {
    recordFailure(req);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  attempts.delete(req._loginKey); // clear this account's throttle on success
  const token = signToken(user.id);
  await logAudit('LOGIN', user.id, user.id, { identifier: who });
  res.json({ token, user: await safeUserView(user) });
}));

// GET /api/auth/me  (requires a valid token)
router.get('/me', authMiddleware, asyncHandler(async (req, res) => {
  res.json({ user: await safeUserView(req.user) });
}));

export default router;
