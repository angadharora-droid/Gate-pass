import { db } from '../data/db.js';
import { verifyToken } from '../lib/security.js';

// Authenticates via a signed Bearer token (issued at /api/auth/login).
// The token is cryptographically verified — a client can no longer impersonate
// a user simply by naming their id.
export function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return res.status(401).json({ error: 'Unauthorized' });

  const decoded = verifyToken(match[1]);
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired session' });

  const user = db.users.find(u => u.id === decoded.sub && u.active !== false);
  if (!user) return res.status(401).json({ error: 'User not found or inactive' });

  req.user = user;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Forbidden: requires role ${roles.join(' or ')}` });
    }
    next();
  };
}

// Branch-scoped check: non-admins can only act within their own branch.
export function requireBranchAccess(getBranchFromReq) {
  return (req, res, next) => {
    if (req.user.role === 'admin') return next();
    const branch = getBranchFromReq(req);
    if (branch && branch !== req.user.branch) {
      return res.status(403).json({ error: 'Forbidden: outside your branch scope' });
    }
    next();
  };
}
