// Every service that acts on a person's behalf refuses to act without an
// authenticated actor, whatever the route in front of it checked. Called
// directly here, as an internal caller (or a future orchestrator) would:
// no actor, a typed name, or a look-alike object is refused (401), the wrong
// role is refused (403), and nothing changes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PASSWORD } from '../test-support/app.js';
import { person } from '../test-support/actors.js';

const t = await startApp();
test.after(t.stop);

const { VendorQuery, BankStatement, BeneficiaryChange, User, Invoice } = await import('../src/models/index.js');
const { resolveQuery } = await import('../src/services/queries.js');
const { resolveLine } = await import('../src/services/statements.js');
const { proposeChange, approveChange, rejectChange, listSuppliers } = await import('../src/services/beneficiaries.js');
const { paymentNotices } = await import('../src/services/paymentSystem.js');
const { createUser, updateUser, resetPassword } = await import('../src/services/users.js');
const { ingestion } = await import('../src/services/ingestion.js');
const { withDemoWipe } = await import('../src/services/demoReset.js');
const { performInvoiceAction } = await import('../src/services/invoices.js');

const reviewerC = await t.signIn('reviewer');
const payerC = await t.signIn('payer');

// Not actors: nothing, or objects with every field an actor has, built from data.
const lookAlike = (roles) => ({ id: String(t.users.admin.id), name: 'Ada Admin', roles, sessionId: 'forged' });
const NOT_ACTORS = [null, undefined, lookAlike(['admin']), JSON.parse(JSON.stringify(person('Priya N')))];
const refused = async (promiseFn, status) => {
  await assert.rejects(promiseFn(), (err) => err.status === status, `expected ${status}`);
};

test('supplier emails: replying or closing needs an authenticated reviewer', async () => {
  const created = await reviewerC.post('/api/queries', { sampleId: 'dispute' });
  assert.equal(created.data.query.status, 'needs_person');
  const id = created.data.query._id;
  for (const actor of NOT_ACTORS) await refused(() => resolveQuery(id, { action: 'close', note: 'x', decidedBy: 'Rita Reviewer' }, actor), 401);
  await refused(() => resolveQuery(id, { action: 'close', note: 'x' }, person('Sam K', ['payer'])), 403);
  assert.equal((await VendorQuery.findById(id).lean()).status, 'needs_person', 'nothing changed');
  const done = await resolveQuery(id, { action: 'close', note: 'Handled by phone.', decidedBy: 'Someone Else' }, person('Rita Reviewer', ['reviewer']));
  assert.equal(done.query.status, 'closed');
  assert.equal(done.query.resolution.decidedBy, 'Rita Reviewer', 'the actor, not the typed name');
});

test('bank lines: confirming or dismissing (which can mark a payment paid) needs an authenticated payer', async () => {
  const created = await payerC.post('/api/statements', { sampleId: 'october' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.statement._id;
  const open = created.data.statement.lines.find((l) => ['unmatched', 'exception', 'suggested'].includes(l.status));
  for (const actor of NOT_ACTORS) await refused(() => resolveLine(id, open.n, { action: 'dismiss', note: 'x' }, actor), 401);
  await refused(() => resolveLine(id, open.n, { action: 'dismiss', note: 'x' }, person('Rita Reviewer', ['reviewer'])), 403);
  const after = await BankStatement.findById(id).lean();
  assert.equal(after.lines.find((l) => l.n === open.n).status, open.status, 'nothing changed');
});

test('bank details: proposing, approving and rejecting need authenticated people with the roles', async () => {
  const [bluegum] = (await listSuppliers(person('Sam K', ['payer']))).filter((s) => s.state === 'unverified');
  const details = { accountName: 'Bluegum IT (SIMULATED)', bsb: '999-003', accountNumber: '33916001', reason: 'Call-back to a known number.' };
  for (const actor of NOT_ACTORS) await refused(() => proposeChange(bluegum.abn, details, actor), 401);
  await refused(() => proposeChange(bluegum.abn, details, person('Rita Reviewer', ['reviewer'])), 403);
  assert.equal(await BeneficiaryChange.countDocuments(), 0);
  const change = await proposeChange(bluegum.abn, details, person('Sam K', ['payer']));
  for (const actor of NOT_ACTORS) await refused(() => approveChange(change.id, actor), 401);
  await refused(() => approveChange(change.id, person('Rita Reviewer', ['reviewer'])), 403);
  await refused(() => rejectChange(change.id, lookAlike(['approver']), 'no'), 401);
  assert.equal((await BeneficiaryChange.findById(change.id).lean()).status, 'pending', 'still waiting for a person');
  for (const actor of NOT_ACTORS) await refused(() => listSuppliers(actor), 401);
});

test('payment notices: drafting, sending and discarding need an authenticated person', async () => {
  for (const actor of NOT_ACTORS) {
    await refused(() => paymentNotices.draft('0123456789abcdef01234567', 'payment_processing', actor), 401);
    await refused(() => paymentNotices.approveAndSend('0123456789abcdef01234567', actor), 401);
    await refused(() => paymentNotices.discard('0123456789abcdef01234567', actor, 'x'), 401);
  }
  await refused(() => paymentNotices.draft('0123456789abcdef01234567', 'payment_processing', person('Priya N', ['approver'])), 403);
});

test('user accounts: creating, changing and resetting need an authenticated administrator', async () => {
  const input = { email: 'new@test.example', name: 'New Person', password: PASSWORD, roles: ['admin'] };
  for (const actor of NOT_ACTORS) await refused(() => createUser(input, actor), 401);
  await refused(() => createUser(input, person('Rita Reviewer', ['reviewer', 'approver', 'payer'])), 403);
  assert.equal(await User.exists({ email: 'new@test.example' }), null, 'no account was created');
  const rita = String(t.users.reviewer.id);
  for (const actor of NOT_ACTORS) {
    await refused(() => updateUser(rita, { roles: ['admin'] }, actor), 401);
    await refused(() => resetPassword(rita, 'another long password', actor), 401);
  }
  assert.deepEqual((await User.findById(rita).lean()).roles, ['reviewer'], 'no role was granted');
});

test('mailbox ingestion and the demo wipe need an authenticated administrator; the scheduler syncs without one', async () => {
  for (const actor of NOT_ACTORS) {
    await refused(() => ingestion().startConnect('gmail', actor), 401);
    await refused(() => ingestion().setEnabled('gmail', true, actor), 401);
    await refused(() => ingestion().sync('gmail', { trigger: 'manual', user: actor }), 401);
    await refused(() => withDemoWipe(actor, async () => 'wiped'), 401);
  }
  await refused(() => ingestion().startConnect('gmail', person('Priya N')), 403);
  // The scheduler's own sync is not a person's request: it reaches the provider check instead.
  try {
    await ingestion().sync('gmail', { trigger: 'cron' });
  } catch (err) {
    assert.notEqual(err.status, 401, 'never refused as unauthenticated');
  }
});

test('invoice actions through the service: no actor is refused, never treated as a typed name', async () => {
  const created = await reviewerC.post('/api/invoices', { sampleId: 'clean' });
  const id = created.data.invoice._id;
  for (const actor of NOT_ACTORS) await refused(() => performInvoiceAction(id, 'approve', { decidedBy: 'Priya Approver', note: 'ok' }, actor), 401);
  const after = await Invoice.findById(id).lean();
  assert.equal(after.status, created.data.invoice.status);
  assert.equal(after.approval, null);
  // The detail shown to the person who added it says which actions they may take (a reviewer: not approve).
  assert.equal(created.data.actions.find((a) => a.id === 'approve')?.permitted, false);
  assert.equal(created.data.actions.find((a) => a.id === 'hold')?.permitted, true);
});
