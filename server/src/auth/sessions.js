// Sessions: a random token in an http-only cookie; MongoDB keeps only its
// SHA-256, with an expiry (TTL index). Cookie helpers are here too, so no
// cookie-parser dependency is needed.

import { createHash, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { Session, User } from '../models/index.js';

export const COOKIE_NAME = 'foa_session';

export const hashToken = (token) => createHash('sha256').update(String(token), 'utf8').digest('hex');

/** { name: value } from a Cookie header. Malformed pairs are skipped. */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* not valid percent-encoding: skip */
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAgeSeconds, secure, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
    if (maxAgeSeconds <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  return parts.join('; ');
}

const isSecure = (req, setting) => (setting === 'auto' ? Boolean(req.secure) : Boolean(setting));

export function setSessionCookie(req, res, token, { ttlHours, cookieSecure }) {
  res.append('Set-Cookie', serializeCookie(COOKIE_NAME, token, { maxAgeSeconds: ttlHours * 3600, secure: isSecure(req, cookieSecure) }));
}

export function clearSessionCookie(req, res, { cookieSecure }) {
  res.append('Set-Cookie', serializeCookie(COOKIE_NAME, '', { maxAgeSeconds: 0, secure: isSecure(req, cookieSecure) }));
}

/** A new session for a user. Returns the token for the cookie (never stored). */
export async function createSession(userId, { ttlHours, now = new Date() }) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000);
  await Session.create({ tokenHash: hashToken(token), userId, expiresAt, lastSeenAt: now });
  return { token, expiresAt };
}

// The public view of a user: never the password hash or lockout counters.
export const publicUser = (u) => ({ id: String(u._id), email: u.email, name: u.name, roles: [...(u.roles || [])], active: u.active !== false });

/**
 * The signed-in user for a token, or null when the token is unknown, the
 * session expired, or the account is deactivated. Roles are read from the
 * user record each time, so a role change takes effect at once.
 */
export async function userForToken(token, now = new Date()) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const session = await Session.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: now } }).lean();
  if (!session || !mongoose.isValidObjectId(session.userId)) return null;
  const user = await User.findById(session.userId).lean();
  if (!user || user.active === false) return null;
  return { ...publicUser(user), sessionId: String(session._id) };
}

export const revokeToken = (token) => Session.deleteOne({ tokenHash: hashToken(token) });

/** Sign a user out everywhere (deactivated, password reset). `keep`: a session id to leave signed in. */
export const revokeUserSessions = (userId, keep = null) => Session.deleteMany({ userId, ...(keep ? { _id: { $ne: keep } } : {}) });
