// The payment routes end to end on the real app: the cron tick's secret, the
// admin's "Run due payments now", roles on payments, notices and the
// simulated bank, and the full flow from approval to a confirmed payment.
//
// The calendar is opened up (every day, cut-off 23:59, no holidays) and the
// bank completes at once, so these tests do not depend on the real clock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../test-support/app.js';

const t = await startApp({
  BUSINESS_DAYS: 'Mon-Sun',
  PAYMENT_CUTOFF: '23:59',
  PAYMENT_DEFAULT_TIME: '00:00',
  BANK_HOLIDAYS: '2000-01-01',
  SIM_BANK_DELAY_SECONDS: '0',
  SUPPLIER_EMAIL_MODE: 'live', // must still not deliver: APP_ENV is not production
});
test.after(t.stop);
const { AuditEvent, OutboxMessage } = await import('../src/models/index.js');
const CRON = { headers: { Authorization: 'Bearer test-cron-secret-0123456789' } };

async function approvedInvoice(sampleId = 'clean') {
  const reviewer = await t.signIn('reviewer');
  const approver = await t.signIn('approver');
  const created = await reviewer.post('/api/invoices', { sampleId });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.invoice._id;
  const ok = await approver.post(`/api/invoices/${id}/actions/approve`, { note: 'ok' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  return id;
}

test('the cron tick needs CRON_SECRET; a session or a wrong secret is refused', async () => {
  const anon = t.client();
  assert.equal((await anon.get('/api/cron/tick')).status, 401);
  assert.equal((await anon.get('/api/cron/tick', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const admin = await t.signIn('admin');
  assert.equal((await admin.get('/api/cron/tick')).status, 401, 'an admin session is not the scheduler');
  const ok = await anon.get('/api/cron/tick', CRON);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.simulated, true);
  assert.ok('jobs' in ok.data && 'payments' in ok.data && 'dueRemaining' in ok.data);
  assert.equal((await anon.post('/api/cron/tick', {}, { ...CRON, csrf: false })).status, 200, 'POST works too, without the dashboard header');
});

test('approve, schedule, tick: the invoice is completed only after the bank confirms; details on the invoice page', async () => {
  const id = await approvedInvoice();
  const payer = await t.signIn('payer');
  const scheduled = await payer.post(`/api/invoices/${id}/actions/schedule_payment`, { method: 'EFT', decidedBy: 'Someone else' });
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.data));
  assert.equal(scheduled.data.invoice.status, 'payment_pending');
  assert.equal(scheduled.data.payment.route, 'bank');
  assert.equal(scheduled.data.payment.scheduledBy, 'Sam Payer');
  assert.equal(scheduled.data.jobs.length, 1);
  assert.equal((await payer.post(`/api/invoices/${id}/actions/record_payment`, { reference: 'EFT-1' })).status, 409, 'cannot be recorded by hand');

  const m = await t.client().get('/api/cron/tick', CRON);
  assert.equal(m.data.jobs.submitted, 1);
  assert.equal(m.data.payments.completed, 1, 'the bank completed it (no delay in this test)');
  const detail = (await payer.get(`/api/invoices/${id}`)).data;
  assert.equal(detail.invoice.status, 'payment_completed');
  assert.equal(detail.payment.status, 'paid');
  assert.equal(detail.bankTransaction.status, 'SUCCESS');
  assert.equal(detail.bankTransaction.simulated, true);
  assert.equal(detail.invoice.paymentConfirmation.txnRef, detail.bankTransaction.ref);
  assert.equal(detail.notices.length, 1);
  assert.equal(detail.notices[0].kind, 'payment_success');
  assert.equal(detail.notices[0].status, 'draft');
  assert.ok(!('idempotencyKey' in detail.bankTransaction), 'internal keys are not shown');

  const list = (await payer.get('/api/payments?status=paid')).data;
  assert.ok(list.items.some((p) => p.txnRef === detail.bankTransaction.ref));
  assert.ok(list.counts.paid >= 1);
});

test('notices: reviewers and payers approve them; a typed recipient or mode in the request changes nothing', async () => {
  const draft = await OutboxMessage.findOne({ kind: 'payment_success', status: 'draft' }).lean();
  const approver = await t.signIn('approver');
  assert.equal((await approver.post(`/api/payment-notices/${draft._id}/send`)).status, 403);
  const reviewer = await t.signIn('reviewer');
  const list = await reviewer.get('/api/payment-notices?status=draft');
  assert.equal(list.data.delivery.mode, 'simulated_outbox', 'SUPPLIER_EMAIL_MODE=live is not enough outside production');
  const sent = await reviewer.post(`/api/payment-notices/${draft._id}/send`, { to: 'attacker@evil.example', mode: 'live', deliveredTo: 'x' });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.message.delivery.mode, 'simulated_outbox');
  assert.equal(sent.data.message.delivery.deliveredTo, null);
  assert.equal(sent.data.message.to, 'accounts@harbouroffice.example');
  assert.equal((await reviewer.post(`/api/payment-notices/${draft._id}/send`)).status, 409);
  const again = await reviewer.post(`/api/payments/${draft.paymentId}/notices`, { kind: 'payment_success' });
  assert.equal(again.status, 200);
  assert.equal(again.data.created, false, 'no duplicate confirmation');
  assert.equal((await reviewer.post(`/api/payments/${draft.paymentId}/notices`, { kind: 'payment_processing' })).status, 409);
});

test('"Run due payments now" is the same tick, admin only, and is logged', async () => {
  const payer = await t.signIn('payer');
  assert.equal((await payer.post('/api/admin/run-due')).status, 403);
  const admin = await t.signIn('admin');
  const r = await admin.post('/api/admin/run-due');
  assert.equal(r.status, 200);
  assert.equal(r.data.trigger, 'manual');
  assert.ok(await AuditEvent.exists({ action: 'run_due_payments', actor: 'Ada Admin' }));
});

test('simulated bank: scenarios and balance are admin-only and logged; a rejection fails the invoice', async () => {
  const admin = await t.signIn('admin');
  const payer = await t.signIn('payer');
  assert.equal((await payer.put('/api/admin/sim-bank/scenarios/37600518342', { scenario: 'rejection' })).status, 403);
  const view = await admin.get('/api/admin/sim-bank');
  assert.equal(view.data.simulated, true);
  assert.ok(view.data.scenarioNames.includes('temporary_failure'));
  assert.equal((await admin.put('/api/admin/sim-bank/scenarios/57600410275', { scenario: 'nonsense' })).status, 400);
  assert.equal((await admin.put('/api/admin/sim-bank/scenarios/57600410275', { scenario: 'rejection' })).status, 200);
  assert.ok(await AuditEvent.exists({ subjectKind: 'sim_bank', action: 'scenario_set', to: 'rejection' }));

  // A second Harbour invoice (cleared as not a duplicate) is rejected by the bank.
  const reviewer = await t.signIn('reviewer');
  const approver = await t.signIn('approver');
  const created = await reviewer.post('/api/invoices', { sampleId: 'price-variance' });
  const id = created.data.invoice._id;
  const ok = await approver.post(`/api/invoices/${id}/actions/approve`, { note: 'Price accepted.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // Without a date the due date (in the future for this sample) would be used; choose the next slot: now.
  const { nextSlot } = (await payer.get('/api/payment-calendar')).data;
  const s = await payer.post(`/api/invoices/${id}/actions/schedule_payment`, { method: 'BPAY', scheduledFor: nextSlot.date, scheduledTime: nextSlot.time });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  await t.client().get('/api/cron/tick', CRON);
  const detail = (await payer.get(`/api/invoices/${id}`)).data;
  assert.equal(detail.invoice.status, 'payment_failed');
  assert.equal(detail.payment.failure.code, 'rejected_by_bank');
  assert.equal(detail.bankTransaction.status, 'REJECTED');
  assert.equal(detail.notices.length, 0, 'no automatic notice for a failure');
  await admin.put('/api/admin/sim-bank/scenarios/57600410275', { scenario: 'success' });

  const before = (await admin.get('/api/sim-bank/account')).data;
  assert.equal(before.simulated, true);
  assert.equal((await admin.put('/api/admin/sim-bank/balance', { balance: -5 })).status, 400);
  const set = await admin.put('/api/admin/sim-bank/balance', { balance: 5000 });
  assert.equal(set.data.balance, 5000);
  assert.ok(await AuditEvent.exists({ subjectKind: 'sim_bank', action: 'balance_set', to: '5000' }));
});

test('simulated bank routes: reading needs payer, approver or admin; direct submission is admin-only with an Idempotency-Key', async () => {
  const reviewer = await t.signIn('reviewer');
  assert.equal((await reviewer.get('/api/sim-bank/account')).status, 403);
  const payer = await t.signIn('payer');
  const txns = (await payer.get('/api/sim-bank/transactions')).data;
  assert.ok(txns.items.length >= 1);
  assert.ok(txns.items.every((x) => x.simulated));
  const csv = await payer.get('/api/sim-bank/statement.csv');
  assert.match(csv.data, /^Date,Description,Amount\n\d{4}-\d{2}-\d{2},"SIM BANK SIMTXN-/);

  const admin = await t.signIn('admin');
  const body = { amount: 12.5, currency: 'AUD', method: 'EFT', beneficiary: { accountName: 'Test (SIM)', bsb: '999-009', accountNumber: '1234567' }, reference: 'manual test' };
  assert.equal((await payer.post('/api/sim-bank/payments', body, { headers: { 'Idempotency-Key': 'manual-1' } })).status, 403);
  assert.equal((await admin.post('/api/sim-bank/payments', body)).status, 400, 'an Idempotency-Key is required');
  const first = await admin.post('/api/sim-bank/payments', body, { headers: { 'Idempotency-Key': 'manual-1' } });
  assert.equal(first.status, 201);
  const repeat = await admin.post('/api/sim-bank/payments', body, { headers: { 'Idempotency-Key': 'manual-1' } });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.ref, first.data.ref);
  assert.equal(repeat.data.duplicate, true);
  const conflict = await admin.post('/api/sim-bank/payments', { ...body, amount: 99 }, { headers: { 'Idempotency-Key': 'manual-1' } });
  assert.equal(conflict.status, 409);
});

test('the payment calendar is published for the scheduling form', async () => {
  const reviewer = await t.signIn('reviewer');
  const c = (await reviewer.get('/api/payment-calendar')).data;
  assert.equal(c.timeZone, 'Australia/Sydney');
  assert.equal(c.cutoff, '23:59');
  assert.ok(c.nextSlot.date);
});
