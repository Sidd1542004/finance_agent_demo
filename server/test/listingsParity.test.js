// The record lists moved from the route handlers into services/listings.js.
// Each route's body must be byte for byte the service's output for the same
// person, for every role, with the same bank-detail masking (reviewers see
// none, everyone else sees them masked). The services also check the actor
// again, so a tool cannot call them without an authenticated person.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PEOPLE } from '../test-support/app.js';
import { person } from '../test-support/actors.js';

const t = await startApp({ BUSINESS_DAYS: 'Mon-Sun', PAYMENT_CUTOFF: '23:59', PAYMENT_DEFAULT_TIME: '00:00', BANK_HOLIDAYS: '2000-01-01', SIM_BANK_DELAY_SECONDS: '0' });
test.after(t.stop);

const listings = await import('../src/services/listings.js');
const { Payment } = await import('../src/models/index.js');
const CRON = { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } };
const BLUEGUM = '36600733916';
// Full values the sample suppliers and the proposal below hold (see bankMasking.test.js).
const FULL = ['10482001', '20518342', 'PAL8342', '33916001', '999-001', '999-002', '999-003', '99001'];
const ROLES = ['reviewer', 'approver', 'payer', 'admin', 'approverPayer'];

const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.data));
  return res.data;
};

const signedIn = {};
for (const key of ROLES) signedIn[key] = await t.signIn(key);
const { reviewer, approver, payer } = signedIn;

// ----- some of everything: invoices waiting and paid, a payment through the
// simulated bank (with a notice), a pending bank-detail change, supplier
// emails, a bank statement and a month-end report -----
const paidInvoice = ok(await reviewer.post('/api/invoices', { sampleId: 'clean' }), 201).invoice._id;
for (const sampleId of ['over-limit', 'price-variance', 'unknown-supplier']) ok(await reviewer.post('/api/invoices', { sampleId }), 201);
ok(await approver.post(`/api/invoices/${paidInvoice}/actions/approve`, { note: 'Checked against the PDF.' }));
const { nextSlot } = ok(await payer.get('/api/payment-calendar'));
ok(await payer.post(`/api/invoices/${paidInvoice}/actions/schedule_payment`, { method: 'EFT', scheduledFor: nextSlot.date, scheduledTime: nextSlot.time }));
await t.client().get('/api/cron/tick', CRON);
const payment = await Payment.findOne({ invoiceId: paidInvoice }).lean();
assert.equal(payment.status, 'paid');
ok(
  await payer.post(`/api/suppliers/${BLUEGUM}/beneficiary-changes`, {
    accountName: 'Bluegum IT (SIMULATED)',
    bsb: '999-003',
    accountNumber: '33916001',
    reason: 'Call-back to the number on file.',
  }),
  201,
);
for (const sampleId of ['status-approved', 'bank-change']) ok(await reviewer.post('/api/queries', { sampleId }), 201);
ok(await payer.post('/api/statements', { sampleId: 'october' }), 201);
ok(await reviewer.post('/api/reports', { month: '2026-10' }), 201);

const raw = async (key, url) => {
  const res = await fetch(`${t.base}${url}`, { headers: { cookie: signedIn[key].cookie } });
  return { status: res.status, body: await res.text() };
};
const actorFor = (key) => person(PEOPLE[key].name, PEOPLE[key].roles);

// Route URL -> the same listing from the service.
const firstPage = ok(await reviewer.get('/api/invoices?limit=2'));
assert.ok(firstPage.nextCursor, 'enough invoices for a second page');
const CASES = [
  ['/api/invoices', (a) => listings.listInvoices(a, {})],
  ['/api/invoices?filter=waiting', (a) => listings.listInvoices(a, { filter: 'waiting' })],
  ['/api/invoices?filter=pay', (a) => listings.listInvoices(a, { filter: 'pay' })],
  ['/api/invoices?filter=all&limit=2', (a) => listings.listInvoices(a, { filter: 'all', limit: '2' })],
  [`/api/invoices?limit=2&before=${encodeURIComponent(firstPage.nextCursor)}`, (a) => listings.listInvoices(a, { limit: '2', before: firstPage.nextCursor })],
  ['/api/payments', (a) => listings.listPayments(a, {})],
  ['/api/payments?status=paid,queued,nonsense', (a) => listings.listPayments(a, { status: 'paid,queued,nonsense' })],
  [`/api/payments/${payment._id}`, (a) => listings.getPayment(a, String(payment._id))],
  ['/api/queries', (a) => listings.listQueries(a, {})],
  ['/api/queries?limit=1', (a) => listings.listQueries(a, { limit: '1' })],
  ['/api/statements', (a) => listings.listStatements(a, {})],
  ['/api/reports', (a) => listings.listReports(a, {})],
  ['/api/reference', (a) => listings.getReference(a)],
  ['/api/audit', (a) => listings.listAuditEntries(a, {})],
  ['/api/audit?limit=7', (a) => listings.listAuditEntries(a, { limit: '7' })],
  [`/api/audit?subjectId=${BLUEGUM}`, (a) => listings.listAuditEntries(a, { subjectId: BLUEGUM })],
  [`/api/audit?subjectId=${payment._id}`, (a) => listings.listAuditEntries(a, { subjectId: String(payment._id) })],
];

test('every listing route answers exactly what its service returns, for every role', async () => {
  for (const key of ROLES) {
    for (const [url, fromService] of CASES) {
      const route = await raw(key, url);
      assert.equal(route.status, 200, `${key} ${url}: ${route.body}`);
      assert.equal(route.body, JSON.stringify(await fromService(actorFor(key))), `${key} ${url}`);
    }
  }
});

test('the same refusals: unknown payment, bad cursor', async () => {
  for (const [url, fromService] of [
    ['/api/payments/not-an-id', (a) => listings.getPayment(a, 'not-an-id')],
    ['/api/payments/0123456789abcdef01234567', (a) => listings.getPayment(a, '0123456789abcdef01234567')],
    ['/api/invoices?before=yesterday', (a) => listings.listInvoices(a, { before: 'yesterday' })],
    ['/api/queries?before=yesterday', (a) => listings.listQueries(a, { before: 'yesterday' })],
  ]) {
    const route = await raw('payer', url);
    const err = await fromService(actorFor('payer')).then(
      () => assert.fail(`${url}: the service did not refuse`),
      (e) => e,
    );
    assert.equal(route.status, err.status, url);
    assert.equal(route.body, JSON.stringify({ error: err.message }), url);
  }
});

test('masking per role is preserved: reviewers see no bank details, the others see them masked', async () => {
  const id = String(payment._id);
  const reviewerView = await listings.getPayment(actorFor('reviewer'), id);
  assert.deepEqual(reviewerView.payment.beneficiary, { version: 1, method: 'EFT', hidden: true });
  assert.equal(reviewerView.transaction.beneficiary.hidden, true);
  assert.ok(reviewerView.notices.length >= 1);
  for (const n of reviewerView.notices) {
    assert.doesNotMatch(n.body, /BSB|BPAY biller|SIMCARD/);
    assert.match(n.body, /\[bank details hidden\]/);
  }
  const reviewerAudit = (await listings.listAuditEntries(actorFor('reviewer'), { subjectId: BLUEGUM })).items;
  assert.ok(reviewerAudit.some((e) => e.action === 'bank_details_proposed'));
  for (const e of reviewerAudit) assert.equal(e.detail, 'Bank details are hidden for your role.');

  for (const key of ['payer', 'approver', 'admin', 'approverPayer']) {
    const view = await listings.getPayment(actorFor(key), id);
    assert.equal(view.payment.beneficiary.masked.bsb, '999-•••', key);
    assert.equal(view.transaction.beneficiary.hidden, false, key);
    assert.match(view.transaction.beneficiary.accountNumber, /^•••/, key);
    const audit = (await listings.listAuditEntries(actorFor(key), { subjectId: BLUEGUM })).items.find((e) => e.action === 'bank_details_proposed');
    assert.match(audit.detail, /BSB 999-•••/, key);
  }

  // No full value in any listing, for anyone; no masked digits at all for a reviewer.
  for (const key of ROLES) {
    for (const [url, fromService] of CASES) {
      const body = JSON.stringify(await fromService(actorFor(key)));
      for (const v of FULL) assert.ok(!body.includes(v), `${key} ${url} contains ${v}`);
      if (key === 'reviewer') assert.ok(!body.includes('•••'), `${url} shows masked digits to a reviewer`);
    }
  }
});

test('the services check the actor themselves: no person or no role, no records', async () => {
  const calls = [
    (a) => listings.listInvoices(a, {}),
    (a) => listings.listPayments(a, {}),
    (a) => listings.getPayment(a, String(payment._id)),
    (a) => listings.listQueries(a, {}),
    (a) => listings.listStatements(a, {}),
    (a) => listings.listReports(a, {}),
    (a) => listings.getReference(a),
    (a) => listings.listAuditEntries(a, {}),
  ];
  for (const call of calls) {
    await assert.rejects(() => call(null), { status: 401 });
    // An object built from data (for example a model's arguments) is never an actor.
    await assert.rejects(() => call({ id: 'u-x', name: 'Typed Name', roles: ['admin'] }), { status: 401 });
    await assert.rejects(() => call(person('No Role', [])), { status: 403 });
  }
});
