import { dbc, NO_ID } from '../data/db.js';
import { verifyToken } from '../lib/security.js';
import { hasRole } from '../lib/roles.js';

// Authenticates via a signed Bearer token (issued at /api/auth/login).
// The token is cryptographically verified — a client can no longer impersonate
// a user simply by naming their id.
export async function authMiddleware(req, res, next) {
  try {
    const header = req.headers['authorization'] || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return res.status(401).json({ error: 'Unauthorized' });

    const decoded = verifyToken(match[1]);
    if (!decoded) return res.status(401).json({ error: 'Invalid or expired session' });

    const user = await dbc('users').findOne({ id: decoded.sub, active: { $ne: false } }, NO_ID);
    if (!user) return res.status(401).json({ error: 'User not found or inactive' });

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

// A user holding ANY of the wanted roles (primary or secondary) passes.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!hasRole(req.user, ...roles)) {
      return res.status(403).json({ error: `Forbidden: requires role ${roles.join(' or ')}` });
    }
    next();
  };
}

// Branch-scoped check: non-admins can only act within their own branch.
export function requireBranchAccess(getBranchFromReq) {
  return (req, res, next) => {
    if (hasRole(req.user, 'admin')) return next();
    const branch = getBranchFromReq(req);
    if (branch && branch !== req.user.branch) {
      return res.status(403).json({ error: 'Forbidden: outside your branch scope' });
    }
    next();
  };
}
