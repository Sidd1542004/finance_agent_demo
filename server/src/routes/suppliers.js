// Supplier bank details (simulated): list (masked), propose, approve, reject, and
// an audited reveal of the full details for approvers and administrators.
// Registered on the main API router after sign-in is required.

import { requireRole } from '../auth/middleware.js';
import { listSuppliers, supplierHistory, proposeChange, approveChange, rejectChange, revealBankDetails } from '../services/beneficiaries.js';

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const noWork = (req, res, next) => next();

export function registerSupplierRoutes(api, { work = noWork } = {}) {
  api.get(
    '/suppliers',
    wrap(async (req, res) => {
      res.json({ items: await listSuppliers(req.user) });
    }),
  );

  api.get(
    '/suppliers/:abn/history',
    wrap(async (req, res) => {
      res.json(await supplierHistory(req.params.abn, req.user));
    }),
  );

  // Payers and administrators propose; an approver or administrator who did not propose it approves.
  api.post(
    '/suppliers/:abn/beneficiary-changes',
    requireRole('payer', 'admin'),
    wrap(async (req, res) => {
      res.status(201).json(await proposeChange(req.params.abn, req.body || {}, req.user));
    }),
  );

  api.post(
    '/beneficiary-changes/:id/approve',
    requireRole('approver', 'admin'),
    wrap(async (req, res) => {
      res.json(await approveChange(req.params.id, req.user, req.body?.note));
    }),
  );

  // The full details, to check them: approvers and administrators only, with a
  // reason, rate limited, never cached, and logged. { target: 'pending' | 'current', reason }
  api.post(
    '/suppliers/:abn/bank-details/reveal',
    requireRole('approver', 'admin'),
    work,
    wrap(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await revealBankDetails(req.params.abn, req.body || {}, req.user));
    }),
  );

  // Reject (approver/admin), or withdraw your own proposal.
  api.post(
    '/beneficiary-changes/:id/reject',
    requireRole('payer', 'approver', 'admin'),
    wrap(async (req, res) => {
      res.json(await rejectChange(req.params.id, req.user, req.body?.note));
    }),
  );
}
