// The agent's policy settings (services/policySettings.js). Mounted at
// /api/settings after sign-in is required.
//
//   GET /api/settings/policy   any signed-in role: values, limits, version, recent changes
//   PUT /api/settings/policy   administrators: { matchThreshold?, priceTolerancePct?,
//                              confidenceFloor?, requireDeliverySlip?, expectedVersion,
//                              reason } (CSRF, audited)

import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { inRequestDeadline } from '../llm/deadline.js';
import { getPolicySettings, savePolicySettings } from '../services/policySettings.js';

const wrap = (handler) => (req, res, next) => Promise.resolve(inRequestDeadline(req, () => handler(req, res, next))).catch(next);

export function createSettingsRouter() {
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get(
    '/policy',
    wrap(async (req, res) => {
      res.json(await getPolicySettings(req.user));
    }),
  );
  router.put(
    '/policy',
    requireRole('admin'),
    wrap(async (req, res) => {
      res.json(await savePolicySettings(req.body, req.user));
    }),
  );
  return router;
}
