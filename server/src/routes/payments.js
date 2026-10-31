// Payments, the cron tick, payment notices and the simulated bank.
//
//   registerPaymentCron(router)       on the cron router (routes/cron.js): CRON_SECRET only
//   registerPaymentRoutes(api)        after sign-in
//   registerAdminPaymentRoutes(r)     on the admin router (admin role)

import mongoose from 'mongoose';
import { requireRole } from '../auth/middleware.js';
import { Payment, PaymentJob } from '../models/index.js';
import { HttpError, recordAudit } from '../services/runs.js';
import { simBank, paymentExecutor, paymentNotices, emailDelivery } from '../services/paymentSystem.js';
import { paymentCalendar } from '../services/invoices.js';
import { SimBankError, SCENARIOS } from '../bank/simBank.js';

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const STATUSES = ['queued', 'processing', 'paid', 'failed', 'cancelled', 'on_hold'];

// Simulated bank refusals become ordinary HTTP errors.
const bankCall = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SimBankError) throw new HttpError(err.status, err.message, { code: err.code });
    throw err;
  }
};

// On the cron router (routes/cron.js), behind its CRON_SECRET guard: /api/cron/tick.
export function registerPaymentCron(router) {
  // Called every few minutes by an external scheduler (or Vercel Cron, daily on Hobby).
  const tick = wrap(async (req, res) => {
    res.json(await paymentExecutor.tick({ trigger: 'cron' }));
  });
  router.get('/tick', tick);
  router.post('/tick', tick);
}

const listItem = (p) => ({
  _id: p._id,
  invoiceId: p.invoiceId,
  invoiceNumber: p.invoiceNumber,
  vendorName: p.vendorName,
  amount: p.amount,
  paidAmount: p.paidAmount,
  currency: p.currency || 'AUD',
  method: p.method,
  route: p.route || 'manual',
  status: p.status,
  scheduledFor: p.scheduledFor,
  scheduledAt: p.scheduledAt,
  scheduledBy: p.scheduledBy,
  txnRef: p.confirmation?.txnRef || p.submission?.txnRef || null,
  completesAt: p.submission?.completesAt || null,
  confirmedAt: p.confirmation?.confirmedAt || null,
  failure: p.failure ? { reason: p.failure.reason, code: p.failure.code } : null,
  updatedAt: p.updatedAt,
  simulated: true,
});

export function registerPaymentRoutes(api) {
  // ?status=queued|processing|paid|failed|cancelled (several comma-separated)
  api.get(
    '/payments',
    wrap(async (req, res) => {
      const wanted = String(req.query.status || '')
        .split(',')
        .filter((s) => STATUSES.includes(s));
      const docs = await Payment.find(wanted.length ? { status: { $in: wanted } } : {})
        .sort({ updatedAt: -1 })
        .limit(200)
        .lean();
      const counts = Object.fromEntries(await Promise.all(STATUSES.map(async (s) => [s, await Payment.countDocuments({ status: s })])));
      res.json({ items: docs.map(listItem), counts });
    }),
  );

  api.get(
    '/payments/:id',
    wrap(async (req, res) => {
      if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'That payment does not exist.');
      const p = await Payment.findById(req.params.id).lean();
      if (!p) throw new HttpError(404, 'That payment does not exist.');
      const ref = p.confirmation?.txnRef || p.submission?.txnRef;
      const [jobs, transaction, notices] = await Promise.all([
        PaymentJob.find({ paymentId: p._id }).sort({ createdAt: 1 }).lean(),
        ref ? simBank.getTransaction(ref) : null,
        paymentNotices.list({ paymentId: p._id }),
      ]);
      res.json({ payment: p, jobs, transaction, notices });
    }),
  );

  // The rules a payment date must follow, for the scheduling form.
  api.get('/payment-calendar', (req, res) => {
    const c = paymentCalendar;
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = Object.entries(c.holidays)
      .filter(([d]) => d >= today)
      .slice(0, 8)
      .map(([date, name]) => ({ date, name }));
    res.json({ timeZone: c.timeZone, cutoff: c.cutoff, defaultTime: c.defaultTime, businessDays: c.businessDays, upcomingHolidays: upcoming, nextSlot: c.nextSlot(new Date()) });
  });

  // ----- notices to suppliers (drafts; a person approves each one) -----

  api.get(
    '/payment-notices',
    wrap(async (req, res) => {
      const status = ['draft', 'sent', 'discarded'].includes(req.query.status) ? req.query.status : undefined;
      res.json({ items: await paymentNotices.list({ status }), delivery: emailDelivery.describe() });
    }),
  );

  api.post(
    '/payments/:id/notices',
    requireRole('payer', 'reviewer'),
    wrap(async (req, res) => {
      const { message, created } = await paymentNotices.draft(req.params.id, req.body?.kind, req.user);
      res.status(created ? 201 : 200).json({ message, created });
    }),
  );

  api.post(
    '/payment-notices/:id/send',
    requireRole('payer', 'reviewer'),
    wrap(async (req, res) => {
      res.json({ message: await paymentNotices.approveAndSend(req.params.id, req.user) });
    }),
  );

  api.post(
    '/payment-notices/:id/discard',
    requireRole('payer', 'reviewer'),
    wrap(async (req, res) => {
      res.json({ message: await paymentNotices.discard(req.params.id, req.user, req.body?.note) });
    }),
  );

  // ----- the simulated bank (read: payers, approvers, admins) -----

  const bankReader = requireRole('payer', 'approver', 'admin');

  api.get(
    '/sim-bank/account',
    bankReader,
    wrap(async (req, res) => {
      res.json(await simBank.accountView());
    }),
  );

  api.get(
    '/sim-bank/transactions',
    bankReader,
    wrap(async (req, res) => {
      res.json({ items: await simBank.listTransactions({ limit: Number(req.query.limit) || 100 }), simulated: true });
    }),
  );

  api.get(
    '/sim-bank/transactions/:ref',
    bankReader,
    wrap(async (req, res) => {
      const t = await simBank.getTransaction(req.params.ref);
      if (!t) throw new HttpError(404, 'No simulated transaction with that reference.');
      res.json(t);
    }),
  );

  // A statement of settled simulated payments, for the bank reconciliation screen.
  api.get(
    '/sim-bank/statement.csv',
    requireRole('payer', 'admin'),
    wrap(async (req, res) => {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="simulated-bank-statement.csv"');
      res.send(await simBank.statementCsv());
    }),
  );

  // Submit an instruction straight to the simulated bank (admin testing only).
  // The payment workflow never uses this route: it calls the adapter directly.
  api.post(
    '/sim-bank/payments',
    requireRole('admin'),
    wrap(async (req, res) => {
      const key = req.get('Idempotency-Key');
      if (!key) throw new HttpError(400, 'Send an Idempotency-Key header.');
      const t = await bankCall(() => simBank.submitPayment({ ...(req.body || {}), idempotencyKey: key }));
      res.status(t.duplicate ? 200 : 201).json(t);
    }),
  );
}

export function registerAdminPaymentRoutes(router) {
  // The same tick as the scheduler, on demand (demos and testing).
  router.post(
    '/run-due',
    wrap(async (req, res) => {
      const metrics = await paymentExecutor.tick({ trigger: 'manual' });
      await recordAudit({
        subjectKind: 'system',
        subjectId: 'payment-scheduler',
        actor: req.user.name,
        actorId: req.user.id,
        action: 'run_due_payments',
        detail: `Submitted ${metrics.jobs.submitted}, completed ${metrics.payments.completed}, failed ${metrics.payments.failed + metrics.jobs.rejected}. Simulated.`,
      });
      res.json(metrics);
    }),
  );

  router.get(
    '/sim-bank',
    wrap(async (req, res) => {
      res.json({ account: await simBank.accountView(), scenarios: await simBank.listScenarios(), scenarioNames: SCENARIOS, delivery: emailDelivery.describe(), simulated: true });
    }),
  );

  router.put(
    '/sim-bank/balance',
    wrap(async (req, res) => {
      const before = await simBank.accountView();
      const account = await bankCall(() => simBank.setBalance(req.body?.balance));
      await recordAudit({
        subjectKind: 'sim_bank',
        subjectId: account.id,
        actor: req.user.name,
        actorId: req.user.id,
        action: 'balance_set',
        from: String(before.balance),
        to: String(account.balance),
        detail: 'Simulated balance.',
      });
      res.json(account);
    }),
  );

  router.put(
    '/sim-bank/scenarios/:abn',
    wrap(async (req, res) => {
      const abn = String(req.params.abn).replace(/\D/g, '');
      const before = await simBank.scenarioFor(abn);
      const result = await bankCall(() => simBank.setScenario(abn, req.body?.scenario, req.user));
      await recordAudit({
        subjectKind: 'sim_bank',
        subjectId: abn,
        actor: req.user.name,
        actorId: req.user.id,
        action: 'scenario_set',
        from: before,
        to: result.scenario,
        detail: 'Simulated bank test scenario for this supplier.',
      });
      res.json(result);
    }),
  );
}
