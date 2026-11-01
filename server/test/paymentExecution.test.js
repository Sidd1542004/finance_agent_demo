// The cron tick and the payment executor, on a real MongoDB and the
// simulated bank, with an injected clock: due jobs, invoice synchronisation,
// concurrent ticks, leases, retries, timeouts, failures, obsolete jobs and
// the business-day rules at execution time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startPayments, HARBOUR, PALLETS, payer, approver } from '../test-support/payments.js';
import { BankUnavailable } from '../src/bank/adapter.js';
import { idempotencyKey } from '../src/agent/finance/paymentRules.js';

const h = await startPayments();
test.after(h.stop);
const { models } = h;

async function clean() {
  await Promise.all(
    [
      models.Invoice,
      models.Payment,
      models.PaymentJob,
      models.SimBankTransaction,
      models.SimBankScenario,
      models.SimBankAttempt,
      models.SimBankAccount,
      models.OutboxMessage,
      models.BeneficiaryChange,
    ].map((m) => m.deleteMany({})),
  );
  const { seedReferenceData } = await import('../src/seed/seed.js');
  await seedReferenceData();
  h.setClock('2026-10-22', '10:00');
}
const successNotices = (paymentId) => models.OutboxMessage.countDocuments({ paymentId, kind: 'payment_success' });

test('a scheduled payment runs when due, is processing until the bank confirms it, then completes the invoice', async () => {
  await clean();
  const { invoiceId, paymentId } = await h.scheduled({ total: 250, date: '2026-10-22', time: '11:00' });
  const ex = h.executor();

  let m = await ex.tick();
  assert.equal(m.jobs.claimed, 0, 'not due yet');
  assert.equal((await h.payment(paymentId)).status, 'queued');
  assert.equal((await h.invoice(invoiceId)).status, 'payment_pending', 'scheduled is not paid');

  h.setClock('2026-10-22', '11:00');
  m = await ex.tick();
  assert.equal(m.jobs.submitted, 1);
  let p = await h.payment(paymentId);
  assert.equal(p.status, 'processing');
  assert.match(p.submission.txnRef, /^SIMTXN-/);
  assert.equal(p.submission.idempotencyKey, idempotencyKey(paymentId, 1));
  assert.equal(p.paidAmount, null, 'accepted by the bank is not paid');
  assert.equal((await h.invoice(invoiceId)).status, 'payment_processing');
  assert.equal(await successNotices(paymentId), 0, 'no success notice while processing');

  h.advance(10);
  m = await ex.tick();
  assert.equal(m.payments.stillProcessing, 1);
  assert.equal((await h.invoice(invoiceId)).status, 'payment_processing');

  h.advance(10);
  m = await ex.tick();
  assert.equal(m.payments.completed, 1);
  p = await h.payment(paymentId);
  assert.equal(p.status, 'paid');
  assert.equal(p.paidAmount, 250);
  assert.equal(p.reference, p.submission.txnRef);
  assert.equal(p.confirmation.txnRef, p.submission.txnRef);
  assert.equal(p.confirmation.simulated, true);
  const inv = await h.invoice(invoiceId);
  assert.equal(inv.status, 'payment_completed');
  assert.equal(inv.paymentConfirmation.txnRef, p.confirmation.txnRef);
  assert.equal(inv.paymentConfirmation.confirmedAt, h.now().toISOString());
  assert.equal(await successNotices(paymentId), 1, 'the confirmation is drafted once the bank confirms');

  // More ticks change nothing and never pay twice.
  await ex.tick();
  await ex.tick();
  assert.equal((await h.txns(paymentId)).length, 1);
  assert.equal(await successNotices(paymentId), 1);
  const log = await models.AuditEvent.find({ subjectId: invoiceId }).sort({ at: 1, _id: 1 }).lean();
  assert.deepEqual(
    log.map((e) => [e.actor, e.from, e.to]),
    [
      ['Sam Payer', 'approved', 'payment_pending'],
      ['Payment scheduler', 'payment_pending', 'payment_processing'],
      ['Simulated bank', 'payment_processing', 'payment_completed'],
    ],
  );
});

test('concurrent ticks: every due payment is submitted exactly once and completed exactly once', async () => {
  await clean();
  const made = [];
  for (let i = 0; i < 6; i += 1) made.push(await h.scheduled({ total: 10 + i, supplier: i % 2 ? PALLETS : HARBOUR }));
  const runs = await Promise.all([h.executor().tick(), h.executor().tick(), h.executor().tick(), h.executor().tick()]);
  assert.equal(
    runs.reduce((s, r) => s + r.jobs.claimed, 0),
    6,
    'each job claimed by exactly one tick',
  );
  assert.equal(
    runs.reduce((s, r) => s + r.jobs.submitted, 0),
    6,
  );
  for (const { paymentId } of made) {
    assert.equal((await h.txns(paymentId)).length, 1, 'one bank transaction per payment');
    const job = await models.PaymentJob.findOne({ paymentId }).lean();
    assert.equal(job.history.filter((e) => e.event === 'claimed').length, 1);
  }
  h.advance(25);
  const done = await Promise.all([h.executor().tick(), h.executor().tick(), h.executor().tick()]);
  assert.equal(
    done.reduce((s, r) => s + r.payments.completed, 0),
    6,
    'each payment completed once',
  );
  for (const { invoiceId, paymentId } of made) {
    assert.equal((await h.invoice(invoiceId)).status, 'payment_completed');
    assert.equal(await successNotices(paymentId), 1);
  }
  const account = await h.simBank.accountView();
  assert.equal(account.balance, 100000 - (10 + 11 + 12 + 13 + 14 + 15), 'the balance fell once per payment');
  assert.equal(account.reserved, 0);
});

test('a tick is bounded and reports what is left', async () => {
  await clean();
  for (let i = 0; i < 5; i += 1) await h.scheduled({ total: 5 + i });
  const m = await h.executor({ tickMaxJobs: 2 }).tick();
  assert.equal(m.jobs.claimed, 2);
  assert.equal(m.dueRemaining, 3);
  assert.equal(m.simulated, true);
  assert.ok(!JSON.stringify(m).match(/secret|password|10482001/i), 'metrics carry no secrets or bank details');
});

test('an abandoned lease is taken over; a tick that died mid-way never causes a second payment', async () => {
  await clean();
  // 1. The job was claimed by a tick that died before doing anything.
  const a = await h.scheduled({ total: 40 });
  await models.PaymentJob.updateOne({ paymentId: a.paymentId }, { $set: { status: 'running', leaseOwner: 'tick-dead', leaseUntil: new Date(h.now().getTime() + 120000) } });
  let m = await h.executor().tick();
  assert.equal(m.jobs.claimed, 0, 'a live lease is respected');
  h.advance(121);
  m = await h.executor().tick();
  assert.equal(m.jobs.claimed, 1, 'the expired lease is taken over');
  assert.equal(m.jobs.submitted, 1);
  assert.equal((await h.txns(a.paymentId)).length, 1);

  // 2. The tick died after the bank accepted the instruction, before recording it.
  await clean();
  const b = await h.scheduled({ total: 41 });
  const p = await h.payment(b.paymentId);
  const key = idempotencyKey(b.paymentId, 1);
  await h.adapter.submitPayment(
    {
      idempotencyKey: key,
      amount: 41,
      currency: 'AUD',
      method: 'EFT',
      beneficiary: { accountName: 'Harbour Office Supplies (SIMULATED)', bsb: '999-001', accountNumber: '10482001' },
      reference: p.invoiceNumber,
      payee: { abn: HARBOUR.abn, name: HARBOUR.name },
    },
    { now: h.now() },
  );
  await models.Payment.updateOne({ _id: b.paymentId }, { $set: { status: 'processing', submission: { idempotencyKey: key, amount: 41, state: 'submitting', txnRef: null } } });
  await models.Invoice.updateOne({ _id: b.invoiceId }, { $set: { status: 'payment_processing' } });
  await models.PaymentJob.updateOne(
    { paymentId: b.paymentId },
    { $set: { status: 'running', leaseOwner: 'tick-dead', leaseUntil: new Date(h.now().getTime() - 1000), attempts: 1 } },
  );
  m = await h.executor().tick();
  assert.equal((await h.txns(b.paymentId)).length, 1, 'the bank already had it: not sent again');
  assert.match((await h.payment(b.paymentId)).submission.txnRef, /^SIMTXN-/);
  h.advance(25);
  await h.executor().tick();
  assert.equal((await h.invoice(b.invoiceId)).status, 'payment_completed');
});

test('a timeout is "unknown", never success: the bank is asked before anything is sent again', async () => {
  await clean();
  const { invoiceId, paymentId } = await h.scheduled({ total: 60 });
  // The bank accepts the instruction, but the answer is lost.
  const lossy = {
    ...h.adapter,
    submitPayment: async (instruction, opts) => {
      await h.adapter.submitPayment(instruction, opts);
      throw new BankUnavailable('The simulated bank did not answer within 5 s.', { timeout: true });
    },
  };
  let m = await h.executor({ adapter: lossy }).tick();
  assert.equal(m.jobs.retried, 1);
  let p = await h.payment(paymentId);
  assert.equal(p.status, 'processing');
  assert.equal(p.submission.state, 'unknown');
  assert.equal((await h.invoice(invoiceId)).status, 'payment_processing', 'not completed on a lost answer');
  // The next tick finds it at the bank by its idempotency key.
  m = await h.executor().tick();
  assert.equal(m.payments.resolvedUnknown, 1);
  p = await h.payment(paymentId);
  assert.match(p.submission.txnRef, /^SIMTXN-/);
  h.advance(65);
  await h.executor().tick();
  assert.equal((await h.invoice(invoiceId)).status, 'payment_completed');
  assert.equal((await h.txns(paymentId)).length, 1, 'exactly one transaction');
});

test('temporary failure: retried later with the same key; giving up after the last attempt fails the payment, never pays', async () => {
  await clean();
  await h.simBank.setScenario(HARBOUR.abn, 'temporary_failure', null);
  const { paymentId } = await h.scheduled({ total: 70 });
  let m = await h.executor().tick();
  assert.equal(m.jobs.retried, 1);
  const job = await models.PaymentJob.findOne({ paymentId, active: true }).lean();
  assert.equal(job.status, 'pending');
  assert.equal(job.runAt.toISOString(), new Date(h.now().getTime() + 60000).toISOString(), 'backs off for a minute');
  m = await h.executor().tick();
  assert.equal(m.jobs.claimed, 0, 'not before the back-off');
  h.advance(61);
  m = await h.executor().tick();
  assert.equal(m.jobs.submitted, 1);
  assert.equal((await h.txns(paymentId)).length, 1);

  // A bank that never accepts it: after the last attempt the payment fails; nothing is paid.
  await clean();
  const down = {
    ...h.adapter,
    submitPayment: async () => {
      throw new BankUnavailable('The simulated bank is temporarily unavailable.');
    },
  };
  const s = await h.scheduled({ total: 71 });
  const ex = h.executor({ adapter: down, maxAttempts: 2, retryDelaysSeconds: [1] });
  await ex.tick();
  h.advance(2);
  m = await ex.tick();
  const p = await h.payment(s.paymentId);
  assert.equal(p.status, 'failed');
  assert.equal(p.failure.code, 'bank_unavailable');
  assert.equal((await h.invoice(s.invoiceId)).status, 'payment_failed');
  assert.equal((await h.txns(s.paymentId)).length, 0);
});

test('rejections and insufficient funds fail the payment and the invoice; a retry uses a new key and can succeed', async () => {
  await clean();
  await h.simBank.setScenario(HARBOUR.abn, 'rejection', null);
  const { invoiceId, paymentId } = await h.scheduled({ total: 80 });
  let m = await h.executor().tick();
  assert.equal(m.jobs.rejected, 1);
  let p = await h.payment(paymentId);
  assert.equal(p.status, 'failed');
  assert.equal(p.failure.code, 'rejected_by_bank');
  assert.equal((await h.invoice(invoiceId)).status, 'payment_failed');
  assert.equal(await successNotices(paymentId), 0);

  // Retry: Payment Failed -> Payment Pending, version 2, a new idempotency key.
  await h.simBank.setScenario(HARBOUR.abn, 'success', null);
  await h.actions.perform(invoiceId, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-22', scheduledTime: '10:00' }, payer);
  p = await h.payment(paymentId);
  assert.equal(p.scheduleVersion, 2);
  assert.equal(p.submissions.length, 1, 'the failed instruction is kept in the history');
  await h.executor().tick();
  h.advance(25);
  await h.executor().tick();
  assert.equal((await h.invoice(invoiceId)).status, 'payment_completed');
  assert.deepEqual((await h.txns(paymentId)).map((t) => t.status).sort(), ['REJECTED', 'SUCCESS']);

  // Insufficient funds: the simulated balance is too low.
  await clean();
  await h.simBank.accountView();
  await h.simBank.setBalance(50);
  const poor = await h.scheduled({ total: 90 });
  m = await h.executor().tick();
  assert.equal((await h.payment(poor.paymentId)).failure.code, 'insufficient_funds');
  assert.equal((await h.invoice(poor.invoiceId)).status, 'payment_failed');
});

test('accepted, then failed at settlement: the invoice is Payment Failed and the reservation is released', async () => {
  await clean();
  await h.simBank.setScenario(PALLETS.abn, 'settle_failure', null);
  const { invoiceId, paymentId } = await h.scheduled({ supplier: PALLETS, total: 33 });
  await h.executor().tick();
  assert.equal((await h.invoice(invoiceId)).status, 'payment_processing');
  h.advance(25);
  const m = await h.executor().tick();
  assert.equal(m.payments.failed, 1);
  const p = await h.payment(paymentId);
  assert.equal(p.status, 'failed');
  assert.equal(p.failure.code, 'settlement_failed');
  assert.equal((await h.invoice(invoiceId)).status, 'payment_failed');
  assert.equal((await h.simBank.accountView()).reserved, 0);
  assert.equal(await successNotices(paymentId), 0, 'never a success notice for a failed payment');
});

test('delayed completion: still processing after the usual delay, completed once the bank is done', async () => {
  await clean();
  await h.simBank.setScenario(HARBOUR.abn, 'delayed', null);
  const { invoiceId } = await h.scheduled({ total: 44 });
  await h.executor().tick();
  h.advance(60);
  await h.executor().tick();
  assert.equal((await h.invoice(invoiceId)).status, 'payment_processing');
  h.advance(600);
  await h.executor().tick();
  assert.equal((await h.invoice(invoiceId)).status, 'payment_completed');
});

test('an obsolete job never runs: a stale schedule version, or a cancelled payment', async () => {
  await clean();
  const { invoiceId, paymentId } = await h.scheduled({ total: 55 });
  await h.actions.perform(invoiceId, 'reschedule_payment', { method: 'EFT', scheduledFor: '2026-10-23', scheduledTime: '09:00' }, payer);
  // Even if a job for the old version were still waiting, it would do nothing.
  await models.PaymentJob.updateMany({ paymentId }, { $set: { active: false, status: 'cancelled' } });
  await models.PaymentJob.create({ paymentId, invoiceId, scheduleVersion: 1, runAt: h.now() });
  let m = await h.executor().tick();
  assert.equal(m.jobs.superseded, 1);
  assert.equal(m.jobs.submitted, 0);
  assert.equal((await h.txns(paymentId)).length, 0);

  const c = await h.scheduled({ total: 56 });
  await h.actions.perform(c.invoiceId, 'cancel_payment', { note: 'Not needed.' }, payer);
  await models.PaymentJob.create({ paymentId: c.paymentId, invoiceId: c.invoiceId, scheduleVersion: 1, runAt: h.now() });
  m = await h.executor().tick();
  assert.equal(m.jobs.cancelled, 1);
  assert.equal((await h.txns(c.paymentId)).length, 0);

  // Reversed approval: the job was cancelled with the payment.
  const r = await h.scheduled({ total: 57 });
  await h.actions.perform(r.invoiceId, 'reverse_approval', { note: 'Wrong supplier.' }, approver);
  m = await h.executor().tick();
  assert.equal(m.jobs.claimed, 0);
  assert.equal((await h.txns(r.paymentId)).length, 0);
});

test('at execution: after the cut-off or on a weekend, a due job waits for the next business morning', async () => {
  await clean();
  const { invoiceId, paymentId } = await h.scheduled({ total: 66, date: '2026-10-23', time: '14:00' });
  h.setClock('2026-10-23', '15:30'); // the scheduler missed Friday's run
  let m = await h.executor().tick();
  assert.equal(m.jobs.deferred, 1);
  assert.equal((await h.payment(paymentId)).status, 'queued');
  const job = await models.PaymentJob.findOne({ paymentId, active: true }).lean();
  assert.equal(job.runAt.toISOString(), h.calendar.instant('2026-10-26', '09:00').toISOString());
  assert.equal(job.attempts, 0, 'waiting is not an attempt');
  h.setClock('2026-10-24', '10:00'); // Saturday
  m = await h.executor().tick();
  assert.equal(m.jobs.claimed, 0);
  h.setClock('2026-10-26', '09:00');
  m = await h.executor().tick();
  assert.equal(m.jobs.submitted, 1);
  assert.equal((await h.invoice(invoiceId)).status, 'payment_processing');
});

test('bank details changed or a change pending after scheduling: not submitted; the payment fails with the reason', async () => {
  await clean();
  const { invoiceId, paymentId } = await h.scheduled({ total: 77 });
  await models.Vendor.updateOne({ abn: HARBOUR.abn }, { $set: { 'beneficiary.version': 2, 'beneficiary.accountNumber': '55555555' } });
  await h.executor().tick();
  const p = await h.payment(paymentId);
  assert.equal(p.status, 'failed');
  assert.match(p.failure.reason, /bank details changed after this payment was scheduled/);
  assert.equal((await h.invoice(invoiceId)).status, 'payment_failed');
  assert.equal((await h.txns(paymentId)).length, 0);

  await clean();
  const s = await h.scheduled({ total: 78 });
  await models.BeneficiaryChange.create({ vendorAbn: HARBOUR.abn, details: { accountName: 'x' }, proposedBy: 'Someone', proposedById: 'u-x' });
  await h.executor().tick();
  assert.match((await h.payment(s.paymentId)).failure.reason, /waiting for approval/);
  assert.equal((await h.txns(s.paymentId)).length, 0);
});
