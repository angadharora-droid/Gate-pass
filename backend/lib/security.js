import crypto from 'crypto';

// ─── CONFIG ─────────────────────────────────────────────────────────────────
// In production the secret MUST come from the environment. A stable dev default
// keeps the demo working across restarts without leaking a real secret.
const TOKEN_SECRET = process.env.JWT_SECRET || 'gatepass-dev-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('⚠  JWT_SECRET not set — using insecure dev default. Set JWT_SECRET in production.');
}
const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours

// ─── PASSWORD HASHING (scrypt) ──────────────────────────────────────────────
// Stored format: scrypt$<saltHex>$<hashHex>
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(plain), salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let derived;
  try {
    derived = crypto.scryptSync(String(plain), salt, expected.length);
  } catch {
    return false;
  }
  // Constant-time comparison to avoid timing attacks
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

// ─── SIGNED TOKENS (compact JWT-style: HMAC-SHA256) ─────────────────────────
const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlJson = (obj) => b64url(JSON.stringify(obj));

function sign(data) {
  return b64url(crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest());
}

export function signToken(userId) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = b64urlJson({ sub: userId, iat: now, exp: now + TOKEN_TTL_SECONDS });
  const signature = sign(`${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expectedSig = sign(`${header}.${payload}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!decoded?.sub || !decoded?.exp) return null;
  if (Math.floor(Date.now() / 1000) >= decoded.exp) return null; // expired
  return decoded;
}
