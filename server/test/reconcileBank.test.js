// Bank reconciliation of payments made through the simulated bank: matched
// by the bank's transaction reference, treated as confirmed, never marked
// paid again and never reported as a double payment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchLines } from '../src/agent/finance/reconcileRules.js';
import { startApp } from '../test-support/app.js';

const bankPaid = {
  id: 'p-bank',
  route: 'bank',
  status: 'paid',
  invoiceNumber: 'HOS-10482',
  vendorName: 'Harbour Office Supplies Pty Ltd',
  amount: 1402.5,
  confirmation: { txnRef: 'SIMTXN-20261022-AAAA111111', amount: 1402.5 },
  bank: null,
};
const bankProcessing = {
  id: 'p-proc',
  route: 'bank',
  status: 'processing',
  invoiceNumber: 'SCP-7781',
  vendorName: 'Southern Cross Pallets Pty Ltd',
  amount: 727.1,
  submission: { txnRef: 'SIMTXN-20261022-BBBB222222' },
};
const bankQueued = { id: 'p-queued', route: 'bank', status: 'queued', invoiceNumber: 'BIT-5502', vendorName: 'Bluegum IT Services Pty Ltd', amount: 300 };
const manualQueued = { id: 'p-man', route: 'manual', status: 'queued', invoiceNumber: 'CHQ-1', vendorName: 'Coastal Print & Sign Pty Ltd', amount: 88 };
const line = (n, description, amount) => ({ n, date: '2026-10-22', description, amount });

test('a line quoting the transaction reference is matched as already confirmed', () => {
  const { lines } = matchLines([line(1, 'SIM BANK SIMTXN-20261022-AAAA111111 Harbour HOS-10482', -1402.5)], [bankPaid], []);
  assert.equal(lines[0].status, 'matched');
  assert.equal(lines[0].kind, 'confirmed_by_bank');
  assert.equal(lines[0].confirmed, true);
  assert.equal(lines[0].paymentId, 'p-bank');
  assert.doesNotMatch(lines[0].reason, /double/i);
});

test('the same reference twice on one statement, a different amount, or a payment not yet confirmed is for a person', () => {
  const { lines } = matchLines(
    [line(1, 'SIM BANK SIMTXN-20261022-AAAA111111', -1402.5), line(2, 'SIM BANK SIMTXN-20261022-AAAA111111', -1402.5), line(3, 'SIM BANK SIMTXN-20261022-BBBB222222', -727.1)],
    [bankPaid, bankProcessing],
    [],
  );
  assert.deepEqual(
    lines.map((l) => [l.status, l.kind]),
    [
      ['matched', 'confirmed_by_bank'],
      ['exception', 'duplicate'],
      ['exception', 'awaiting_bank_confirmation'],
    ],
  );
  const differs = matchLines([line(1, 'SIMTXN-20261022-AAAA111111', -1400)], [bankPaid], []).lines[0];
  assert.equal(differs.kind, 'amount_differs');
  assert.equal(differs.candidate, null, 'nothing to confirm: it is already paid');
});

test('bank-routed payments are never matched on invoice number, supplier or amount alone', () => {
  const { lines, unpaid } = matchLines(
    [
      line(1, 'Payment HOS-10482', -1402.5), // invoice number of a bank-paid invoice, no reference
      line(2, 'BLUEGUM IT SERVICES', -300), // supplier and amount of a bank payment still scheduled
      line(3, 'Transfer', -300), // amount only
      line(4, 'COASTAL PRINT SIGN', -88), // a manual payment: matched as before
    ],
    [bankPaid, bankQueued, manualQueued],
    [],
  );
  assert.deepEqual(
    lines.map((l) => [l.status, l.kind]),
    [
      ['exception', 'check_bank_payment'],
      ['unmatched', null],
      ['unmatched', null],
      ['matched', null],
    ],
  );
  assert.equal(lines[3].paymentId, 'p-man');
  assert.deepEqual(
    unpaid.map((u) => u.invoiceNumber),
    ['BIT-5502'],
  );
});

// ----- end to end: pay through the simulated bank, reconcile its statement -----

const t = await startApp({ BUSINESS_DAYS: 'Mon-Sun', PAYMENT_CUTOFF: '23:59', PAYMENT_DEFAULT_TIME: '00:00', BANK_HOLIDAYS: '2000-01-01', SIM_BANK_DELAY_SECONDS: '0' });
test.after(t.stop);
const { Payment, Invoice } = await import('../src/models/index.js');
const { sampleLedger } = await import('../src/integrations/sampleLedger.js');

test('the simulated bank statement reconciles to the confirmed payment without paying it again', async () => {
  const reviewer = await t.signIn('reviewer');
  const approver = await t.signIn('approver');
  const payer = await t.signIn('payer');
  const id = (await reviewer.post('/api/invoices', { sampleId: 'clean' })).data.invoice._id;
  // Read at 90%, under the 99% minimum: approving it needs a note.
  assert.equal((await approver.post(`/api/invoices/${id}/actions/approve`, { note: 'Checked against the PDF.' })).status, 200);
  const { nextSlot } = (await payer.get('/api/payment-calendar')).data;
  assert.equal((await payer.post(`/api/invoices/${id}/actions/schedule_payment`, { method: 'EFT', scheduledFor: nextSlot.date, scheduledTime: nextSlot.time })).status, 200);
  await t.client().get('/api/cron/tick', { headers: { Authorization: 'Bearer test-cron-secret-0123456789' } });
  const paid = await Payment.findOne({ invoiceId: id }).lean();
  assert.equal(paid.status, 'paid');

  const csv = (await payer.get('/api/sim-bank/statement.csv')).data;
  const first = await payer.post('/api/statements', { text: csv });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const l = first.data.statement.lines.find((x) => x.paymentId === String(paid._id));
  assert.equal(l.status, 'matched');
  assert.equal(l.kind, 'confirmed_by_bank');
  assert.equal(first.data.statement.status, 'reconciled');
  let p = await Payment.findById(paid._id).lean();
  assert.equal(p.status, 'paid');
  assert.equal(p.paidAmount, paid.paidAmount, 'not paid again');
  assert.equal(p.bank.statementId, first.data.statement._id);
  assert.equal((await Invoice.findById(id).lean()).status, 'payment_completed');

  // The same statement uploaded again: already reconciled, not a double payment.
  const second = await payer.post('/api/statements', { text: csv });
  const again = second.data.statement.lines.find((x) => x.invoiceNumber === p.invoiceNumber);
  assert.equal(again.status, 'exception');
  assert.equal(again.kind, 'already_reconciled');
  assert.doesNotMatch(again.reason, /double payment/i);

  // Undoing the first statement removes the link only; the payment stays paid.
  await sampleLedger.revertStatement(first.data.statement._id);
  p = await Payment.findById(paid._id).lean();
  assert.equal(p.status, 'paid');
  assert.equal(p.bank, null);
  assert.equal((await Invoice.findById(id).lean()).status, 'payment_completed');
});
