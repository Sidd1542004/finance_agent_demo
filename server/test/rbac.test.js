// Role-based access control: what each role may and may not do, checked on
// the real Express app against an in-memory MongoDB (test-support/mongo.js).
// Every request goes straight to the API, as a script would, so nothing here
// depends on the dashboard hiding a button.
//
// Policy: reviewer, approver and payer as in docs/payments.md; an administrator
// also holds those three roles (auth/roles.js) but every other control still
// applies to them (segregation of duties, two-person bank details, status checks).
//
// No payment is scheduled, submitted or run here: payment actions are checked
// up to the role, segregation-of-duties and status checks, which come before
// anything is changed. No reset is run. No email leaves the process.

import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startApp, PASSWORD } from '../test-support/app.js';

// SEGREGATE_DUTIES on: the approver of an invoice cannot also pay or record it.
const t = await startApp({ SEGREGATE_DUTIES: 'true' });
test.after(t.stop);

const { requireAnyRole, requireRole, NO_ROLE, CSRF_REFUSED } = await import('../src/auth/middleware.js');
const { effectiveRoles, hasRole } = await import('../src/auth/roles.js');
const { approvedBySamePerson, SAME_PERSON_PAYS } = await import('../src/agent/finance/lifecycle.js');
const { Invoice, Payment, BankStatement, AuditEvent } = await import('../src/models/index.js');

const reviewer = await t.signIn('reviewer');
const approver = await t.signIn('approver');
const payer = await t.signIn('payer');
const admin = await t.signIn('admin');
const both = await t.signIn('approverPayer'); // approver + payer
const idOf = (key) => String(t.users[key].id ?? t.users[key]._id);

// An account with no role, created the normal way by an administrator.
const created = await admin.post('/api/admin/users', { email: 'nobody@test.example', name: 'Nora Norole', password: PASSWORD, roles: [] });
assert.equal(created.status, 201, JSON.stringify(created.data));
const noRole = t.client();
assert.equal((await noRole.post('/api/auth/login', { email: 'nobody@test.example', password: PASSWORD })).status, 200);

const NOT_ADMIN = { reviewer, approver, payer, both };
const EVERY_ROLE = { reviewer, approver, payer, admin, both };
const paymentCount = () => Payment.countDocuments();

// A fake Express request/response, for the middleware on its own.
function runMiddleware(mw, user) {
  let status = 200;
  let body = null;
  let passed = false;
  const res = {
    status(s) {
      status = s;
      return this;
    },
    json(b) {
      body = b;
      return this;
    },
  };
  mw({ user }, res, () => {
    passed = true;
  });
  return { status, body, passed };
}

// ---------- the role rule ----------

test('an administrator holds every working role; no other role implies anything', () => {
  assert.deepEqual(effectiveRoles(['admin']).sort(), ['admin', 'approver', 'payer', 'reviewer']);
  assert.deepEqual(effectiveRoles(['reviewer']), ['reviewer']);
  assert.deepEqual(effectiveRoles(['approver', 'payer']).sort(), ['approver', 'payer']);
  // Unknown or odd values grant nothing extra (and never admin).
  for (const roles of [[], ['superuser'], ['Admin'], ['constructor'], ['__proto__'], [null, 7], null, 'admin']) {
    const held = effectiveRoles(roles);
    assert.ok(!held.includes('admin') && !held.includes('payer') && !held.includes('approver') && !held.includes('reviewer'), JSON.stringify(roles));
  }
  assert.equal(hasRole({ roles: ['reviewer'] }, 'admin'), false, 'nothing implies admin');
  assert.equal(hasRole({ roles: ['payer'] }, 'approver'), false);
  assert.equal(hasRole({ roles: ['admin'] }, 'payer'), true);
});

// ---------- signed out, no role, unknown roles ----------

test('signed out: every data route answers 401', async () => {
  const anon = t.client();
  for (const url of ['/api/invoices', '/api/queries', '/api/statements', '/api/reports', '/api/payments', '/api/suppliers', '/api/audit', '/api/payables', '/api/admin/users']) {
    assert.equal((await anon.get(url)).status, 401, url);
  }
  for (const url of ['/api/invoices', '/api/queries', '/api/statements', '/api/reports', '/api/reset', '/api/demo/load']) {
    assert.equal((await anon.post(url, {})).status, 401, url);
  }
});

test('an account with no role can sign in and see who it is, but no financial records', async () => {
  const me = await noRole.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.user.roles, []);
  for (const url of ['/api/invoices', '/api/queries', '/api/statements', '/api/reports', '/api/payments', '/api/suppliers', '/api/audit', '/api/payables', '/api/samples']) {
    const res = await noRole.get(url);
    assert.equal(res.status, 403, url);
    assert.equal(res.data.error, NO_ROLE, url);
  }
  assert.equal((await noRole.post('/api/reports', { month: '2026-10' })).status, 403);
  assert.equal((await noRole.post('/api/invoices', { sampleId: 'clean' })).status, 403);
  assert.equal((await noRole.get('/api/admin/users')).status, 403);
  assert.equal((await noRole.post('/api/reset', { confirm: 'RESET' })).status, 403);
});

test('a role the system does not know grants nothing', () => {
  for (const roles of [[], ['superuser'], ['Admin'], ['root', 'owner']]) {
    const r = runMiddleware(requireAnyRole, { id: 'u', name: 'X', roles });
    assert.equal(r.passed, false, JSON.stringify(roles));
    assert.equal(r.status, 403);
    assert.equal(r.body.error, NO_ROLE);
    assert.equal(runMiddleware(requireRole('admin'), { id: 'u', name: 'X', roles }).passed, false);
    assert.equal(runMiddleware(requireRole('payer'), { id: 'u', name: 'X', roles }).passed, false);
  }
  assert.equal(runMiddleware(requireAnyRole, null).status, 401);
  assert.equal(runMiddleware(requireAnyRole, { id: 'u', name: 'X', roles: ['payer'] }).passed, true);
  assert.equal(runMiddleware(requireRole('reviewer'), { id: 'u', name: 'X', roles: ['admin'] }).passed, true, 'admin holds reviewer');
});

test('an administrator cannot give an unknown role', async () => {
  const u = (await admin.get('/api/admin/users')).data.items.find((x) => x.email === 'nobody@test.example');
  assert.equal((await admin.patch(`/api/admin/users/${u.id}`, { roles: ['superuser'] })).status, 400);
});

// ---------- read access ----------

test('every role can read the records it works with; the administrator can open every module', async () => {
  const shared = ['/api/invoices', '/api/queries', '/api/statements', '/api/reports', '/api/payments', '/api/suppliers', '/api/audit', '/api/payables'];
  for (const [who, c] of Object.entries(EVERY_ROLE)) {
    for (const url of [...shared, '/api/payment-notices']) assert.equal((await c.get(url)).status, 200, `${who} ${url}`);
  }
  const adminOnly = ['/api/admin/users', '/api/admin/sim-bank', '/api/sim-bank/account', '/api/sim-bank/transactions'];
  for (const url of [...adminOnly, '/api/payment-calendar', '/api/query-samples', '/api/statement-sample']) {
    assert.equal((await admin.get(url)).status, 200, `admin ${url}`);
  }
});

// ---------- invoices ----------

let invoiceA; // clean: approved below by the approver-and-payer
let invoiceB; // price variance: approved below by the administrator
let invoiceC; // no PO: rejected below by the approver

test('reviewers and administrators add invoices; approvers and payers cannot', async () => {
  for (const [who, c] of Object.entries({ approver, payer, both })) {
    const res = await c.post('/api/invoices', { sampleId: 'clean' });
    assert.equal(res.status, 403, who);
    assert.equal(res.data.error, 'This needs the reviewer role.');
  }
  const add = async (c, sampleId) => {
    const res = await c.post('/api/invoices', { sampleId });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data.invoice._id;
  };
  invoiceA = await add(reviewer, 'clean');
  invoiceB = await add(reviewer, 'price-variance');
  invoiceC = await add(reviewer, 'no-po');
  await add(admin, 'unknown-supplier');
});

test('a reviewer works on an invoice but cannot approve or reject it, by any route', async () => {
  const before = await Invoice.findById(invoiceA).lean();
  // Reviewer actions pass the role check (the note rule is checked after it).
  const hold = await reviewer.post(`/api/invoices/${invoiceA}/actions/hold`, {});
  assert.equal(hold.status, 400, JSON.stringify(hold.data));
  assert.match(hold.data.error, /note/i);

  for (const action of ['approve', 'approve_received', 'reject', 'cancel', 'clear_duplicate']) {
    const res = await reviewer.post(`/api/invoices/${invoiceA}/actions/${action}`, { note: 'trying', decidedBy: 'Priya Approver' });
    assert.equal(res.status, 403, action);
  }
  assert.equal((await reviewer.post(`/api/invoices/${invoiceA}/approval`, { decision: 'approve', decidedBy: 'Priya Approver' })).status, 403, 'the earlier approval route too');

  const after = await Invoice.findById(invoiceA).lean();
  assert.equal(after.status, before.status, 'nothing changed');
  assert.equal(after.approval, null);
});

test('a payer does not approve: they do not hold the approver role', async () => {
  const res = await payer.post(`/api/invoices/${invoiceA}/actions/approve`, {});
  assert.equal(res.status, 403);
  assert.match(res.data.error, /approver role/);
});

test('the server tells the dashboard which actions the person may take', async () => {
  const permitted = async (c) => Object.fromEntries((await c.get(`/api/invoices/${invoiceA}`)).data.actions.map((a) => [a.id, a.permitted]));
  const forAdmin = await permitted(admin);
  assert.equal(forAdmin.approve, true);
  assert.equal(forAdmin.hold, true);
  const forReviewer = await permitted(reviewer);
  assert.equal(forReviewer.approve, false);
  assert.equal(forReviewer.hold, true);
});

test('approvers and administrators approve or reject, each under their own account', async () => {
  const rejected = await approver.post(`/api/invoices/${invoiceC}/actions/reject`, { note: 'No purchase order.', decidedBy: 'Someone Else' });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  assert.equal(rejected.data.invoice.status, 'rejected');

  const ok = await both.post(`/api/invoices/${invoiceA}/actions/approve`, {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.invoice.status, 'approved');
  assert.equal(ok.data.invoice.approval.decidedBy, 'Alex Both');
  assert.equal(ok.data.invoice.approval.decidedById, idOf('approverPayer'));

  // The administrator approves too; the exception still needs a note.
  const noNote = await admin.post(`/api/invoices/${invoiceB}/actions/approve`, {});
  assert.equal(noNote.status, 400, 'an administrator still follows the note rule');
  const byAdmin = await admin.post(`/api/invoices/${invoiceB}/actions/approve`, { note: 'Price agreed by phone.', decidedBy: 'Priya Approver' });
  assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.data));
  assert.equal(byAdmin.data.invoice.approval.decidedBy, 'Ada Admin', 'recorded under the administrator, not a typed name');
  assert.equal(byAdmin.data.invoice.approval.decidedById, idOf('admin'));

  for (const [id, actor] of [
    [invoiceA, 'Alex Both'],
    [invoiceB, 'Ada Admin'],
  ]) {
    const audit = await approver.get(`/api/audit?subjectId=${id}`);
    const entry = audit.data.items.find((e) => e.action === 'approve');
    assert.ok(entry, 'the approval is in the audit log');
    assert.equal(entry.actor, actor);
  }
});

// ---------- payments ----------

test('reviewers and approvers are refused payment actions', async () => {
  const payments = await paymentCount();
  for (const [who, c] of Object.entries({ reviewer, approver })) {
    for (const action of ['schedule_payment', 'record_payment', 'cancel_payment', 'reschedule_payment', 'payment_failed']) {
      const res = await c.post(`/api/invoices/${invoiceA}/actions/${action}`, { method: 'Cheque', note: 'x' });
      assert.equal(res.status, 403, `${who} ${action}`);
      assert.match(res.data.error, /payer role/);
    }
  }
  assert.equal(await paymentCount(), payments, 'no payment was created');
});

test('payers and administrators pass the role check, and the status check still applies to both', async () => {
  const payments = await paymentCount();
  // Recording needs a scheduled payment; this invoice has none, so it is refused (409) and nothing is paid.
  for (const [who, c] of Object.entries({ payer, admin })) {
    const res = await c.post(`/api/invoices/${invoiceA}/actions/record_payment`, {});
    assert.equal(res.status, 409, `${who}: ${JSON.stringify(res.data)}`);
    assert.doesNotMatch(res.data.error, /role/);
    // Cancelling a payment that was never scheduled: refused by the status check too.
    assert.equal((await c.post(`/api/invoices/${invoiceA}/actions/cancel_payment`, { note: 'x' })).status, 409, who);
  }
  assert.equal(await paymentCount(), payments, 'no payment was created');
  assert.equal((await Invoice.findById(invoiceA).lean()).status, 'approved');
});

test('segregation of duties: whoever approved an invoice cannot schedule or record its payment, administrators included', async () => {
  const payments = await paymentCount();
  for (const [who, c, id] of [
    ['approver+payer', both, invoiceA],
    ['administrator', admin, invoiceB],
  ]) {
    for (const action of ['schedule_payment', 'record_payment']) {
      const res = await c.post(`/api/invoices/${id}/actions/${action}`, { method: 'Cheque' });
      assert.equal(res.status, 403, `${who} ${action}`);
      assert.equal(res.data.error, SAME_PERSON_PAYS);
    }
  }
  assert.equal(await paymentCount(), payments, 'no payment was created');
  assert.equal((await Invoice.findById(invoiceB).lean()).status, 'approved');
});

test('approvedBySamePerson compares accounts first, then names for older typed approvals', () => {
  assert.equal(approvedBySamePerson(null, 'u1', 'Ann'), false);
  assert.equal(approvedBySamePerson({ decidedBy: 'Ann', decidedById: 'u1' }, 'u1', 'Someone'), true);
  assert.equal(approvedBySamePerson({ decidedBy: 'Ann', decidedById: 'u1' }, 'u2', 'Ann'), false, 'a namesake is another person');
  assert.equal(approvedBySamePerson({ decidedBy: 'Ann' }, 'u2', 'ann'), true, 'no account on the approval: by name');
});

// ---------- bank reconciliation ----------

test('payers and administrators reconcile bank statements; reviewers and approvers cannot', async () => {
  for (const [who, c] of Object.entries({ reviewer, approver })) {
    const res = await c.post('/api/statements', { sampleId: 'october' });
    assert.equal(res.status, 403, who);
    assert.equal(res.data.error, 'This needs the payer role.');
    const id = new mongoose.Types.ObjectId();
    assert.equal((await c.post(`/api/statements/${id}/lines/1/resolution`, { action: 'dismiss', note: 'x' })).status, 403, who);
    assert.equal((await c.post(`/api/statements/${id}/rerun`)).status, 403, who);
  }
  for (const [who, c] of Object.entries({ payer, admin })) {
    const ok = await c.post('/api/statements', { sampleId: 'october' });
    assert.equal(ok.status, 201, `${who}: ${JSON.stringify(ok.data)}`);
  }
  // The administrator can download the simulated bank's statement too (it was always allowed).
  assert.equal((await admin.get('/api/sim-bank/statement.csv')).status, 200);
});

// A scheduled (queued) cheque payment for an invoice `approverKey` approved, and a
// statement line the agent suggests for it. Inserted directly: nothing is scheduled.
async function bankLineFixture(n, approverKey, approverName) {
  const approval = { decision: 'approve', decidedBy: approverName, decidedById: idOf(approverKey), decidedAt: new Date().toISOString() };
  const number = `SOD-${n}`;
  const invoice = await Invoice.create({
    source: { kind: 'paste' },
    rawText: 'fixture',
    status: 'payment_pending',
    approval,
    extracted: { invoiceNumber: number, vendorName: 'Fixture Pty Ltd', total: 110 },
  });
  const payment = await Payment.create({ invoiceId: invoice._id, invoiceNumber: number, vendorName: 'Fixture Pty Ltd', amount: 110, status: 'queued', route: 'manual' });
  const statement = await BankStatement.create({
    source: { kind: 'paste' },
    rawText: 'fixture',
    status: 'needs_person',
    lines: [
      {
        n: 1,
        date: '2026-10-22',
        description: `CHQ ${number}`,
        amount: -110,
        status: 'suggested',
        kind: 'suggested',
        reason: 'fixture',
        candidate: { paymentId: String(payment._id), invoiceNumber: number, vendorName: 'Fixture Pty Ltd' },
      },
    ],
  });
  return { invoice, payment, url: `/api/statements/${statement._id}/lines/1/resolution`, statementId: statement._id };
}

test('segregation of duties: matching a bank line records the payment, so its approver cannot do it, administrators included', async () => {
  for (const [n, key, name, c] of [
    [1, 'approverPayer', 'Alex Both', both],
    [2, 'admin', 'Ada Admin', admin],
  ]) {
    const f = await bankLineFixture(n, key, name);
    const denied = await c.post(f.url, { action: 'confirm' });
    assert.equal(denied.status, 403, `${name}: ${JSON.stringify(denied.data)}`);
    assert.equal(denied.data.error, SAME_PERSON_PAYS);
    assert.equal((await Payment.findById(f.payment._id).lean()).status, 'queued', 'not marked paid');
    assert.equal((await Invoice.findById(f.invoice._id).lean()).status, 'payment_pending');
    assert.equal((await BankStatement.findById(f.statementId).lean()).lines[0].status, 'suggested');

    // Another payer can: the bank line is their evidence, and it is on record under their account.
    const ok = await payer.post(f.url, { action: 'confirm' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal((await Payment.findById(f.payment._id).lean()).status, 'paid');
    assert.equal((await Invoice.findById(f.invoice._id).lean()).status, 'payment_completed');
  }
  const entry = await AuditEvent.findOne({ subjectKind: 'bank_line', action: 'confirm' }).lean();
  assert.equal(entry.actor, 'Sam Payer');
  assert.ok(entry.actorId);
});

// ---------- supplier emails ----------

test('reviewers and administrators process supplier emails; approvers and payers cannot', async () => {
  const [sample] = (await reviewer.get('/api/query-samples')).data;
  for (const [who, c] of Object.entries({ approver, payer })) {
    const res = await c.post('/api/queries', { sampleId: sample.id });
    assert.equal(res.status, 403, who);
    assert.equal(res.data.error, 'This needs the reviewer role.');
    const id = new mongoose.Types.ObjectId();
    assert.equal((await c.post(`/api/queries/${id}/resolution`, { action: 'close', note: 'x' })).status, 403, who);
    assert.equal((await c.post(`/api/queries/${id}/rerun`)).status, 403, who);
  }
  for (const [who, c] of Object.entries({ reviewer, admin })) {
    const ok = await c.post('/api/queries', { sampleId: sample.id });
    assert.equal(ok.status, 201, `${who}: ${JSON.stringify(ok.data)}`);
  }
});

// ---------- supplier bank details ----------

test('an administrator cannot approve their own bank-detail proposal: a second person is still needed', async () => {
  const BLUEGUM = '36600733916';
  const details = { accountName: 'Bluegum IT (SIMULATED)', bsb: '999-003', accountNumber: '33916001', reason: 'Confirmed by phone on a number from our records.' };
  const proposed = await admin.post(`/api/suppliers/${BLUEGUM}/beneficiary-changes`, details);
  assert.equal(proposed.status, 201, JSON.stringify(proposed.data));
  const self = await admin.post(`/api/beneficiary-changes/${proposed.data.id}/approve`, {});
  assert.equal(self.status, 403);
  assert.match(self.data.error, /someone else must approve/);
  assert.equal((await reviewer.post(`/api/beneficiary-changes/${proposed.data.id}/approve`, {})).status, 403, 'reviewers cannot approve');
  const ok = await approver.post(`/api/beneficiary-changes/${proposed.data.id}/approve`, { note: 'Checked.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

// ---------- month-end report ----------

test('every role can write and read a month-end report; no role cannot', async () => {
  for (const [who, c] of Object.entries(EVERY_ROLE)) {
    const res = await c.post('/api/reports', { month: '2026-09' });
    assert.equal(res.status, 201, `${who}: ${JSON.stringify(res.data)}`);
    const id = res.data.report._id;
    assert.equal((await c.get(`/api/reports/${id}`)).status, 200, who);
  }
  assert.equal((await noRole.post('/api/reports', { month: '2026-09' })).status, 403);
});

// ---------- administration ----------

test('only administrators manage users, the simulated bank and the demo data', async () => {
  for (const [who, c] of Object.entries(NOT_ADMIN)) {
    assert.equal((await c.get('/api/admin/users')).status, 403, who);
    assert.equal((await c.post('/api/admin/users', { email: `x-${who}@test.example`, name: 'X', password: PASSWORD, roles: ['admin'] })).status, 403, who);
    assert.equal((await c.get('/api/admin/sim-bank')).status, 403, who);
    assert.equal((await c.put('/api/admin/sim-bank/balance', { balance: 1 })).status, 403, who);
    assert.equal((await c.put('/api/admin/sim-bank/scenarios/57600410275', { scenario: 'rejection' })).status, 403, who);
    assert.equal((await c.post('/api/admin/run-due')).status, 403, who);
    const reset = await c.post('/api/reset', { confirm: 'RESET' });
    assert.equal(reset.status, 403, who);
    assert.equal(reset.data.error, 'This needs the admin role.');
    assert.equal((await c.post('/api/demo/load')).status, 403, who);
  }
  assert.equal((await admin.get('/api/admin/users')).status, 200);
  const add = await admin.post('/api/admin/users', { email: 'new-reviewer@test.example', name: 'Neve Reviewer', password: PASSWORD, roles: ['reviewer'] });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  assert.equal((await admin.get('/api/admin/sim-bank')).status, 200);
  const balance = await admin.put('/api/admin/sim-bank/balance', { balance: 123456 });
  assert.equal(balance.status, 200, JSON.stringify(balance.data));
  assert.ok(await AuditEvent.findOne({ subjectKind: 'sim_bank', action: 'balance_set', actor: 'Ada Admin' }).lean(), 'the change is audited');
});

// ---------- CSRF ----------

test('the right role is not enough without the dashboard header (CSRF)', async () => {
  const statements = await BankStatement.countDocuments();
  const res = await payer.post('/api/statements', { sampleId: 'october' }, { csrf: false });
  assert.equal(res.status, 403);
  assert.equal(res.data.error, CSRF_REFUSED);
  assert.equal(await BankStatement.countDocuments(), statements, 'nothing was added');
  const approve = await approver.post(`/api/invoices/${invoiceA}/actions/approve`, {}, { csrf: false });
  assert.equal(approve.data.error, CSRF_REFUSED);
  const reset = await admin.post('/api/reset', { confirm: 'RESET' }, { csrf: false });
  assert.equal(reset.status, 403);
  assert.equal(reset.data.error, CSRF_REFUSED, 'an administrator without the header is refused before any reset logic');
});

test('audit entries are never removed by these checks', async () => {
  const count = await AuditEvent.countDocuments();
  await reviewer.post(`/api/invoices/${invoiceA}/actions/approve`, {});
  await noRole.get('/api/audit');
  assert.ok((await AuditEvent.countDocuments()) >= count);
});
