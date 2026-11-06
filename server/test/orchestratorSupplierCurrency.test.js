// What the model is given for suppliers (compose.js composeRecords and the task
// sentence), and every amount the record-based answer writes (templates.js),
// with its currency code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { composeRecords, composeTask } from '../src/orchestrator/compose.js';
import { templateAnswer } from '../src/orchestrator/templates.js';

const supplier = (over = {}) => ({
  handle: 'S1',
  kind: 'supplier',
  id: '51824753556',
  name: 'Bluegum IT Services Pty Ltd',
  state: 'unverified',
  pendingChange: false,
  openCount: 2,
  openTotal: 18953,
  overdue: 2,
  oldestDue: '2026-10-25',
  ...over,
});

test('supplier input: the date is the oldest due date, and a bank-details hold appears only when there is one', () => {
  const [plain, held] = composeRecords({ records: [supplier(), supplier({ handle: 'S2', pendingChange: true })] }, {});
  assert.deepEqual(plain, {
    handle: 'S1',
    name: { untrusted_text: 'Bluegum IT Services Pty Ltd' },
    state: 'unverified',
    unpaid_invoices: 2,
    unpaid_total: 'AUD 18,953.00',
    overdue_invoices: 2,
    oldest_due_date: '2026-10-25',
  });
  assert.equal(held.bank_details_change_pending, true);
  assert.ok(!/overdue.?since|oldestDue|pendingBankChange/i.test(JSON.stringify([plain, held])));

  for (const state of [{}, { abn: '51824753556' }]) {
    const task = composeTask('supplier_summary', { records: [supplier()] }, state);
    assert.match(task, /Mention a bank-details hold only for a supplier whose record has bank_details_change_pending; otherwise say nothing about bank details\./);
    assert.match(task, /Call oldest_due_date the oldest due date, not the date anything became overdue\./);
    assert.ok(!/whether a bank-details change is holding|whose payments are held/.test(task));
  }
});

test('the record-based answer writes every amount with its currency code', () => {
  const suppliers = templateAnswer(
    'supplier_summary',
    {},
    { records: [supplier(), supplier({ handle: 'S2', name: 'Harbour', openCount: 1, openTotal: 811.8, overdue: 0, pendingChange: true })] },
    {},
  );
  assert.equal(suppliers.items[0].text, '2 unpaid invoices, AUD 18,953.00, 2 overdue, oldest due 2026-10-25.');
  assert.match(suppliers.items[1].text, /^1 unpaid invoice, AUD 811\.80, oldest due 2026-10-25\. A change to their bank details is waiting for approval/);
  const one = templateAnswer('supplier_summary', {}, { records: [supplier()] }, { abn: '51824753556' });
  assert.equal(one.summary, 'Bluegum IT Services Pty Ltd has 2 unpaid invoices, AUD 18,953.00 in all.');

  const invoice = {
    handle: 'I1',
    kind: 'invoice',
    id: 'a',
    invoiceNumber: 'HOS-10517',
    supplier: 'Harbour',
    total: 2890.36,
    currency: 'AUD',
    status: 'needs_review',
    due: null,
    failedChecks: [],
  };
  const payment = {
    handle: 'P1',
    kind: 'payment',
    id: 'p',
    invoiceId: 'a',
    invoiceNumber: 'SCP-7731',
    amount: 727.1,
    currency: 'AUD',
    status: 'queued',
    method: 'Cheque',
    scheduledFor: '2026-10-03',
  };
  const listed = templateAnswer('list_pending_invoices', {}, { records: [invoice] }, {});
  assert.equal(listed.items[0].text, 'HOS-10517 from Harbour: needs review, AUD 2,890.36.');
  const unpaid = templateAnswer('list_unpaid_invoices', {}, { records: [invoice] }, { open: { total: 1 }, payables: { cash: { approvedDue7: 1402.5, awaitingDecisionDue7: 0 } } });
  assert.match(unpaid.summary, /Approved and due within 7 days: AUD 1,402\.50\. Waiting for a decision and due within 7 days: AUD 0\.00\./);
  const blocked = templateAnswer('payment_status', {}, { records: [payment, { handle: null, kind: 'account', available: 248597.5, currency: 'AUD' }] }, {});
  assert.equal(blocked.items[0].text, 'Payment queued by Cheque: AUD 727.10, scheduled for 2026-10-03.');
  assert.match(blocked.summary, /Available in the simulated account: AUD 248,597\.50\./);
  assert.ok(![suppliers, one, listed, unpaid, blocked].some((a) => /\$\d/.test(JSON.stringify(a))), 'no bare dollar amounts');
});
