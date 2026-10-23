// Supplier payment notices: only after confirmed success (or on request for
// processing / failed, with the right wording), one per payment and
// transaction, approved by a person, and never delivered to a supplier
// outside production.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailDelivery, deliveryMode } from '../src/services/emailDelivery.js';
import { composePaymentNotice, noticeBlock } from '../src/agent/finance/paymentEmails.js';
import { startPayments, PALLETS } from '../test-support/payments.js';

const fakeMailer = () => {
  const sent = [];
  return { sent, via: 'fake', send: async (m) => (sent.push(m), { id: `m-${sent.length}` }) };
};

test('delivery: real email to a supplier needs APP_ENV=production AND SUPPLIER_EMAIL_MODE=live', () => {
  const mailer = fakeMailer();
  assert.equal(deliveryMode({ appEnv: 'production', mode: 'live', testRecipient: '', mailer }), 'live');
  assert.equal(deliveryMode({ appEnv: 'development', mode: 'live', testRecipient: '', mailer }), 'simulated_outbox', 'live mode alone is not enough');
  assert.equal(deliveryMode({ appEnv: 'preview', mode: 'live', testRecipient: 'qa@test.example', mailer }), 'test_recipient');
  assert.equal(deliveryMode({ appEnv: 'production', mode: 'outbox', testRecipient: '', mailer }), 'simulated_outbox', 'production alone is not enough');
  assert.equal(deliveryMode({ appEnv: 'production', mode: 'live', testRecipient: '', mailer: null }), 'simulated_outbox', 'no email service: nothing is sent');
  assert.equal(deliveryMode({ appEnv: 'development', mode: 'outbox', testRecipient: 'qa@test.example', mailer: null }), 'simulated_outbox');
});

test('outside production a notice goes to the test recipient, marked as a test, or nowhere', async () => {
  const mailer = fakeMailer();
  const test1 = createEmailDelivery({ appEnv: 'development', mode: 'live', testRecipient: 'qa@test.example', mailer });
  const r = await test1.deliver({ to: 'ar@supplier.example', subject: 'Payment made', text: 'Body' });
  assert.deepEqual([r.mode, r.deliveredTo, r.intendedTo, r.redirected], ['test_recipient', 'qa@test.example', 'ar@supplier.example', true]);
  assert.deepEqual(mailer.sent[0].to, ['qa@test.example']);
  assert.match(mailer.sent[0].subject, /^\[TEST, for ar@supplier\.example\] Payment made$/);
  assert.match(mailer.sent[0].text, /^TEST MESSAGE\. In production this would have gone to ar@supplier\.example/);

  const outbox = createEmailDelivery({ appEnv: 'development', mode: 'outbox', mailer });
  const o = await outbox.deliver({ to: 'ar@supplier.example', subject: 's', text: 't' });
  assert.deepEqual([o.mode, o.deliveredTo], ['simulated_outbox', null]);
  assert.equal(mailer.sent.length, 1, 'nothing more was emailed');

  const live = createEmailDelivery({ appEnv: 'production', mode: 'live', mailer });
  const l = await live.deliver({ to: 'ar@supplier.example', subject: 's', text: 't' });
  assert.deepEqual([l.mode, l.deliveredTo, l.redirected], ['live', 'ar@supplier.example', false]);
});

test('templates: success only for a confirmed payment, with the verified details; processing and failure say so', () => {
  const base = {
    route: 'bank',
    invoiceNumber: 'INV-9',
    vendorName: 'Acme',
    method: 'EFT',
    currency: 'AUD',
    amount: 100,
    scheduleVersion: 1,
    beneficiary: { masked: { bsb: '999-001', accountNumber: '•••001' } },
  };
  const paid = { ...base, status: 'paid', confirmation: { txnRef: 'SIMTXN-1', confirmedAt: '2026-10-22T00:00:20Z', amount: 100 } };
  assert.equal(noticeBlock('payment_success', paid), null);
  assert.match(noticeBlock('payment_success', { ...base, status: 'processing', submission: { txnRef: 'SIMTXN-1' } }), /once the bank has confirmed/);
  assert.match(noticeBlock('payment_success', { ...base, status: 'failed' }), /once the bank has confirmed/);
  assert.match(noticeBlock('payment_success', { ...paid, route: 'manual' }), /simulated bank/);
  const s = composePaymentNotice({ kind: 'payment_success', payment: paid, companyName: 'Meridian', timeZone: 'Australia/Sydney' });
  assert.match(s.body, /Amount: \$100\.00/);
  assert.match(s.body, /SIMTXN-1/);
  assert.match(s.body, /Confirmed by the bank on: 2026-10-22/);
  assert.match(s.body, /BSB 999-001, account •••001/);
  assert.match(s.body, /SIMULATED bank\. No money has moved/);
  const pr = composePaymentNotice({
    kind: 'payment_processing',
    payment: { ...base, status: 'processing', submission: { txnRef: 'SIMTXN-2', amount: 100 } },
    companyName: 'M',
    timeZone: 'UTC',
  });
  assert.match(pr.body, /not confirmed yet/);
  assert.doesNotMatch(pr.body, /We have paid/);
  const f = composePaymentNotice({ kind: 'payment_failed', payment: { ...base, status: 'failed' }, companyName: 'M', timeZone: 'UTC' });
  assert.match(f.body, /did not go through\. Nothing has been paid/);
});

// ----- on the database, with the executor -----

const h = await startPayments();
test.after(h.stop);
const { models } = h;
const person = { id: 'u-rev', name: 'Rita Reviewer', roles: ['reviewer'] };

test('one success notice per confirmed payment, however many ticks or requests', async () => {
  const { paymentId } = await h.scheduled({ total: 120 });
  await h.executor().tick();
  assert.equal(await models.OutboxMessage.countDocuments({ paymentId }), 0, 'processing: no notice');
  await assert.rejects(h.notices.draft(paymentId, 'payment_success', person), (err) => err.status === 409);
  // A processing notice can be asked for, and says it is not confirmed.
  const processing = await h.notices.draft(paymentId, 'payment_processing', person);
  assert.equal(processing.created, true);
  assert.match(processing.message.body, /not confirmed yet/);

  h.advance(25);
  await Promise.all([h.executor().tick(), h.executor().tick()]);
  const many = await Promise.all(Array.from({ length: 5 }, () => h.notices.draft(paymentId, 'payment_success', person)));
  assert.equal(many.filter((r) => r.created).length, 0, 'the tick already drafted it');
  assert.equal(await models.OutboxMessage.countDocuments({ paymentId, kind: 'payment_success' }), 1);
  const notice = await models.OutboxMessage.findOne({ paymentId, kind: 'payment_success' }).lean();
  assert.equal(notice.status, 'draft', 'a person approves it first');
  assert.match(notice.txnRef, /^SIMTXN-/);
  assert.equal(notice.to, 'accounts@harbouroffice.example');
});

test('approving sends it once, to the simulated outbox by default; the processing notice can no longer be sent', async () => {
  const { paymentId } = await h.scheduled({ total: 130 });
  await h.executor().tick();
  const processing = (await h.notices.draft(paymentId, 'payment_processing', person)).message;
  h.advance(25);
  await h.executor().tick();
  const success = await models.OutboxMessage.findOne({ paymentId, kind: 'payment_success' }).lean();

  const sent = await h.notices.approveAndSend(String(success._id), person);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sentBy, 'Rita Reviewer');
  assert.deepEqual([sent.delivery.mode, sent.delivery.deliveredTo, sent.delivery.intendedTo], ['simulated_outbox', null, 'accounts@harbouroffice.example']);
  await assert.rejects(h.notices.approveAndSend(String(success._id), person), (err) => err.status === 409, 'only once');
  await assert.rejects(h.notices.approveAndSend(String(processing._id), person), (err) => err.status === 409 && /changed since/.test(err.message), 'out of date');
  const log = await models.AuditEvent.find({ subjectId: String(success._id) }).lean();
  assert.deepEqual(
    log.map((e) => e.action),
    ['drafted', 'approved_and_sent'],
  );
});

test('a failed payment never gets a success notice; a failure notice is drafted on request only', async () => {
  await h.simBank.setScenario(PALLETS.abn, 'settle_failure', null);
  const { paymentId } = await h.scheduled({ supplier: PALLETS, total: 140 });
  await h.executor().tick();
  h.advance(25);
  await h.executor().tick();
  assert.equal((await h.payment(paymentId)).status, 'failed');
  assert.equal(await models.OutboxMessage.countDocuments({ paymentId }), 0, 'nothing automatic');
  await assert.rejects(h.notices.draft(paymentId, 'payment_success', person), (err) => err.status === 409);
  const f = await h.notices.draft(paymentId, 'payment_failed', person);
  assert.match(f.message.body, /did not go through/);
  await assert.rejects(h.notices.discard(String(f.message._id), person, ''), (err) => err.status === 400);
  const d = await h.notices.discard(String(f.message._id), person, 'Calling them instead.');
  assert.equal(d.status, 'discarded');
});
