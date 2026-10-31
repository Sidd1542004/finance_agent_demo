// Supplier bank details (simulated): only synthetic details, two people for
// every change, history in the audit log, and no change from an email.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseDetails, mask, maskedText, methodsOf, beneficiaryBlock, beneficiaryState } from '../src/agent/finance/beneficiary.js';
import { startApp } from '../test-support/app.js';

test('only simulated details are accepted, in a standard format', () => {
  const ok = normaliseDetails({ accountName: ' Acme  (SIM) ', bsb: '999 123', accountNumber: '12345678' });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.details.bsb, '999-123');
  assert.equal(ok.details.accountName, 'Acme (SIM)');
  assert.deepEqual(methodsOf(ok.details), ['EFT']);

  const real = normaliseDetails({ accountName: 'Acme', bsb: '062-000', accountNumber: '12345678' });
  assert.match(real.problems.join(' '), /Only simulated BSBs starting with 999/);

  assert.match(normaliseDetails({ accountName: 'Acme', bsb: '999-123', accountNumber: '12' }).problems.join(' '), /6 to 9 digits/);
  assert.match(normaliseDetails({ accountName: 'Acme', cardToken: '4111111111111111' }).problems.join(' '), /simulated card token/);
  assert.match(normaliseDetails({ accountName: 'Acme' }).problems.join(' '), /Enter bank account/);
  assert.match(normaliseDetails({ bsb: '999-123', accountNumber: '12345678' }).problems.join(' '), /account name/);
  const all = normaliseDetails({ accountName: 'A', bsb: '999123', accountNumber: '1234567', billerCode: '12345', crn: '987654321', cardToken: 'simcard-ab12' });
  assert.deepEqual(methodsOf(all.details), ['EFT', 'BPAY', 'Card']);
});

test('details are masked wherever they are shown or logged', () => {
  const d = { accountName: 'Acme (SIM)', bsb: '999-123', accountNumber: '12345678', billerCode: '12345', crn: '987654321', cardToken: 'SIMCARD-AB12CD' };
  const m = mask(d);
  assert.equal(m.accountNumber, '•••678');
  assert.equal(m.crn, '•••321');
  assert.equal(m.cardToken, 'SIMCARD-•••12CD');
  assert.equal(m.bsb, '999-•••', 'the branch is masked; the bank code stays');
  assert.equal(m.billerCode, '•••45');
  assert.deepEqual(mask(m), m, 'masking masked details changes nothing');
  assert.ok(!maskedText(d).includes('12345678'));
  assert.ok(!maskedText(d).includes('999-123'));
  assert.ok(!maskedText(d).includes('987654321'));
});

test('a payment needs verified details, no pending change, and a method the details support', () => {
  const vendor = { name: 'Acme', beneficiary: { status: 'verified', version: 1, accountName: 'A', bsb: '999-123', accountNumber: '1234567' } };
  assert.equal(beneficiaryBlock(vendor, false, 'EFT'), null);
  assert.match(beneficiaryBlock(vendor, false, 'BPAY'), /cannot be paid by BPAY/);
  assert.match(beneficiaryBlock(vendor, true, 'EFT'), /waiting for approval/);
  assert.match(beneficiaryBlock({ name: 'Acme', beneficiary: null }, false, 'EFT'), /no verified bank details/);
  assert.match(beneficiaryBlock(null, false, 'EFT'), /not on file/);
  assert.equal(beneficiaryState(vendor, false), 'verified');
  assert.equal(beneficiaryState(vendor, true), 'change_pending');
});

// ----- end to end, on the real app and database -----

const t = await startApp();
test.after(t.stop);
const { AuditEvent, BeneficiaryChange, Vendor } = await import('../src/models/index.js');
const BLUEGUM = '36600733916';
const HARBOUR = '57600410275';
const details = {
  accountName: 'Bluegum IT (SIMULATED)',
  bsb: '999-003',
  accountNumber: '33916001',
  reason: 'Confirmed by phone with Bluegum accounts on a number from our records.',
};

test('the sample suppliers: two verified, Bluegum unverified', async () => {
  const reviewer = await t.signIn('reviewer');
  const res = await reviewer.get('/api/suppliers');
  assert.equal(res.status, 200);
  const byAbn = Object.fromEntries(res.data.items.map((s) => [s.abn, s]));
  assert.equal(byAbn[HARBOUR].state, 'verified');
  assert.equal(byAbn[BLUEGUM].state, 'unverified');
  assert.ok(!JSON.stringify(res.data).includes('10482001'), 'full account numbers are never listed');
});

test('a change needs two different people; the proposer cannot approve it', async () => {
  const reviewer = await t.signIn('reviewer');
  const payer = await t.signIn('payer');
  const approver = await t.signIn('approver');
  const both = await t.signIn('approverPayer');

  assert.equal((await reviewer.post(`/api/suppliers/${BLUEGUM}/beneficiary-changes`, details)).status, 403, 'reviewers cannot propose');
  const real = await payer.post(`/api/suppliers/${BLUEGUM}/beneficiary-changes`, { ...details, bsb: '062-000' });
  assert.equal(real.status, 400, 'real-looking details are refused');
  assert.equal((await payer.post(`/api/suppliers/${BLUEGUM}/beneficiary-changes`, { ...details, reason: '' })).status, 400, 'a reason is required');

  // Someone holding both roles proposes, and cannot approve their own proposal.
  const proposed = await both.post(`/api/suppliers/${BLUEGUM}/beneficiary-changes`, details);
  assert.equal(proposed.status, 201, JSON.stringify(proposed.data));
  assert.equal((await payer.post(`/api/suppliers/${BLUEGUM}/beneficiary-changes`, details)).status, 409, 'one pending change at a time');
  const self = await both.post(`/api/beneficiary-changes/${proposed.data.id}/approve`, {});
  assert.equal(self.status, 403);
  assert.match(self.data.error, /someone else must approve/);
  assert.equal((await payer.post(`/api/beneficiary-changes/${proposed.data.id}/approve`, {})).status, 403, 'payers cannot approve');

  const listed = (await reviewer.get('/api/suppliers')).data.items.find((s) => s.abn === BLUEGUM);
  assert.equal(listed.state, 'change_pending');
  assert.deepEqual(listed.pending.details, { hidden: true, methods: ['EFT'] }, 'a reviewer does not see the proposed details at all');
  const forApprover = (await approver.get('/api/suppliers')).data.items.find((s) => s.abn === BLUEGUM);
  assert.equal(forApprover.pending.details.accountNumber, '•••001', 'the approver sees it masked by default');
  assert.equal(forApprover.canReveal, true, 'and may reveal it, which is logged');
  const revealed = await approver.post(`/api/suppliers/${BLUEGUM}/bank-details/reveal`, { target: 'pending', reason: 'Checking it against the call-back.' });
  assert.equal(revealed.data.details.accountNumber, '33916001', 'in full, to check it');

  const ok = await approver.post(`/api/beneficiary-changes/${proposed.data.id}/approve`, { note: 'Checked against the call-back record.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const vendor = await Vendor.findOne({ abn: BLUEGUM }).lean();
  assert.equal(vendor.beneficiary.status, 'verified');
  assert.equal(vendor.beneficiary.version, 1);
  assert.equal(vendor.beneficiary.verifiedBy, 'Priya Approver');
  assert.equal(vendor.beneficiary.proposedBy, 'Alex Both');
  assert.equal((await approver.post(`/api/beneficiary-changes/${proposed.data.id}/approve`, {})).status, 409, 'decided only once');

  const log = await AuditEvent.find({ subjectKind: 'supplier', subjectId: BLUEGUM }).sort({ at: 1 }).lean();
  assert.deepEqual(
    log.map((e) => [e.action, e.actor, e.to]),
    [
      ['bank_details_proposed', 'Alex Both', 'change_pending'],
      ['bank_details_revealed', 'Priya Approver', null], // the approver checked it in full first
      ['bank_details_approved', 'Priya Approver', 'verified'],
    ],
  );
  assert.ok(
    log.every((e) => !String(e.detail).includes('33916001')),
    'the audit log holds masked details only',
  );
});

test('rejecting and withdrawing keep the current details; history is kept', async () => {
  const payer = await t.signIn('payer');
  const payer2 = await t.signIn('payer2');
  const approver2 = await t.signIn('approver2');
  const change = { ...details, accountNumber: '99999999', reason: 'Email asked us to change the account.' };

  const a = await payer.post(`/api/suppliers/${HARBOUR}/beneficiary-changes`, change);
  assert.equal(a.status, 201);
  assert.equal((await payer2.post(`/api/beneficiary-changes/${a.data.id}/reject`, { note: 'no' })).status, 403, 'another payer cannot reject it');
  assert.equal((await approver2.post(`/api/beneficiary-changes/${a.data.id}/reject`, {})).status, 400, 'a reason is required');
  assert.equal((await approver2.post(`/api/beneficiary-changes/${a.data.id}/reject`, { note: 'Not confirmed by call-back.' })).status, 200);

  const b = await payer.post(`/api/suppliers/${HARBOUR}/beneficiary-changes`, change);
  assert.equal(b.status, 201, 'a new proposal is possible once the last one is decided');
  const withdrawn = await payer.post(`/api/beneficiary-changes/${b.data.id}/reject`, { note: 'Entered by mistake.' });
  assert.equal(withdrawn.data.status, 'withdrawn');

  const harbour = await Vendor.findOne({ abn: HARBOUR }).lean();
  assert.equal(harbour.beneficiary.accountNumber, '10482001', 'unchanged');
  const history = (await payer.get(`/api/suppliers/${HARBOUR}/history`)).data.changes;
  assert.deepEqual(
    history.map((c) => c.status),
    ['withdrawn', 'rejected'],
  );
});

test('a supplier email asking to change bank details changes nothing', async () => {
  const reviewer = await t.signIn('reviewer');
  const before = await Vendor.findOne({ abn: HARBOUR }).lean();
  const changesBefore = await BeneficiaryChange.countDocuments();
  const res = await reviewer.post('/api/queries', { sampleId: 'bank-change' });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.query.status, 'needs_person', 'held for a person, as before');
  const after = await Vendor.findOne({ abn: HARBOUR }).lean();
  assert.deepEqual(after.beneficiary, before.beneficiary);
  assert.equal(await BeneficiaryChange.countDocuments(), changesBefore, 'no proposal is created from an email');
});
