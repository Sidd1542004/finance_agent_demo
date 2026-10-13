// Advanced invoice validation, PO matching and the invoice lifecycle: the
// scenarios from the specification, end to end on the in-memory ledger with
// the basic pattern reader. No database, no network, no real payments.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractText, getDocumentProxy } from 'unpdf';
import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent } from '../src/agent/finance/invoiceAgent.js';
import { extractWithRules } from '../src/agent/finance/extract.js';
import { canTransition, TRANSITIONS, STATUSES, allowedActions, ActionError } from '../src/agent/finance/lifecycle.js';
import { dueInfo, payablesSummary, parseTerms } from '../src/agent/finance/due.js';
import { createInvoiceActions } from '../src/services/invoiceActions.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { vendors, purchaseOrders, goodsReceipts, renderInvoiceText, findSample } from '../src/seed/data.js';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const policy = { matchThreshold: 85, missingAbn: 'review', segregateDuties: false, priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };

function setup({ policyPatch = {}, roles = {} } = {}) {
  const invoices = [];
  const p = { ...policy, ...policyPatch };
  const ledger = createMemoryLedger({ vendors, purchaseOrders, goodsReceipts, invoices });
  const agent = createInvoiceAgent({ ledger, extract: async (text) => extractWithRules(text), policy: p, save: async () => {}, today: () => '2026-10-12' });
  const rerun = async (id) => {
    const invoice = invoices.find((i) => i.id === id);
    await runAgent(agent, { invoice });
  };
  const actions = createInvoiceActions({ store: ledger, policy: p, roles, rerun });
  let n = 0;
  const submit = async (rawText) => {
    n += 1;
    const invoice = { id: `inv-${n}`, createdAt: new Date(2026, 9, 1, 9, n), source: { kind: 'paste' }, rawText, status: 'received' };
    invoices.push(invoice);
    const result = await runAgent(agent, { invoice });
    return { invoice, result };
  };
  const act = (invoice, action, input = {}) => actions.perform(invoice.id, action, { decidedBy: 'Priya N', ...input });
  return { ledger, invoices, submit, act };
}

const failed = (invoice) => invoice.checks.filter((c) => c.status === 'fail').map((c) => c.id);
const check = (invoice, id) => invoice.checks.find((c) => c.id === id);
const rejects = async (promise, status, pattern) => {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ActionError, `expected an ActionError, got ${err}`);
    assert.equal(err.status, status);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
};

// Text of a sample invoice with some lines replaced.
const variant = (sampleId, edit) => {
  const s = structuredClone(findSample(sampleId));
  edit(s);
  return renderInvoiceText(s);
};

// 1. A fully matching invoice.
test('1. fully matching invoice: 100%, Under Review, nothing approved or paid', async () => {
  const { ledger, submit } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  assert.equal(invoice.match.score.total, 100);
  assert.equal(invoice.match.score.eligible, true);
  assert.equal(invoice.status, 'under_review');
  assert.equal(invoice.approval, undefined);
  assert.equal(ledger.payments.length, 0);
  assert.ok(invoice.match.comparison.every((r) => ['match', 'check'].includes(r.result)), 'every comparison row matches');
  assert.deepEqual(Object.keys(invoice.match.comparison[0]), ['field', 'invoice', 'po', 'difference', 'result']);
});

// 2. Above the threshold but below 100%.
test('2. above 85% with no failed checks: eligible for approval review, still not approved', async () => {
  const { ledger, submit } = setup();
  // GST-free items from a GST-registered supplier: tax cannot be fully verified.
  const { invoice } = await submit(variant('clean', (s) => { s.gst = 0; }));
  assert.ok(invoice.match.score.total >= 85 && invoice.match.score.total < 100, `score ${invoice.match.score.total}`);
  assert.deepEqual(failed(invoice), []);
  assert.equal(invoice.status, 'under_review');
  assert.equal(ledger.payments.length, 0);
  const tax = invoice.match.score.components.find((c) => c.id === 'tax');
  assert.equal(tax.points, 5, 'half marks for tax that could not be verified');
});

// 3. Below the threshold.
test('3. below 85%: the score check fails and the invoice is held', async () => {
  const { submit } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('price-variance')));
  assert.ok(invoice.match.score.total < 85, `score ${invoice.match.score.total}`);
  assert.equal(check(invoice, 'match_score').status, 'fail');
  assert.equal(invoice.status, 'on_hold');
});

test('3b. a high score never overrides a failed mandatory check', async () => {
  const { submit, act } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('quantity-variance')));
  assert.ok(invoice.match.score.total >= 85, `score ${invoice.match.score.total}`);
  assert.equal(invoice.status, 'on_hold', 'quantity over what was received');
  await rejects(act(invoice, 'approve', { note: 'looks fine' }), 409, /received quantity/i);
});

// 4 and 5. No purchase order quoted.
test('4. no PO quoted, a likely PO exists: suggested with reasons, never linked automatically; a reviewer links it', async () => {
  const { submit, act } = setup();
  const { invoice } = await submit(variant('clean', (s) => { s.poNumber = null; s.invoiceNumber = 'HOS-20001'; }));
  assert.equal(invoice.status, 'needs_review');
  assert.equal(invoice.matchedPo, null);
  const [best] = invoice.match.suggestions;
  assert.equal(best.poNumber, 'PO-2041');
  assert.match(best.explanation, /match PO-2041/, 'the suggestion explains itself');
  assert.match(check(invoice, 'po_found').detail, /A reviewer must confirm one; none is linked automatically/);

  await act(invoice, 'link_po', { poNumber: 'PO-2041', note: 'Confirmed with the warehouse.' });
  assert.equal(invoice.matchedPo, 'PO-2041');
  assert.equal(invoice.match.linkedBy.decidedBy, 'Priya N');
  assert.equal(invoice.status, 'under_review', 'after linking, the agent re-checks; still only eligible for review');
  assert.ok(invoice.events.some((e) => e.action === 'link_po' && e.actor === 'Priya N'));
});

test('5. no PO quoted and nothing similar: Needs Review, no suggestion', async () => {
  const { submit } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('no-po')));
  assert.equal(invoice.status, 'needs_review');
  assert.deepEqual(invoice.match.suggestions, []);
  assert.match(check(invoice, 'po_found').detail, /No likely purchase order was found/);
});

// 6. Supplier mismatch.
test('6. supplier mismatch: invoice quotes another supplier\'s PO', async () => {
  const { submit } = setup();
  const { invoice } = await submit(variant('clean', (s) => { s.poNumber = 'PO-2042'; }));
  assert.equal(check(invoice, 'po_found').status, 'fail');
  assert.match(check(invoice, 'po_found').detail, /not with this supplier/);
  assert.equal(invoice.match.comparison.find((r) => r.field === 'Supplier').result, 'mismatch');
  assert.ok(invoice.match.score.total < 85);
  assert.equal(invoice.status, 'needs_review');
});

// 7. Quantity beyond what is left on the PO.
test('7. a second invoice for the same PO lines: quantity beyond what remains', async () => {
  const { submit, act } = setup();
  const first = await submit(renderInvoiceText(findSample('clean')));
  await act(first.invoice, 'approve');
  const second = await submit(variant('clean', (s) => { s.invoiceNumber = 'HOS-10999'; s.invoiceDate = '20 Sep 2026'; }));
  assert.equal(second.invoice.status, 'on_hold');
  assert.deepEqual(failed(second.invoice), ['quantity_match', 'match_score']);
  const line = second.invoice.lineMatches[0];
  assert.equal(line.qtyRemaining, 0);
  assert.ok(line.qtyInvoicedBefore > 0);
  assert.match(check(second.invoice, 'quantity_match').detail, /already invoiced/);
});

// 8. Price difference.
test('8. price difference beyond tolerance is shown in the comparison table', async () => {
  const { submit } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('price-variance')));
  assert.ok(failed(invoice).includes('price_match'));
  const row = invoice.match.comparison.find((r) => r.field.startsWith('Unit price') && r.result === 'mismatch');
  assert.ok(row, 'a unit price row is a mismatch');
  assert.ok(row.difference);
});

// 9. Arithmetic error.
test('9. sums that do not add up: Needs Review and approval is blocked', async () => {
  const { submit, act } = setup();
  const text = renderInvoiceText(findSample('clean')).replace(/(Total[^\n]*?)1,402\.50/i, '$11,412.50');
  const { invoice } = await submit(text);
  assert.ok(failed(invoice).includes('arithmetic'), failed(invoice).join(','));
  assert.equal(invoice.status, 'needs_review');
  await rejects(act(invoice, 'approve', { note: 'ok' }), 409, /add up|arithmetic|sums/i);
});

// 10. Duplicate.
test('10. duplicate: flagged for review, cannot be approved or paid twice', async () => {
  const { ledger, submit, act } = setup();
  const text = renderInvoiceText(findSample('clean'));
  const first = await submit(text);
  await act(first.invoice, 'approve');
  await act(first.invoice, 'schedule_payment', { method: 'EFT' });
  const second = await submit(text);
  assert.equal(second.invoice.status, 'needs_review');
  assert.deepEqual(failed(second.invoice), ['duplicate']);
  await rejects(act(second.invoice, 'approve', { note: 'pay it' }), 409, /duplicate/i);

  // If a person clears it, the agent re-checks: as a second delivery it would
  // now exceed the purchase order, so it still cannot be approved in full.
  await act(second.invoice, 'clear_duplicate', { note: 'Thought it was a different delivery.' });
  assert.equal(second.invoice.status, 'on_hold');
  assert.ok(failed(second.invoice).includes('quantity_match'));
  await rejects(act(second.invoice, 'approve', { note: 'pay it' }), 409);

  // Defence in depth: even an approved copy cannot be scheduled while the
  // first copy has a live payment.
  Object.assign(second.invoice, { status: 'approved', approval: { decision: 'approve', decidedBy: 'Someone', amount: 1402.5 } });
  await rejects(act(second.invoice, 'schedule_payment'), 409, /will not be paid twice/);
  assert.equal(ledger.payments.length, 1);
  assert.equal(second.invoice.status, 'approved', 'scheduling was refused, the invoice stays approved');
});

// 11. Approved but unpaid.
test('11. approval is not payment: approved, then scheduled (simulated), then recorded with evidence', async () => {
  const { ledger, submit, act } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  await act(invoice, 'approve');
  assert.equal(invoice.status, 'approved');
  assert.equal(ledger.payments.length, 0, 'approving creates no payment');

  await act(invoice, 'schedule_payment', { decidedBy: 'Sam K', method: 'BPAY', scheduledFor: '2026-10-14' });
  assert.equal(invoice.status, 'payment_pending');
  const [payment] = ledger.payments;
  assert.equal(payment.simulated, true);
  assert.equal(payment.method, 'BPAY');

  await rejects(act(invoice, 'record_payment', { decidedBy: 'Sam K' }), 400, /reference/);
  await act(invoice, 'record_payment', { decidedBy: 'Sam K', amount: 400, reference: 'BP-1', paidOn: '2026-10-14' });
  assert.equal(invoice.status, 'payment_pending', 'a part payment keeps it pending');
  assert.equal(payment.paidAmount, 400);
  await act(invoice, 'record_payment', { decidedBy: 'Sam K', reference: 'BP-2', paidOn: '2026-10-15' });
  assert.equal(invoice.status, 'payment_completed');
  assert.equal(payment.status, 'paid');
  assert.equal(payment.paidAmount, 1402.5);
});

test('11b. a failed payment is flagged and can be retried', async () => {
  const { ledger, submit, act } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  await act(invoice, 'approve');
  await act(invoice, 'schedule_payment');
  await act(invoice, 'payment_failed', { note: 'Bank rejected: account closed.' });
  assert.equal(invoice.status, 'payment_failed');
  assert.equal(ledger.payments[0].status, 'failed');
  await act(invoice, 'schedule_payment');
  assert.equal(invoice.status, 'payment_pending');
  assert.equal(ledger.payments.length, 1);
  assert.equal(ledger.payments[0].attempts, 2);
});

// 12. Reversing an approved, unpaid invoice.
test('12. reversing an approval needs a reason, cancels the scheduled payment and keeps the original approval', async () => {
  const { ledger, submit, act } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  await act(invoice, 'approve', { note: 'All good.' });
  await act(invoice, 'schedule_payment');
  await rejects(act(invoice, 'reverse_approval', { note: '' }), 400, /reason|note/i);
  await act(invoice, 'reverse_approval', { note: 'Supplier sent a credit note; invoice replaced.' });
  assert.equal(invoice.status, 'rejected');
  assert.equal(ledger.payments[0].status, 'cancelled');
  assert.equal(invoice.reversal.approval.decidedBy, 'Priya N', 'original approval preserved');
  assert.equal(invoice.approval.note, 'All good.');
  const e = invoice.events.at(-1);
  assert.deepEqual([e.actor, e.from, e.to, e.reason], ['Priya N', 'payment_pending', 'rejected', 'Supplier sent a credit note; invoice replaced.']);
});

// 13. Recovery for a paid invoice.
test('13. a paid invoice cannot be reversed; a recovery is opened instead and the payment record is kept', async () => {
  const { ledger, submit, act } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  await act(invoice, 'approve');
  await act(invoice, 'schedule_payment');
  await act(invoice, 'record_payment', { reference: 'EFT-77' });
  assert.equal(invoice.status, 'payment_completed');
  await rejects(act(invoice, 'reverse_approval', { note: 'Wrong supplier' }), 409);
  await act(invoice, 'start_recovery', { note: 'Paid to the wrong supplier; asked for the money back.' });
  assert.equal(invoice.status, 'payment_completed', 'the payment happened; status does not pretend otherwise');
  assert.equal(invoice.recovery.status, 'open');
  assert.equal(ledger.payments[0].status, 'paid');
  assert.equal(ledger.payments[0].recovery.status, 'open');
  await act(invoice, 'close_recovery', { note: 'Refund received 20 Oct.' });
  assert.equal(invoice.recovery.status, 'closed');
});

// 14. Invalid transitions.
test('14. invalid transitions are refused by the backend', async () => {
  for (const s of STATUSES) assert.ok(Array.isArray(TRANSITIONS[s]), s);
  assert.equal(canTransition('under_review', 'payment_completed'), false);
  assert.equal(canTransition('needs_review', 'payment_pending'), false);
  assert.equal(canTransition('payment_completed', 'rejected'), false);
  assert.equal(canTransition('approved', 'payment_pending'), true);

  const { submit, act } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  await rejects(act(invoice, 'schedule_payment'), 409);
  await rejects(act(invoice, 'record_payment', { reference: 'x' }), 409);
  await act(invoice, 'reject', { note: 'Not ours.' });
  await rejects(act(invoice, 'approve'), 409);
  assert.deepEqual(allowedActions(invoice, {}).map((a) => a.id), []);
});

test('14b. the agent itself never approves: it cannot move an invoice past Under Review', async () => {
  for (const to of ['approved', 'payment_pending', 'payment_completed']) assert.equal(canTransition('processing', to), false, to);
});

test('14c. names and roles: a decision needs a name; configured roles are enforced; duties can be segregated', async () => {
  const { submit, act } = setup({ policyPatch: { segregateDuties: true }, roles: { approvers: ['Priya N'], payers: ['Priya N', 'Sam K'] } });
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  await rejects(act(invoice, 'approve', { decidedBy: '' }), 400, /name/i);
  await rejects(act(invoice, 'approve', { decidedBy: 'Sam K' }), 403);
  await act(invoice, 'approve');
  await rejects(act(invoice, 'schedule_payment'), 403, /approved/i);
  await act(invoice, 'schedule_payment', { decidedBy: 'Sam K' });
  assert.equal(invoice.status, 'payment_pending');
});

// 15. Concurrency.
test('15. two people schedule the same payment at once: exactly one succeeds', async () => {
  const { ledger, submit, act } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  await act(invoice, 'approve');
  const results = await Promise.allSettled([act(invoice, 'schedule_payment', { decidedBy: 'Sam K' }), act(invoice, 'schedule_payment', { decidedBy: 'Alex T' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  assert.equal(ledger.payments.length, 1);
});

test('15b. approve and reject at the same moment: one wins, the other is told the invoice changed', async () => {
  const { submit, act } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  const results = await Promise.allSettled([act(invoice, 'approve'), act(invoice, 'reject', { note: 'No.' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = results.find((r) => r.status === 'rejected').reason;
  assert.equal(lost.status, 409);
  assert.match(lost.message, /changed while you were deciding|Not allowed while the invoice is (Approved|Rejected)/);
  assert.ok(['approved', 'rejected'].includes(invoice.status));
});

// 16. Missing ABN on an Australian invoice.
test('16. Australian invoice with no ABN: Needs Review with the withholding warning, never Rejected', async () => {
  const { submit } = setup();
  const text = renderInvoiceText(findSample('clean')).replace(/^.*ABN.*$/gim, '');
  const { invoice } = await submit(text);
  assert.equal(invoice.validation.jurisdiction.code, 'AU');
  const abn = check(invoice, 'supplier_tax_id');
  assert.equal(abn.status, 'fail');
  assert.equal(abn.severity, 'review');
  assert.match(abn.detail, /withh/i);
  assert.equal(invoice.status, 'needs_review');
});

test('16b. the user\'s Australian invoice template (placeholders, no ABN, no PO) ends as Needs Review', async () => {
  const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(fixture('invoice_template_australia.pdf'))));
  const { text } = await extractText(pdf, { mergePages: true });
  const { ledger, submit } = setup();
  const { invoice } = await submit(text);
  assert.equal(invoice.status, 'needs_review');
  assert.equal(invoice.validation.jurisdiction.code, 'AU');
  assert.equal(invoice.extracted.total, 1980);
  assert.ok(failed(invoice).includes('supplier_tax_id'));
  assert.ok(failed(invoice).includes('po_found'));
  assert.equal(check(invoice, 'tax_charged').status, 'pass', 'GST of $180 is 10% of $1,800');
  assert.equal(ledger.payments.length, 0);
});

// 17. Indian GST invoice.
test('17. Indian GST invoice: GSTIN and CGST/SGST rules, no ABN rules', async () => {
  const { submit } = setup();
  const { invoice } = await submit(fs.readFileSync(fixture('indian-gst-invoice.txt'), 'utf8'));
  assert.equal(invoice.validation.jurisdiction.code, 'IN');
  assert.equal(invoice.validation.identifier.type, 'GSTIN');
  assert.equal(check(invoice, 'supplier_tax_id').status, 'unverified', 'valid GSTIN, not checked online');
  assert.ok(!invoice.checks.some((c) => /ABN/.test(c.detail || '')), 'no ABN message');
  assert.equal(check(invoice, 'tax_charged').status, 'pass');
  assert.match(check(invoice, 'tax_charged').detail, /CGST and SGST/);
  assert.equal(invoice.status, 'needs_review', 'unknown supplier and no PO still go to a person');

  const bad = await submit(fs.readFileSync(fixture('indian-gst-invoice.txt'), 'utf8').replace('SGST @ 9%: 1,080.00', 'SGST @ 9%: 1,080.00\nIGST @ 18%: 2,160.00').replace('SGST/2026', 'SGT/2026/0418'));
  assert.match(check(bad.invoice, 'tax_charged').detail, /IGST together with CGST\/SGST/);
});

// 18. Existing workflows still work: covered in workflows.test.js; here, the due-date alerts.
test('18. due dates, overdue alerts and the cash needed', () => {
  assert.deepEqual(parseTerms('Net 30'), { days: 30, eom: false });
  assert.deepEqual(parseTerms('30 days EOM'), { days: 30, eom: true });
  assert.equal(dueInfo({ invoiceDate: '2026-09-14', paymentTerms: '14 days' }, '2026-10-12').date, '2026-09-28');
  assert.equal(dueInfo({ dueDate: '2026-10-10' }, '2026-10-12').state, 'overdue');
  assert.equal(dueInfo({ dueDate: '2026-10-15' }, '2026-10-12').state, 'due_soon');
  const s = payablesSummary(
    [
      { id: 'a', status: 'approved', extracted: { invoiceNumber: 'A', total: 100, dueDate: '2026-10-10' } },
      { id: 'b', status: 'payment_pending', extracted: { invoiceNumber: 'B', total: 200, dueDate: '2026-10-15' }, payment: { amount: 150 } },
      { id: 'c', status: 'under_review', extracted: { invoiceNumber: 'C', total: 50, dueDate: '2026-10-13' } },
      { id: 'd', status: 'payment_completed', extracted: { invoiceNumber: 'D', total: 999, dueDate: '2026-10-01' } },
    ],
    '2026-10-12',
  );
  assert.deepEqual(s.overdue.map((r) => r.invoiceNumber), ['A']);
  assert.deepEqual(s.dueSoon.map((r) => r.invoiceNumber), ['C', 'B']);
  assert.equal(s.cash.approvedDue7, 250);
  assert.equal(s.cash.awaitingDecisionDue7, 50);
});

test('the audit trail records actor, from, to and reason for every change', async () => {
  const { submit, act } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('quantity-variance')));
  await act(invoice, 'approve_received', { note: 'Paying the 10 received.' });
  await act(invoice, 'schedule_payment', { decidedBy: 'Sam K' });
  const trail = invoice.events.map((e) => [e.actor, e.from, e.to]);
  assert.deepEqual(trail, [
    ['Agent', 'received', 'on_hold'],
    ['Priya N', 'on_hold', 'approved'],
    ['Sam K', 'approved', 'payment_pending'],
  ]);
  assert.equal(invoice.events[1].reason, 'Paying the 10 received.');
  assert.equal(invoice.approval.amount, 727.1);
});
