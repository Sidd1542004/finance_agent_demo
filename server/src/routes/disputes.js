// Queries to suppliers about an invoice's variance (services/supplierDisputes.js).
//
//   GET  /api/invoices/:id/disputes    any signed-in role: the invoice's queries
//   POST /api/invoices/:id/disputes    reviewer, approver, admin: draft one (the model, or the template)
//   PUT  /api/disputes/:id             reviewer, approver, admin: { subject?, body?, expectedVersion }
//   POST /api/disputes/:id/send        reviewer, approver, admin: send it (once)
//   POST /api/disputes/:id/discard     reviewer, approver, admin: { note }
//   POST /api/disputes/:id/resolve     reviewer, approver, admin: { outcome, note }
//
// Every change needs the dashboard's CSRF header (app.js) and is checked again in
// the service against the signed-in person (never anything in the body).

import { requireRole, actorOf } from '../auth/middleware.js';
import { inRequestDeadline } from '../llm/deadline.js';
import { supplierDisputes } from '../services/paymentSystem.js';
import { DISPUTE_ROLES, disputeView } from '../services/supplierDisputes.js';

const wrap = (handler) => (req, res, next) => Promise.resolve(inRequestDeadline(req, () => handler(req, res, next))).catch(next);

export function registerDisputeRoutes(api) {
  const writer = requireRole(...DISPUTE_ROLES);
  api.get(
    '/invoices/:id/disputes',
    wrap(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await supplierDisputes.listDisputes(req.params.id, actorOf(req)));
    }),
  );
  api.post(
    '/invoices/:id/disputes',
    writer,
    wrap(async (req, res) => {
      const { dispute, created } = await supplierDisputes.draftDispute(req.params.id, actorOf(req));
      res.status(created ? 201 : 200).json({ dispute: disputeView(dispute), created });
    }),
  );
  api.put(
    '/disputes/:id',
    writer,
    wrap(async (req, res) => {
      const { subject, body, expectedVersion } = req.body || {};
      res.json({ dispute: disputeView(await supplierDisputes.editDispute(req.params.id, { subject, body, expectedVersion }, actorOf(req))) });
    }),
  );
  api.post(
    '/disputes/:id/send',
    writer,
    wrap(async (req, res) => {
      res.json({ dispute: disputeView(await supplierDisputes.sendDispute(req.params.id, actorOf(req))) });
    }),
  );
  api.post(
    '/disputes/:id/discard',
    writer,
    wrap(async (req, res) => {
      res.json({ dispute: disputeView(await supplierDisputes.discardDispute(req.params.id, req.body?.note, actorOf(req))) });
    }),
  );
  api.post(
    '/disputes/:id/resolve',
    writer,
    wrap(async (req, res) => {
      res.json({ dispute: disputeView(await supplierDisputes.resolveDispute(req.params.id, { outcome: req.body?.outcome, note: req.body?.note }, actorOf(req))) });
    }),
  );
}
