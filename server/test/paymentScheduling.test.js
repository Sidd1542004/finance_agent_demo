// Scheduling bank payments (EFT, BPAY, Card through the simulated bank):
// amount limits, verified bank details, business days and cut-off,
// reschedule and cancel without an obsolete job, and what is blocked while
// the bank is processing. In memory; the cron and bank are tested separately.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent } from '../src/agent/finance/invoiceAgent.js';
import { extractWithRules } from '../src/agent/finance/extract.js';
import { ActionError, allowedActions } from '../src/agent/finance/lifecycle.js';
import { createCalendar } from '../src/agent/finance/businessDays.js';
import { remainingToPay, bankAmountProblem, canMovePayment, idempotencyKey } from '../src/agent/finance/paymentRules.js';
import { createInvoiceActions } from '../src/services/invoiceActions.js';
import { trustActor } from '../src/auth/roles.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { vendors, purchaseOrders, goodsReceipts, sampleBeneficiaries, renderInvoiceText, findSample } from '../src/seed/data.js';

const policy = { matchThreshold: 85, missingAbn: 'review', segregateDuties: false, priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };
const calendar = createCalendar({ timeZone: 'Australia/Sydney', holidays: [], cutoff: '15:00', defaultTime: '09:00' });
// Thursday 22 October 2026, 10:00 in Sydney.
const NOW = calendar.instant('2026-10-22', '10:00');

const approver = trustActor({ id: 'u-app', name: 'Priya Approver', roles: ['approver'], sessionId: 's-app' });
const payer = trustActor({ id: 'u-pay', name: 'Sam Payer', roles: ['payer'], sessionId: 's-pay' });

function setup({ now = () => NOW, beneficiaryChanges = [] } = {}) {
  const invoices = [];
  const verified = vendors.map((v) => (sampleBeneficiaries[v.abn] ? { ...v, beneficiary: { ...sampleBeneficiaries[v.abn], status: 'verified', version: 1 } } : { ...v }));
  const ledger = createMemoryLedger({ vendors: verified, purchaseOrders, goodsReceipts, invoices, beneficiaryChanges });
  const agent = createInvoiceAgent({ ledger, extract: async (t) => extractWithRules(t), policy, save: async () => {}, today: () => '2026-10-22' });
  const actions = createInvoiceActions({ store: ledger, policy, rerun: async () => {}, now, bank: { calendar, methods: ['EFT', 'BPAY', 'Card'], currencies: ['AUD'] } });
  let n = 0;
  const submit = async (sampleId, edit) => {
    n += 1;
    const s = structuredClone(findSample(sampleId));
    if (edit) edit(s);
    const invoice = { id: `inv-${n}`, createdAt: new Date(2026, 9, 1, 9, n), source: { kind: 'paste' }, rawText: renderInvoiceText(s), status: 'received' };
    invoices.push(invoice);
    await runAgent(agent, { invoice });
    return invoice;
  };
  const act = (invoice, action, input = {}, actor = action.includes('payment') ? payer : approver) => actions.perform(invoice.id, action, input, actor);
  const activeJobs = () => ledger.jobs.filter((j) => j.active);
  return { ledger, invoices, submit, act, activeJobs, verified };
}

const rejects = (promise, status, pattern) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof ActionError, String(err));
    assert.equal(err.status, status, err.message);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });

test('payment rules: remaining amount, the bank pays exactly the remainder, payment moves', () => {
  const invoice = { approval: { amount: 727.1 }, extracted: { total: 811.8 } };
  assert.equal(remainingToPay(invoice, null), 727.1);
  assert.equal(remainingToPay(invoice, { paidAmount: 200 }), 527.1);
  assert.equal(remainingToPay(invoice, { paidAmount: 800 }), 0);
  assert.match(bankAmountProblem(727.11, 727.1), /more than/);
  assert.match(bankAmountProblem(700, 727.1), /full/);
  assert.match(bankAmountProblem(0, 727.1), /Enter the amount/);
  assert.equal(bankAmountProblem(727.1, 727.1), null);
  assert.equal(canMovePayment('processing', 'cancelled'), false, 'nothing cancels a payment the bank is processing');
  assert.equal(canMovePayment('paid', 'queued'), false);
  assert.equal(canMovePayment('queued', 'processing'), true);
  assert.equal(idempotencyKey('p1', 3), 'foa:p1:v3');
});

test('scheduling an EFT payment: a job for the chosen instant, against the verified details', async () => {
  const { submit, act, ledger, activeJobs } = setup();
  const invoice = await submit('clean');
  await act(invoice, 'approve');
  await act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23', scheduledTime: '09:30' });
  assert.equal(invoice.status, 'payment_pending');
  const p = ledger.payments[0];
  assert.equal(p.route, 'bank');
  assert.equal(p.status, 'queued', 'scheduled is not paid');
  assert.equal(p.scheduleVersion, 1);
  assert.equal(p.scheduledAt.toISOString(), '2026-10-22T22:30:00.000Z');
  assert.equal(p.timeZone, 'Australia/Sydney');
  assert.equal(p.beneficiary.version, 1);
  assert.equal(p.beneficiary.masked.accountNumber, '•••001');
  assert.equal(p.approvalSnapshot.decidedBy, 'Priya Approver');
  assert.equal(p.scheduledById, 'u-pay');
  assert.equal(activeJobs().length, 1);
  assert.equal(activeJobs()[0].scheduleVersion, 1);
  assert.equal(activeJobs()[0].runAt.toISOString(), p.scheduledAt.toISOString());
});

test('the amount can never exceed the approved amount minus confirmed payments', async () => {
  const { submit, act, ledger } = setup();
  const pallets = await submit('quantity-variance');
  await act(pallets, 'approve_received', { note: 'Received 10 of 12.' });
  await rejects(act(pallets, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23', amount: 811.8 }), 400, /more than the \$727\.10/);
  await rejects(act(pallets, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23', amount: 500 }), 400, /full \$727\.10/);
  assert.equal(pallets.status, 'approved', 'nothing changed');
  assert.equal(ledger.payments.length, 0);
  await act(pallets, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23', amount: 727.1 });
  assert.equal(ledger.payments[0].amount, 727.1);

  // Part paid by cheque first: the bank may only pay what is left.
  const clean = await submit('clean');
  await act(clean, 'approve');
  await act(clean, 'schedule_payment', { method: 'Cheque', scheduledFor: '2026-10-23' });
  const cheque = ledger.payments.find((p) => p.invoiceId === clean.id);
  assert.equal(cheque.route, 'manual');
  await act(clean, 'record_payment', { amount: 400, reference: 'CHQ-1' });
  const left = cheque.amount - 400;
  await rejects(act(clean, 'reschedule_payment', { method: 'EFT', scheduledFor: '2026-10-23', amount: cheque.amount }), 400, /more than/);
  await act(clean, 'reschedule_payment', { method: 'EFT', scheduledFor: '2026-10-23', amount: left });
  assert.equal(cheque.route, 'bank');
});

test('verified bank details are required; a pending change or an unsupported method blocks scheduling', async () => {
  // Bluegum (the large invoice) has no verified details.
  const s1 = setup();
  const bluegum = await s1.submit('over-limit');
  await s1.act(bluegum, 'approve');
  await rejects(s1.act(bluegum, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23' }), 409, /no verified bank details/);
  assert.equal(bluegum.status, 'approved');
  assert.equal(s1.ledger.payments.length, 0);
  // Cheque does not use the bank details, so it is still possible.
  await s1.act(bluegum, 'schedule_payment', { method: 'Cheque', scheduledFor: '2026-10-23' });
  assert.equal(bluegum.status, 'payment_pending');

  // Harbour has EFT and BPAY details, no card.
  const s2 = setup();
  const clean = await s2.submit('clean');
  await s2.act(clean, 'approve');
  await rejects(s2.act(clean, 'schedule_payment', { method: 'Card', scheduledFor: '2026-10-23' }), 409, /cannot be paid by Card/);

  // A change waiting for approval blocks payments to that supplier.
  const s3 = setup({ beneficiaryChanges: [{ vendorAbn: '57600410275', status: 'pending' }] });
  const c3 = await s3.submit('clean');
  await s3.act(c3, 'approve');
  await rejects(s3.act(c3, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23' }), 409, /waiting for approval/);
});

test('weekends, bank holidays and the cut-off are refused with the next valid time', async () => {
  const { submit, act } = setup();
  const invoice = await submit('clean');
  await act(invoice, 'approve');
  await assert.rejects(act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-24' }), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /Saturday/);
    assert.match(err.message, /2026-10-26 at 09:00/);
    assert.deepEqual(err.extra.suggestion, { date: '2026-10-26', time: '09:00' });
    return true;
  });
  await rejects(act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23', scheduledTime: '15:30' }), 400, /after the 15:00 cut-off/);
  await rejects(act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-12-25' }), 400, /Christmas Day/);
  await rejects(act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-20' }), 400, /in the past/);
  assert.equal(invoice.status, 'approved');

  // After today's cut-off, "today" is refused too.
  const late = setup({ now: () => calendar.instant('2026-10-22', '15:10') });
  const i2 = await late.submit('clean');
  await late.act(i2, 'approve');
  await rejects(late.act(i2, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-22', scheduledTime: '14:00' }), 400, /cut-off .* has passed/);
  // No date chosen: the next possible slot.
  await late.act(i2, 'schedule_payment', { method: 'EFT' });
  assert.equal(late.ledger.payments[0].scheduledFor, '2026-10-23');
});

test('rescheduling bumps the version and supersedes the old job; only one job is ever active', async () => {
  const { submit, act, ledger, activeJobs } = setup();
  const invoice = await submit('clean');
  await act(invoice, 'approve');
  await act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23' });
  const first = activeJobs()[0];
  await act(invoice, 'reschedule_payment', { method: 'BPAY', scheduledFor: '2026-10-27', scheduledTime: '11:00', note: 'Supplier asked for BPAY.' });
  const p = ledger.payments[0];
  assert.equal(p.scheduleVersion, 2);
  assert.equal(p.method, 'BPAY');
  assert.equal(p.scheduledFor, '2026-10-27');
  assert.equal(first.status, 'superseded');
  assert.equal(first.active, false);
  assert.equal(activeJobs().length, 1);
  assert.equal(activeJobs()[0].scheduleVersion, 2);
  assert.equal(invoice.status, 'payment_pending');
  await rejects(act(invoice, 'reschedule_payment', { method: 'EFT', scheduledFor: '2026-10-31' }), 400, /Saturday/);
  assert.equal(p.scheduleVersion, 2, 'a refused reschedule changes nothing');

  // Rescheduled to Cheque: no bank job at all.
  await act(invoice, 'reschedule_payment', { method: 'Cheque', scheduledFor: '2026-10-28' });
  assert.equal(p.route, 'manual');
  assert.equal(activeJobs().length, 0);
});

test('cancelling the payment cancels its job and leaves the invoice approved; it can be scheduled again', async () => {
  const { submit, act, ledger, activeJobs } = setup();
  const invoice = await submit('clean');
  await act(invoice, 'approve');
  await act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23' });
  await rejects(act(invoice, 'cancel_payment', {}), 400, /note/);
  await act(invoice, 'cancel_payment', { note: 'Supplier credit note expected.' });
  assert.equal(invoice.status, 'approved');
  assert.equal(ledger.payments[0].status, 'cancelled');
  assert.equal(activeJobs().length, 0);
  assert.equal(ledger.jobs[0].status, 'cancelled');

  await act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-26' });
  assert.equal(ledger.payments.length, 1, 'the same payment record, reactivated');
  assert.equal(ledger.payments[0].scheduleVersion, 2);
  assert.equal(activeJobs().length, 1);
  assert.equal(activeJobs()[0].scheduleVersion, 2);
});

test('reverse approval, cancel and reopen also cancel the pending job', async () => {
  for (const [action, to] of [
    ['reverse_approval', 'rejected'],
    ['reopen', 'needs_review'],
  ]) {
    const { submit, act, ledger, activeJobs } = setup();
    const invoice = await submit('clean');
    await act(invoice, 'approve');
    await act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23' });
    await act(invoice, action, { note: 'Wrong supplier.' }, approver);
    assert.equal(invoice.status, to, action);
    assert.equal(ledger.payments[0].status, 'cancelled', action);
    assert.equal(activeJobs().length, 0, action);
  }
  // Cancel the invoice after a failed bank payment: the payment and any job stop.
  const { submit, act, ledger, activeJobs } = setup();
  const invoice = await submit('clean');
  await act(invoice, 'approve');
  await act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23' });
  Object.assign(ledger.payments[0], { status: 'failed' });
  invoice.status = 'payment_failed';
  await act(invoice, 'cancel', { note: 'Paid another way.' }, approver);
  assert.equal(invoice.status, 'cancelled');
  assert.equal(activeJobs().length, 0);
});

test('while the bank is processing, nothing can cancel, reverse, reopen, reschedule or record it', async () => {
  const { submit, act, ledger, invoices } = setup();
  const invoice = await submit('clean');
  await act(invoice, 'approve');
  await act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23' });
  const p = ledger.payments[0];
  // The tick has claimed it (payment first, then the invoice).
  p.status = 'processing';
  for (const action of ['cancel_payment', 'reschedule_payment', 'reverse_approval', 'reopen']) {
    await rejects(act(invoice, action, { note: 'Stop it.' }, action.includes('payment') ? payer : approver), 409, /processing this payment/);
  }
  invoices[0].status = 'payment_processing';
  await rejects(act(invoice, 'record_payment', { reference: 'X' }), 409);
  await rejects(act(invoice, 'cancel', { note: 'x' }), 409);
  assert.deepEqual(
    allowedActions(invoice, { payment: p }).map((a) => a.id),
    [],
    'no action is offered while processing',
  );
});

test('a bank-routed payment cannot be recorded or marked failed by hand; Cheque still can', async () => {
  const { submit, act, ledger } = setup();
  const invoice = await submit('clean');
  await act(invoice, 'approve');
  await act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23' });
  await rejects(act(invoice, 'record_payment', { reference: 'EFT-1' }), 409, /simulated bank, which confirms it/);
  await rejects(act(invoice, 'payment_failed', { note: 'x' }), 409, /reports failures itself/);
  assert.equal(ledger.payments[0].status, 'queued');

  await act(invoice, 'reschedule_payment', { method: 'Cheque', scheduledFor: '2026-10-23' });
  await act(invoice, 'record_payment', { reference: 'CHQ-7' });
  assert.equal(invoice.status, 'payment_completed');
});

test('duplicate prevention: two schedules at once, and a copy of an invoice already being processed', async () => {
  const { submit, act, ledger, activeJobs } = setup();
  const invoice = await submit('clean');
  await act(invoice, 'approve');
  const results = await Promise.allSettled([
    act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23' }),
    act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(ledger.payments.length, 1);
  assert.equal(activeJobs().length, 1);

  // The same invoice sent again, cleared as "not a duplicate" by mistake: the
  // payment being processed for the first one still blocks a second payment.
  ledger.payments[0].status = 'processing';
  const copy = await submit('clean');
  copy.status = 'approved';
  copy.approval = { decision: 'approve', decidedBy: 'x', amount: copy.extracted.total };
  await rejects(act(copy, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23' }), 409, /will not be paid twice/);
});

test('the bank pays AUD only', async () => {
  const { submit, act } = setup();
  const invoice = await submit('clean');
  await act(invoice, 'approve');
  invoice.extracted.currency = 'NZD';
  await rejects(act(invoice, 'schedule_payment', { method: 'EFT', scheduledFor: '2026-10-23' }), 400, /AUD only/);
});
