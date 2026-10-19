// Optional shared password for the whole site (ACCESS_PASSWORD), checked with
// HTTP Basic auth. Any user name is accepted; only the password matters.
//
// Used by the Express app (local, and the API on Vercel) and by middleware.js
// at the repository root (the static dashboard files on Vercel, which never
// reach the Express app). No dependencies beyond node:crypto, so the Vercel
// middleware can import it on its own.

import { createHash, timingSafeEqual } from 'node:crypto';

export const REALM = 'Finance Operations Agent';

// Paths with their own protection that a scheduler calls without a password:
// the daily summary checks CRON_SECRET instead.
export const OPEN_PATHS = [/^\/api\/cron\//];

const digest = (s) => createHash('sha256').update(String(s), 'utf8').digest();

// Timing-safe: both sides are hashed to the same length before comparing, so
// neither the length nor the content of the password leaks through timing.
export function passwordMatches(given, expected) {
  return timingSafeEqual(digest(given ?? ''), digest(expected ?? ''));
}

/** The password from an `Authorization: Basic ...` header, or null. */
export function basicPassword(header) {
  const m = String(header || '').match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : decoded.slice(colon + 1);
}

/** True when the request may go ahead: no password is set, the path is open, or the password is right. */
export function accessAllowed({ password, path, authorization }) {
  if (!password) return true;
  if (OPEN_PATHS.some((re) => re.test(path || ''))) return true;
  const given = basicPassword(authorization);
  return given !== null && passwordMatches(given, password);
}

export const CHALLENGE_HEADERS = { 'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`, 'Cache-Control': 'no-store' };
export const CHALLENGE_TEXT = 'This demo is protected. Enter the access password (any user name).';

/** Express middleware. */
export function requireAccessPassword(password) {
  return (req, res, next) => {
    if (accessAllowed({ password, path: req.path, authorization: req.headers.authorization })) return next();
    res.set(CHALLENGE_HEADERS).status(401).type('text/plain').send(CHALLENGE_TEXT);
  };
}
