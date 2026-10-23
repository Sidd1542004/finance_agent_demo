// Who is calling, and may they? Express middleware for the API.
//
//   loadUser      reads the session cookie and sets req.user (or null)
//   requireUser   401 unless signed in
//   requireRole   403 unless the user holds one of the roles
//   csrfGuard     refuses state-changing requests that did not come from the
//                 dashboard itself (custom header + same-origin check)

import { COOKIE_NAME, parseCookies, userForToken } from './sessions.js';

export const CSRF_HEADER = 'x-foa-request';

export const NOT_SIGNED_IN = 'Sign in to continue.';
export const CSRF_REFUSED = 'This request was refused because it did not come from the dashboard. Reload the page and try again.';

export function loadUser() {
  return async (req, res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
      req.user = token ? await userForToken(token) : null;
      req.sessionToken = req.user ? token : null;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const hasRole = (user, ...roles) => Boolean(user) && roles.some((r) => user.roles.includes(r));

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: NOT_SIGNED_IN });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: NOT_SIGNED_IN });
    if (!hasRole(req.user, ...roles)) return res.status(403).json({ error: `This needs the ${roles.join(' or ')} role.` });
    next();
  };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Is this state-changing request from the dashboard? A cross-site form or
 * script cannot add a custom header without a CORS preflight (which this API
 * does not grant), and browsers send Origin / Sec-Fetch-Site, which must say
 * same origin. `allowedOrigins`: extra origins from CORS_ORIGINS.
 */
export function csrfProblem({ method, headers, host, protocol, allowedOrigins = [] }) {
  if (SAFE.has(String(method).toUpperCase())) return null;
  if (headers[CSRF_HEADER] !== '1') return 'missing header';
  const site = headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site) && !(site === 'same-site' && allowedOrigins.length)) return 'cross-site';
  const origin = headers.origin;
  if (origin && origin !== 'null') {
    let o;
    try {
      o = new URL(origin);
    } catch {
      return 'bad origin';
    }
    const sameHost = o.host === host && (!protocol || o.protocol === `${protocol}:`);
    if (!sameHost && !allowedOrigins.includes(o.origin)) return 'cross-origin';
  } else if (origin === 'null') return 'opaque origin';
  return null;
}

export function csrfGuard({ allowedOrigins = [], skip = [] } = {}) {
  return (req, res, next) => {
    if (skip.some((re) => re.test(req.path))) return next();
    const problem = csrfProblem({ method: req.method, headers: req.headers, host: req.get('host'), protocol: req.protocol, allowedOrigins });
    if (problem) return res.status(403).json({ error: CSRF_REFUSED });
    next();
  };
}
