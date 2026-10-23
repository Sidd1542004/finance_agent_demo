// Sign in, sign out, who am I, change my password, and the one-time
// first-administrator setup. Mounted at /api/auth.

import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import { config } from '../config.js';
import { passwordMatches } from '../accessAuth.js';
import { createSession, setSessionCookie, clearSessionCookie, revokeToken } from '../auth/sessions.js';
import { requireUser } from '../auth/middleware.js';
import { authenticate, changeOwnPassword, createFirstAdmin, userCount } from '../services/users.js';
import { HttpError, recordAudit } from '../services/runs.js';

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export function createAuthRouter({ auth = config.auth } = {}) {
  const router = Router();
  const { windowMinutes, max } = auth.loginRateLimit;
  const loginLimiter =
    max > 0
      ? rateLimit({
          windowMs: Math.max(1, windowMinutes) * 60000,
          limit: max,
          standardHeaders: 'draft-7',
          legacyHeaders: false,
          message: { error: 'Too many sign-in attempts from this address. Wait a few minutes and try again.' },
        })
      : (req, res, next) => next();

  const startSession = async (req, res, user) => {
    const { token, expiresAt } = await createSession(user.id, { ttlHours: auth.sessionTtlHours });
    setSessionCookie(req, res, token, auth);
    return expiresAt;
  };

  router.get(
    '/me',
    wrap(async (req, res) => {
      const setupRequired = !req.user && (await userCount()) === 0;
      res.set('Cache-Control', 'no-store');
      res.json({
        user: req.user ? { id: req.user.id, email: req.user.email, name: req.user.name, roles: req.user.roles } : null,
        setupRequired,
        setupEnabled: Boolean(auth.setupToken),
      });
    }),
  );

  router.post(
    '/login',
    loginLimiter,
    wrap(async (req, res) => {
      const { email, password } = req.body || {};
      if (!email || !password) throw new HttpError(400, 'Enter your email and password.');
      const user = await authenticate(email, password, auth);
      // A new session every sign-in; any session this browser already had ends.
      if (req.sessionToken) await revokeToken(req.sessionToken);
      const expiresAt = await startSession(req, res, user);
      await recordAudit({ subjectKind: 'user', subjectId: user.id, actor: user.name, actorId: user.id, action: 'signed_in' });
      res.json({ user, expiresAt });
    }),
  );

  router.post(
    '/logout',
    wrap(async (req, res) => {
      if (req.sessionToken) await revokeToken(req.sessionToken);
      clearSessionCookie(req, res, auth);
      if (req.user) await recordAudit({ subjectKind: 'user', subjectId: req.user.id, actor: req.user.name, actorId: req.user.id, action: 'signed_out' });
      res.json({ ok: true });
    }),
  );

  router.post(
    '/password',
    requireUser,
    wrap(async (req, res) => {
      await changeOwnPassword(req.user, req.body?.currentPassword, req.body?.newPassword);
      res.json({ ok: true });
    }),
  );

  // First administrator, when no user exists yet and ADMIN_SETUP_TOKEN is set.
  // `npm run create-admin --prefix server` does the same from a terminal.
  router.post(
    '/setup',
    loginLimiter,
    wrap(async (req, res) => {
      if (!auth.setupToken) throw new HttpError(404, 'Setup through the API is turned off. Run `npm run create-admin --prefix server` instead.');
      if (!passwordMatches(String(req.body?.token || ''), auth.setupToken)) throw new HttpError(401, 'The setup token is incorrect.');
      const user = await createFirstAdmin({ email: req.body?.email, name: req.body?.name, password: req.body?.password });
      const expiresAt = await startSession(req, res, user);
      res.status(201).json({ user, expiresAt });
    }),
  );

  return router;
}
