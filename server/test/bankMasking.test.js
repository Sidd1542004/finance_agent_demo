// Stored bank details are masked by default and hidden from reviewers,
// everywhere they are sent back; only approvers and administrators can reveal
// them, with a reason, and every reveal is in the audit log. Invoice documents
// are not masked (they are what the supplier sent).
//
// A real payment runs end to end first (approve, schedule by EFT, the bank
// confirms it, a confirmation notice is drafted), then every route a reviewer
// or a payer can reach is scanned for the digits.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../test-support/app.js';

const t = await startApp({ BUSINESS_DAYS: 'Mon-Sun', PAYMENT_CUTOFF: '23:59', PAYMENT_DEFAULT_TIME: '00:00', BANK_HOLIDAYS: '2000-01-01', SIM_BANK_DELAY_SECONDS: '0' });
test.after(t.stop);

const { AuditEvent, OutboxMessage, Payment } = await import('../src/models/index.js');
const HARBOUR = '57600410275';
const BLUEGUM = '36600733916';
const CRON = { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } };
// Every full value the sample suppliers and the proposal below hold. (Harbour's CRN,
// 5760041027, is left out: its digits are part of Harbour's ABN, which is public. It is
// checked as masked below.)
const FULL = ['10482001', '20518342', 'PAL8342', '33916001', '999-001', '999-002', '999-003', '99001'];

const reviewer = await t.signIn('reviewer');
const approver = await t.signIn('approver');
const payer = await t.signIn('payer');
const admin = await t.signIn('admin');

// ----- a payment through the simulated bank, and a pending bank-detail change -----
const invoiceId = (await reviewer.post('/api/invoices', { sampleId: 'clean' })).data.invoice._id;
assert.equal((await approver.post(`/api/invoices/${invoiceId}/actions/approve`, { note: 'Checked against the PDF.' })).status, 200);
const { nextSlot } = (await payer.get('/api/payment-calendar')).data;
const scheduled = await payer.post(`/api/invoices/${invoiceId}/actions/schedule_payment`, { method: 'EFT', scheduledFor: nextSlot.date, scheduledTime: nextSlot.time });
assert.equal(scheduled.status, 200, JSON.stringify(scheduled.data));
await t.client().get('/api/cron/tick', CRON);
const payment = await Payment.findOne({ invoiceId }).lean();
assert.equal(payment.status, 'paid');
const txnRef = payment.confirmation.txnRef;
const proposal = await payer.post(`/api/suppliers/${BLUEGUM}/beneficiary-changes`, {
  accountName: 'Bluegum IT (SIMULATED)',
  bsb: '999-003',
  accountNumber: '33916001',
  reason: 'Call-back to the number on file.',
});
assert.equal(proposal.status, 201, JSON.stringify(proposal.data));

// Records written before BSBs were masked: an audit entry and a draft notice with the full BSB.
await AuditEvent.create({
  subjectKind: 'supplier',
  subjectId: HARBOUR,
  actor: 'Old record',
  action: 'bank_details_proposed',
  detail: 'Proposed Harbour (SIMULATED), BSB 999-001 account •••001, BPAY 99001 ref •••027 (simulated).',
  at: new Date(),
});
await OutboxMessage.create({
  kind: 'payment_processing',
  paymentId: payment._id,
  invoiceId,
  dedupKey: `${payment._id}:old`,
  to: 'accounts@harbouroffice.example',
  subject: 'Old notice',
  body: 'Paid to: BSB 999-001, account •••001 (EFT)\nBPAY biller 99001, reference •••027',
  status: 'draft',
});

const ROUTES = [
  '/api/reference',
  '/api/suppliers',
  `/api/suppliers/${HARBOUR}/history`,
  `/api/suppliers/${BLUEGUM}/history`,
  `/api/invoices/${invoiceId}`,
  `/api/payments/${payment._id}`,
  '/api/payment-notices',
  '/api/audit?limit=500',
  `/api/audit?subjectId=${BLUEGUM}`,
  `/api/audit?subjectId=${HARBOUR}`,
];
const text = async (c, url) => {
  const res = await c.get(url);
  assert.equal(res.status, 200, `${url}: ${JSON.stringify(res.data)}`);
  return JSON.stringify(res.data);
};

test('a reviewer never sees stored bank details, not even masked, on any route', async () => {
  for (const url of ROUTES) {
    const body = await text(reviewer, url);
    for (const v of FULL) assert.ok(!body.includes(v), `${url} contains ${v}`);
    assert.ok(!body.includes('•••'), `${url} shows masked digits to a reviewer`);
  }
  const notices = (await reviewer.get('/api/payment-notices')).data.items;
  assert.ok(notices.length >= 2);
  for (const n of notices) assert.doesNotMatch(n.body, /BSB|BPAY biller|SIMCARD/, 'no account in a notice');
  assert.ok(notices.some((n) => n.body.includes('[bank details hidden]')));
  const pay = (await reviewer.get(`/api/payments/${payment._id}`)).data;
  assert.deepEqual(pay.payment.beneficiary, { version: 1, method: 'EFT', hidden: true });
  assert.equal(pay.transaction.beneficiary.hidden, true);
  const harbour = (await reviewer.get('/api/suppliers')).data.items.find((s) => s.abn === HARBOUR);
  assert.equal(harbour.beneficiary.hidden, true);
  assert.equal(harbour.beneficiary.status, 'verified', 'whether they are verified is still shown');
  assert.equal(harbour.canReveal, false);
  const audit = (await reviewer.get(`/api/audit?subjectId=${HARBOUR}`)).data.items.find((e) => e.actor === 'Old record');
  assert.equal(audit.detail, 'Bank details are hidden for your role.');
});

test('payers, approvers and administrators see masked details only, including records written before masking', async () => {
  for (const c of [payer, approver, admin]) {
    for (const url of [...ROUTES, '/api/sim-bank/transactions', `/api/sim-bank/transactions/${txnRef}`]) {
      const body = await text(c, url);
      for (const v of FULL) assert.ok(!body.includes(v), `${url} contains ${v}`);
    }
  }
  const harbour = (await payer.get('/api/suppliers')).data.items.find((s) => s.abn === HARBOUR);
  assert.equal(harbour.beneficiary.bsb, '999-•••');
  assert.equal(harbour.beneficiary.accountNumber, '•••001');
  assert.equal(harbour.beneficiary.crn, '•••027');
  assert.equal(harbour.beneficiary.billerCode, '•••01');
  assert.equal(harbour.canReveal, false, 'payers cannot reveal');
  const bluegum = (await approver.get('/api/suppliers')).data.items.find((s) => s.abn === BLUEGUM);
  assert.equal(bluegum.pending.details.accountNumber, '•••001', 'a pending change is masked for the approver too');
  assert.equal(bluegum.canReveal, true);
  const old = (await payer.get(`/api/audit?subjectId=${HARBOUR}`)).data.items.find((e) => e.actor === 'Old record');
  assert.match(old.detail, /BSB 999-••• account •••001, BPAY •••01 ref/);
  const oldNotice = (await payer.get('/api/payment-notices')).data.items.find((n) => n.subject === 'Old notice');
  assert.equal(oldNotice.body, 'Paid to: BSB 999-•••, account •••001 (EFT)\nBPAY biller •••01, reference •••027');
  const inv = (await payer.get(`/api/invoices/${invoiceId}`)).data;
  assert.equal(inv.payment.beneficiary.masked.bsb, '999-•••');
});

test('the reveal: approvers and administrators only, with a reason, never cached, and logged without the digits', async () => {
  const url = (abn) => `/api/suppliers/${abn}/bank-details/reveal`;
  assert.equal((await t.client().post(url(BLUEGUM), { target: 'pending', reason: 'To check it.' })).status, 401);
  for (const c of [reviewer, payer]) assert.equal((await c.post(url(BLUEGUM), { target: 'pending', reason: 'To check it.' })).status, 403);
  assert.equal((await approver.post(url(BLUEGUM), { target: 'pending' })).status, 400, 'a reason is required');
  assert.equal((await approver.post(url(BLUEGUM), { target: 'pending', reason: 'ok' })).status, 400, 'more than a word');
  assert.equal((await approver.post(url(BLUEGUM), { target: 'everything', reason: 'To check it.' })).status, 400);
  assert.equal((await approver.post(url(BLUEGUM), { target: 'current', reason: 'To check it.' })).status, 404, 'Bluegum has no verified details yet');
  assert.equal((await approver.post(url(BLUEGUM), { target: 'pending', reason: 'To check it.' }, { csrf: false })).status, 403, 'CSRF');

  const res = await approver.post(url(BLUEGUM), { target: 'pending', reason: 'Checking it against the call-back record.' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.data.details.accountNumber, '33916001');
  assert.equal(res.data.details.bsb, '999-003');
  assert.equal(res.data.proposedBy, 'Sam Payer');
  const current = await admin.post(url(HARBOUR), { target: 'current', reason: 'Confirming the verified account.' });
  assert.equal(current.data.details.accountNumber, '10482001');
  assert.equal(current.data.version, 1);

  const entries = await AuditEvent.find({ action: 'bank_details_revealed' }).sort({ at: 1 }).lean();
  assert.equal(entries.length, 2, 'every reveal, and only the reveals that happened');
  assert.deepEqual(
    entries.map((e) => [e.subjectId, e.actor, e.reason]),
    [
      [BLUEGUM, 'Priya Approver', 'Checking it against the call-back record.'],
      [HARBOUR, 'Ada Admin', 'Confirming the verified account.'],
    ],
  );
  for (const e of entries) {
    assert.ok(e.actorId);
    for (const v of FULL) assert.ok(!JSON.stringify(e).includes(v), `the audit entry holds ${v}`);
  }
  assert.match(entries[0].detail, /the pending change proposed by Sam Payer/);
  // Reviewers reading the log see that a reveal happened, not what was revealed.
  const seen = (await reviewer.get(`/api/audit?subjectId=${BLUEGUM}`)).data.items.find((e) => e.action === 'bank_details_revealed');
  assert.equal(seen.actor, 'Priya Approver');
  assert.equal(seen.detail, 'Bank details are hidden for your role.');
});

test('payment notices: only approvers and administrators send them; discarding is open to payers, reviewers and approvers', async () => {
  const draft = await OutboxMessage.findOne({ kind: 'payment_success', status: 'draft' }).lean();
  for (const c of [reviewer, payer]) assert.equal((await c.post(`/api/payment-notices/${draft._id}/send`)).status, 403);
  const sent = await admin.post(`/api/payment-notices/${draft._id}/send`);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.message.status, 'sent');
  const old = await OutboxMessage.findOne({ subject: 'Old notice' }).lean();
  assert.equal((await approver.post(`/api/payment-notices/${old._id}/discard`, { note: 'Out of date.' })).status, 200);
});

test('invoice documents are not masked: the invoice text is shown as the supplier sent it', async () => {
  const email = (await reviewer.post('/api/queries', { sampleId: 'bank-change' })).data;
  assert.match(email.query.body, /BSB 000-000, account number 0000 0000/, 'a supplier email is shown as written');
});
