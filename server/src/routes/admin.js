// Administration: user accounts and roles. Mounted at /api/admin, admin role only.
// (The agent's policy is in routes/settings.js.)
// (Simulated bank settings and "Run due payments now" are added by the
// payment routes; see registerAdminPaymentRoutes in routes/payments.js.)

import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { createUser, listUsers, updateUser, resetPassword } from '../services/users.js';
import { ROLES } from '../models/index.js';

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export function createAdminRouter() {
  const router = Router();
  router.use(requireRole('admin'));

  router.get(
    '/users',
    wrap(async (req, res) => {
      res.json({ items: await listUsers(), roles: ROLES });
    }),
  );

  router.post(
    '/users',
    wrap(async (req, res) => {
      const { email, name, password, roles } = req.body || {};
      res.status(201).json(await createUser({ email, name, password, roles: roles || [] }, req.user));
    }),
  );

  router.patch(
    '/users/:id',
    wrap(async (req, res) => {
      const { name, roles, active } = req.body || {};
      res.json(await updateUser(req.params.id, { name, roles, active }, req.user));
    }),
  );

  router.post(
    '/users/:id/password',
    wrap(async (req, res) => {
      await resetPassword(req.params.id, req.body?.password, req.user);
      res.json({ ok: true });
    }),
  );

  return router;
}
