// Advanced invoice validation, PO matching and the invoice lifecycle: the
// scenarios from the specification, end to end on the in-memory ledger with
// the basic pattern reader. No database, no network, no real payments.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractText, getDocumentProxy } from 'unpdf';
import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent } from '../src/agent/finance/invoiceAgent.js';
import { extractWithRules, extractWithGroq } from '../src/agent/finance/extract.js';
import { resolvePurchaseOrder, poKey } from '../src/agent/finance/matching.js';
import { detectJurisdiction } from '../src/agent/finance/validation.js';
import { canTransition, TRANSITIONS, STATUSES, allowedActions, ActionError } from '../src/agent/finance/lifecycle.js';
import { dueInfo, payablesSummary, parseTerms } from '../src/agent/finance/due.js';
import { createInvoiceActions } from '../src/services/invoiceActions.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { vendors, purchaseOrders, goodsReceipts, renderInvoiceText, sampleTotals, findSample } from '../src/seed/data.js';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const policy = { matchThreshold: 85, missingAbn: 'review', segregateDuties: false, priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };

function setup({ policyPatch = {}, roles = {}, extraPos = [], extract = async (text) => extractWithRules(text) } = {}) {
  const invoices = [];
  const p = { ...policy, ...policyPatch };
  const ledger = createMemoryLedger({ vendors, purchaseOrders: [...purchaseOrders, ...extraPos], goodsReceipts, invoices });
  const agent = createInvoiceAgent({ ledger, extract, policy: p, save: async () => {}, today: () => '2026-10-12' });
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

// 5b. "Bill to" names the customer; an explicit "Supplier" label names the supplier.
test('6c. "Bill to: Customer A" / "Supplier: Supplier B": the customer is never matched as the supplier', async () => {
  const { submit } = setup();
  const sample = findSample('clean');
  const { subtotal, gst, total } = sampleTotals(sample);
  const abn = sample.vendor.abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4');
  const text = [
    'TAX INVOICE',
    '',
    `Supplier: ${sample.vendor.name}`,
    `ABN ${abn}`,
    '',
    `Invoice number: ${sample.invoiceNumber}`,
    `Invoice date: ${sample.invoiceDate}`,
    `Due date: ${sample.dueDate}`,
    `Purchase order: ${sample.poNumber}`,
    'Bill to: Customer A',
    '',
    'Item          Description                              Qty   Unit price        Amount',
    ...sample.lines.map((l) => `${l.sku}  ${l.description}  ${l.qty}  $${l.unitPrice.toFixed(2)}  $${(l.qty * l.unitPrice).toFixed(2)}`),
    '',
    `Subtotal (ex GST): $${subtotal.toFixed(2)}`,
    `GST (10%): $${gst.toFixed(2)}`,
    `Total (inc GST): $${total.toFixed(2)}`,
  ].join('\n');
  const { invoice } = await submit(text);
  assert.equal(invoice.extracted.vendorName, sample.vendor.name, 'the "Supplier" label, not the first line or the Bill To name');
  assert.equal(invoice.extracted.customerName, 'Customer A');
  assert.equal(invoice.supplier?.name, sample.vendor.name, 'matched to the supplier, never to "Customer A"');
  assert.equal(invoice.status, 'under_review');
});

// 10. No explicit PO, but the invoice could plausibly belong to more than one
// of the same supplier's purchase orders.
test('6b. multiple possible purchase orders are all suggested, none linked automatically', async () => {
  const { submit } = setup();
  const text = variant('clean', (s) => {
    s.poNumber = null;
    s.invoiceNumber = 'HOS-20010';
    // PAP-A4-80 is on PO-2041, CHR-ERG-01 on PO-2044 - both Harbour's, and
    // similar in value so neither suggestion is swamped by the other.
    s.lines = [
      { sku: 'PAP-A4-80', description: 'A4 copy paper 80gsm, carton', qty: 6, unitPrice: 42.0 },
      { sku: 'CHR-ERG-01', description: 'Ergonomic task chair', qty: 1, unitPrice: 245.0 },
    ];
  });
  const { invoice } = await submit(text);
  assert.equal(invoice.status, 'needs_review');
  assert.equal(invoice.matchedPo, null);
  const poNumbers = invoice.match.suggestions.map((s) => s.poNumber);
  assert.ok(poNumbers.includes('PO-2041') && poNumbers.includes('PO-2044'), poNumbers.join(','));
  assert.ok(invoice.match.suggestions.length > 1, 'more than one plausible match');
  assert.match(check(invoice, 'po_found').detail, /possible purchase orders? found/);
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

// 11/12. Undoing an accidental decision: "Reopen for review".
test('19. an accidental approval is safely reopened: back to review, no duplicate approval or payment events', async () => {
  const { ledger, submit, act } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  await act(invoice, 'approve', { note: 'Oops, approved the wrong one.' });
  assert.equal(invoice.status, 'approved');

  await rejects(act(invoice, 'reopen', { note: '' }), 400, /reason|note/i);
  await act(invoice, 'reopen', { note: 'Approved by mistake; needs a second look.' });
  assert.equal(invoice.status, 'needs_review');
  assert.equal(invoice.reopened.decidedBy, 'Priya N');
  assert.equal(invoice.reopened.from, 'approved');
  assert.equal(invoice.reopened.priorDecision.type, 'approval', 'the undone approval is kept, not deleted');
  assert.equal(invoice.approval.decidedBy, 'Priya N', 'the approval record itself is untouched until a fresh decision replaces it');
  assert.equal(ledger.payments.length, 0, 'no payment was ever created');

  // Deciding it again creates one fresh approval event, not a second one on
  // top of the first, and schedules exactly one payment.
  await act(invoice, 'approve', { note: 'Checked properly this time.' });
  await act(invoice, 'schedule_payment');
  assert.equal(ledger.payments.length, 1, 'still only one payment record for this invoice');
  const approvals = invoice.events.filter((e) => e.to === 'approved');
  assert.equal(approvals.length, 2, 'both the mistaken and the corrected approval are in the history');
});

test('19b. an accidental rejection and an accidental cancellation can each be reopened for review', async () => {
  const { submit, act } = setup();

  const rejected = await submit(renderInvoiceText(findSample('clean')));
  await act(rejected.invoice, 'reject', { note: 'Wrong invoice.' });
  await act(rejected.invoice, 'reopen', { note: 'That was a different invoice; this one still needs a decision.' });
  assert.equal(rejected.invoice.status, 'needs_review');
  assert.equal(rejected.invoice.reopened.priorDecision.type, 'rejection');
  assert.equal(rejected.invoice.rejection.note, 'Wrong invoice.', 'the rejection itself is kept in the record');

  const cancelled = await submit(variant('clean', (s) => { s.invoiceNumber = 'HOS-20011'; }));
  await act(cancelled.invoice, 'cancel', { note: 'Thought this was a duplicate.' });
  await act(cancelled.invoice, 'reopen', { note: 'It was not a duplicate after all.' });
  assert.equal(cancelled.invoice.status, 'needs_review');
  assert.equal(cancelled.invoice.reopened.priorDecision.type, 'cancellation');
});

test('19c. reopening cancels a scheduled payment first, and does not leave a payment behind', async () => {
  const { ledger, submit, act } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  await act(invoice, 'approve');
  await act(invoice, 'schedule_payment', { decidedBy: 'Sam K' });
  assert.equal(ledger.payments[0].status, 'queued');

  await act(invoice, 'reopen', { note: 'Approved for the wrong supplier.' });
  assert.equal(invoice.status, 'needs_review');
  assert.equal(ledger.payments[0].status, 'cancelled', 'the scheduled payment is cancelled, not left dangling');
  assert.equal(ledger.payments.length, 1, 'the old record is reused, not duplicated');

  // Decided and paid again: exactly one payment record throughout.
  await act(invoice, 'approve');
  await act(invoice, 'schedule_payment', { decidedBy: 'Sam K' });
  assert.equal(ledger.payments.length, 1);
  assert.equal(ledger.payments[0].status, 'queued');
});

test('20. a payment that has already been made is never reopened as if it were reversed; a recovery is required', async () => {
  const { ledger, submit, act } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  await act(invoice, 'approve');
  await act(invoice, 'schedule_payment');
  await act(invoice, 'record_payment', { reference: 'EFT-99' });
  assert.equal(invoice.status, 'payment_completed');

  await rejects(act(invoice, 'reopen', { note: 'Paid the wrong supplier' }), 409, /Payment Completed/i);
  assert.equal(invoice.status, 'payment_completed', 'status is not changed by a refused reopen');
  assert.equal(ledger.payments[0].status, 'paid', 'the paid record is untouched');
  assert.deepEqual(allowedActions(invoice, { payment: ledger.payments[0] }).map((a) => a.id), ['start_recovery'], 'reopen is not even offered once the payment is paid');

  await act(invoice, 'start_recovery', { note: 'Paid to the wrong supplier.' });
  assert.equal(invoice.recovery.status, 'open');
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
  // Rejected is not a dead end: "Reopen for review" is the only way back, so a
  // mistaken rejection is not permanent.
  assert.deepEqual(allowedActions(invoice, {}).map((a) => a.id), ['reopen']);
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

// Real invoice PDFs (INV-000003): issued by "Australia org", a VAT number
// instead of an ABN, 5% tax, and three variants of the Bill To / PO.
const pdfText = async (name) => (await extractText(await getDocumentProxy(new Uint8Array(fs.readFileSync(fixture(name)))), { mergePages: true })).text;

test('16c. INV-000003 PDFs: every field read, supplier and customer kept apart, nothing invented, all go to a person', async () => {
  const cases = [
    { file: 'INV-000003-no-po.pdf', customer: 'Cust sid abn', po: null, poDetail: /does not quote a purchase order number/ },
    { file: 'INV-000003-po.pdf', customer: 'Cust sid abn', po: 'PO - 0011', poDetail: /Purchase order PO - 0011 does not exist/ },
    { file: 'INV-000003-harbour-bill-to.pdf', customer: 'Harbour Office Supplies Pty Ltd', po: 'PO - 0011', poDetail: /Purchase order PO - 0011 does not exist/ },
  ];
  for (const c of cases) {
    const { ledger, submit } = setup();
    const { invoice } = await submit(await pdfText(c.file));
    const e = invoice.extracted;
    assert.equal(e.vendorName, 'Australia org', c.file);
    assert.equal(e.customerName, c.customer, c.file);
    assert.deepEqual([e.abn, e.acn, e.customerAbn, e.customerAcn], [null, null, null, null], `${c.file}: a "VAT" number is not taken as an ABN`);
    assert.equal(e.vatNumber, '50110219460', `${c.file}: the VAT number is kept separately`);
    assert.equal(invoice.validation.jurisdiction.code, 'unknown', `${c.file}: VAT at 5% is not assumed to be Australian GST`);
    assert.match(check(invoice, 'jurisdiction').detail, /Tax labelled VAT at 5% is not Australian GST, so the 10% GST check was not applied/);
    assert.equal(check(invoice, 'tax_charged'), undefined, `${c.file}: no GST check on an unconfirmed regime`);
    assert.deepEqual([e.invoiceNumber, e.invoiceDate, e.dueDate, e.poNumber], ['INV-000003', '2026-10-15', '2026-10-15', c.po], c.file);
    assert.deepEqual([e.subtotal, e.gst, e.total], [120, 6, 126], c.file);
    assert.deepEqual(e.lines.map((l) => [l.description, l.qty, l.unitPrice, l.amount]), [['Normal pipe', 1, 120, 120]], c.file);
    assert.equal(invoice.supplier, null, `${c.file}: never matched to an approved supplier, even when the customer is one`);
    assert.match(check(invoice, 'po_found').detail, c.poDetail, c.file);
    assert.equal(check(invoice, 'arithmetic').status, 'pass', c.file);
    assert.equal(invoice.status, 'needs_review', c.file);
    assert.equal(ledger.payments.length, 0, c.file);
  }
});

test('16d. unknown supplier on the real INV-000003 layout: a PO is only suggested, linking it does not confirm it, and approval is blocked', async () => {
  const { ledger, submit, act } = setup();
  const text = (await pdfText('INV-000003-no-po.pdf'))
    .replace('1 Normal pipe 1.00 120.00 120.00', '1 Standard timber pallet 1200 x 1000 20 38.50 770.00')
    .replace('Sub Total 120.00', 'Sub Total 770.00')
    .replace('Tax 5% (5%) 6.00', 'Tax 10% (10%) 77.00')
    .replace('Total $126.00', 'Total $847.00');
  const { invoice } = await submit(text);
  assert.equal(invoice.matchedPo, null, 'never linked automatically');
  const [s] = invoice.match.suggestions;
  assert.deepEqual([s.poNumber, s.status, s.confirmed, s.supplierOwnership], ['PO-2045', 'suggested', false, 'unverified']);
  assert.match(check(invoice, 'po_found').detail, /suggestions, not confirmed matches.*not confirmed by ABN, so check each PO belongs to this supplier/);

  await act(invoice, 'link_po', { poNumber: 'PO-2045', note: 'Looks like it' });
  assert.equal(invoice.matchedPo, 'PO-2045');
  assert.equal(check(invoice, 'po_found').status, 'fail', 'linking does not make it the supplier\'s PO');
  await rejects(act(invoice, 'approve', { note: 'Approve anyway' }), 409, /raised with Southern Cross Pallets Pty Ltd.*Verify supplier ownership/);
  const approve = allowedActions(invoice, {}).find((a) => a.id === 'approve');
  assert.equal(approve.enabled, false, 'shown disabled, with the reason');
  await act(invoice, 'reject', { note: 'Not our supplier\'s PO.' });
  assert.equal(invoice.status, 'rejected');
  assert.equal(ledger.payments.length, 0);
});

// ---------- PO references, supplier identification and tax regime ----------

const HARBOUR_PO_0011 = { poNumber: 'PO-0011', vendorAbn: '57600410275', vendorName: 'Harbour Office Supplies Pty Ltd', raisedOn: '2026-10-01', lines: [{ sku: null, description: 'Normal pipe', qty: 1, unitPrice: 120 }] };

test('16e. "PO-0011", "PO - 0011", "p.o. 0011" and "0011" resolve to the same unique PO; "PO-11" does not', () => {
  const pos = [...purchaseOrders, HARBOUR_PO_0011];
  for (const ref of ['PO-0011', 'PO - 0011', 'p.o. 0011', '0011']) {
    const r = resolvePurchaseOrder(ref, pos);
    assert.equal(r.po?.poNumber, 'PO-0011', ref);
    assert.equal(r.how, ref === 'PO-0011' ? 'exact' : 'normalised', ref);
  }
  assert.equal(resolvePurchaseOrder('PO-11', pos).po, null, 'leading zeros are part of the number');
  assert.equal(resolvePurchaseOrder('PO-9999', pos).po, null, 'nothing is invented');
  assert.equal(poKey('PO'), null);
});

test('16f. a normalised PO reference that fits more than one PO is ambiguous: none is chosen and a person decides', async () => {
  const twin = { ...HARBOUR_PO_0011, poNumber: '0011', vendorName: 'Southern Cross Pallets Pty Ltd', vendorAbn: '37600518342' };
  assert.equal(resolvePurchaseOrder('PO - 0011', [HARBOUR_PO_0011, twin]).how, 'ambiguous');
  assert.equal(resolvePurchaseOrder('PO-0011', [HARBOUR_PO_0011, twin]).how, 'exact', 'an exact number is not ambiguous');

  const { submit } = setup({ extraPos: [HARBOUR_PO_0011, twin] });
  const { invoice } = await submit(await pdfText('INV-000003-po.pdf'));
  assert.equal(invoice.extracted.poNumber, 'PO - 0011', 'the printed reference is kept');
  assert.equal(invoice.matchedPo, null);
  assert.deepEqual(invoice.match.poResolution, { reference: 'PO - 0011', how: 'ambiguous', poNumber: null, candidates: ['PO-0011', '0011'] });
  assert.match(check(invoice, 'po_found').detail, /could be any of PO-0011 \(Harbour Office Supplies Pty Ltd\), 0011 \(Southern Cross Pallets Pty Ltd\)\. None was chosen/);
  assert.equal(invoice.status, 'needs_review');
});

test('16g. a known supplier\'s "Purchase order: 2041" resolves to PO-2041, and the printed reference is kept', async () => {
  const { submit } = setup();
  const { invoice } = await submit(variant('clean', (s) => { s.poNumber = '2041'; }));
  assert.equal(invoice.extracted.poNumber, '2041');
  assert.equal(invoice.matchedPo, 'PO-2041');
  assert.equal(invoice.match.poResolution.how, 'normalised');
  assert.match(check(invoice, 'po_found').detail, /prints "2041", which is PO-2041 written differently/);
  assert.equal(invoice.match.comparison.find((r) => r.field === 'PO number').result, 'match');
  assert.equal(invoice.status, 'under_review');
});

test('16h. a normalised PO does not bypass supplier ownership: someone else\'s PO-0011 is not this supplier\'s, and approval stays blocked', async () => {
  const { ledger, submit, act } = setup({ extraPos: [HARBOUR_PO_0011] });
  const { invoice } = await submit(await pdfText('INV-000003-po.pdf'));
  assert.equal(invoice.matchedPo, 'PO-0011', 'found by its number');
  assert.equal(check(invoice, 'po_found').status, 'fail');
  assert.match(check(invoice, 'po_found').detail, /raised with Harbour Office Supplies Pty Ltd, not with this supplier/);
  await rejects(act(invoice, 'approve', { note: 'The number matches, approve it' }), 409, /Verify supplier ownership/);
  await act(invoice, 'request_correction', { note: 'Which PO is this for?' });
  assert.equal(invoice.status, 'on_hold');
  await rejects(act(invoice, 'approve', { note: 'Still approving' }), 409, /Verify supplier ownership/);
  await act(invoice, 'cancel', { note: 'Not ours.' });
  assert.equal(invoice.status, 'cancelled');
  assert.equal(ledger.payments.length, 0);
});

test('16h-2. when another supplier\'s PO is linked, that is the reason given for blocking approval, ahead of duplicate or quantity problems', async () => {
  const { submit, act } = setup();
  const text = (await pdfText('INV-000003-no-po.pdf'))
    .replace('1 Normal pipe 1.00 120.00 120.00', '1 Standard timber pallet 1200 x 1000 20 38.50 770.00')
    .replace('Sub Total 120.00', 'Sub Total 770.00')
    .replace('Tax 5% (5%) 6.00', 'Tax 10% (10%) 77.00')
    .replace('Total $126.00', 'Total $847.00');
  await submit(text);
  const { invoice } = await submit(text); // the same invoice again: a possible duplicate
  await act(invoice, 'link_po', { poNumber: 'PO-2045', note: 'Suggested PO' });
  assert.ok(failed(invoice).includes('duplicate'));
  await rejects(act(invoice, 'approve', { note: 'Approve anyway' }), 409, /^The linked purchase order PO-2045 was raised with Southern Cross Pallets Pty Ltd.*Verify supplier ownership/);
  assert.match(allowedActions(invoice, {}).find((a) => a.id === 'approve').reason, /Verify supplier ownership/);
});

test('16i. an AI reading with no supplier name and 97% confidence is not an identified invoice: it goes to a person', async () => {
  const extract = async (text) => {
    const { extracted } = extractWithRules(text);
    // A stand-in for Groq that reads everything except the supplier's name, and claims 97%.
    const answer = { ...extracted, vendorName: null, customerName: null, confidence: 0.97 };
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) });
    return extractWithGroq(text, { apiKey: 'k', model: 'm', fetchImpl });
  };
  const { submit } = setup({ extract });
  // Harbour's own invoice, ABN printed: the ABN identifies them, but no name was read.
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  assert.equal(invoice.extraction.confidence, 0.5);
  assert.equal(invoice.extraction.rawConfidence, 0.97);
  assert.match(check(invoice, 'reader_confidence').detail, /below the 80% minimum.*supplier's name was not found/);
  assert.equal(check(invoice, 'supplier_known').status, 'unverified');
  assert.match(check(invoice, 'supplier_known').detail, /supplier's name was not read/);
  assert.equal(invoice.extracted.customerName, null, 'the customer is never filled in from the supplier, or the other way round');
  assert.equal(invoice.status, 'needs_review');
});

// The answer Groq (openai/gpt-oss-120b) actually gave for INV-000003 1.pdf in
// the round-2 upload test: no supplier, no customer, and 85% confidence.
const RECORDED_GROQ_NO_SUPPLIER = {
  vendorName: null, abn: null, acn: null, customerName: null, customerAbn: null, customerAcn: null, gstin: null,
  invoiceNumber: 'INV-000003', invoiceDate: '2026-10-15', dueDate: '2026-10-15', poNumber: '0011', currency: 'AUD',
  paymentTerms: 'Due on Receipt', lines: [{ sku: null, description: 'Normal pipe', qty: 1, unit: null, unitPrice: 120, amount: 120 }],
  subtotal: 120, discount: null, charges: null, taxLines: [{ type: 'GST', rate: 5, amount: 6 }], gst: 6, total: 126,
  confidence: 0.85, notes: 'Supplier name and ABN not identified.',
};

test('16i-2. the recorded Groq answer with no supplier name and 85% confidence: capped, not identified, sent to a person with the reasons', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(RECORDED_GROQ_NO_SUPPLIER) } }] }) });
  const { ledger, submit, act } = setup({ extract: (text) => extractWithGroq(text, { apiKey: 'k', model: 'openai/gpt-oss-120b', fetchImpl }) });
  const { invoice } = await submit(await pdfText('INV-000003-po.pdf'));
  assert.deepEqual([invoice.extraction.confidence, invoice.extraction.rawConfidence], [0.5, 0.85]);
  assert.equal(check(invoice, 'reader_confidence').status, 'fail');
  assert.match(check(invoice, 'reader_confidence').detail, /Reader confidence 50% is below the 80% minimum.*supplier's name was not found/);
  assert.match(check(invoice, 'required_fields').detail, /Could not find: supplier name/);
  assert.equal(invoice.supplier, null);
  assert.equal(invoice.extracted.customerName, null, 'no customer is invented either');
  assert.equal(invoice.validation.jurisdiction.code, 'unknown', 'the inferred AUD is not evidence, and the text says VAT');
  assert.match(check(invoice, 'supplier_tax_id').detail, /^Supplier ABN missing/);
  assert.equal(invoice.extracted.poNumber, '0011');
  assert.equal(invoice.status, 'needs_review');
  await act(invoice, 'reject', { note: 'Cannot identify the supplier.' });
  assert.equal(ledger.payments.length, 0);
});

test('16l. unknown tax rules: the reviewer is told whether a supplier ABN was found, without claiming it was validated', async () => {
  const { submit } = setup();
  const missing = await submit(await pdfText('INV-000003-no-po.pdf'));
  const abnCheck = check(missing.invoice, 'supplier_tax_id');
  assert.deepEqual([abnCheck.status, abnCheck.severity], ['fail', 'review']);
  assert.match(abnCheck.detail, /^Supplier ABN missing: no ABN is printed for the supplier\. The number 50110219460 is printed labelled "VAT", not as an ABN/);
  assert.match(abnCheck.detail, /no ABN or GST validation was carried out/);
  assert.deepEqual(missing.invoice.validation.identifier, { type: 'ABN', value: null, format: 'missing', verification: 'not_checked' });

  // An ABN is printed, but the invoice also says VAT: the checksum is reported, nothing is called verified.
  const both = await submit((await pdfText('INV-000003-no-po.pdf')).replace('Australia\nVAT', 'ABN 50 110 219 460\nVAT').replace('INV-000003', 'INV-000006'));
  const c = check(both.invoice, 'supplier_tax_id');
  assert.equal(both.invoice.validation.jurisdiction.code, 'unknown');
  assert.equal(c.status, 'unverified');
  assert.match(c.detail, /ABN 50 110 219 460 is printed for the supplier and passes the ATO checksum\. The tax rules could not be identified, so no ABN or GST validation was carried out, and it was not checked against the Australian Business Register/);
  assert.equal(both.invoice.validation.identifier.verification, 'not_checked');
  assert.equal(both.invoice.status, 'needs_review');
});

// ---------- Hard block: no approval while the supplier is unidentified ----------

// A stand-in AI reader: reads the invoice like the pattern reader, then reports
// the given fields instead (for example no supplier name), claiming 95%.
const aiReading = (patch) => async (text) => {
  const answer = { ...extractWithRules(text).extracted, ...patch, confidence: 0.95 };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) });
  return extractWithGroq(text, { apiKey: 'k', model: 'm', fetchImpl });
};
const SUPPLIER_BLOCK = /^Approval blocked: supplier could not be identified\. Identify and verify the supplier before approving this invoice\.$/;

test('21. no supplier name: plain approval and approval with exceptions are both refused (409), shown disabled with the reason, and nothing is paid', async () => {
  const { ledger, submit, act } = setup({ extract: aiReading({ vendorName: null }) });
  // Harbour's own clean invoice, ABN printed: everything matches except that no supplier name was read.
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  assert.equal(invoice.extracted.vendorName, null);
  await rejects(act(invoice, 'approve'), 409, SUPPLIER_BLOCK); // plain approval, no note
  await rejects(act(invoice, 'approve', { note: 'I know who this is' }), 409, SUPPLIER_BLOCK); // with exceptions and a note
  const approve = allowedActions(invoice, {}).find((a) => a.id === 'approve');
  assert.deepEqual([approve.label, approve.enabled], ['Approve with exceptions', false]);
  assert.match(approve.reason, SUPPLIER_BLOCK);
  assert.equal(invoice.approval, undefined);
  assert.equal(invoice.status, 'needs_review', 'a refused approval changes nothing');
  await rejects(act(invoice, 'schedule_payment'), 409);
  assert.equal(ledger.payments.length, 0, 'no payment record');
});

test('21b. no supplier name: "approve the received quantity only" is refused too', async () => {
  const { ledger, submit, act } = setup({ extract: aiReading({ vendorName: null }) });
  const { invoice } = await submit(renderInvoiceText(findSample('quantity-variance')));
  assert.ok(failed(invoice).includes('quantity_match'));
  await rejects(act(invoice, 'approve_received', { note: 'Pay the 10 received' }), 409, SUPPLIER_BLOCK);
  assert.equal(ledger.payments.length, 0);
});

test('21c. a customer name is not a supplier: customer present, supplier missing, or the "supplier" read is the customer: blocked', async () => {
  const missing = setup({ extract: aiReading({ vendorName: null, customerName: 'Harbour Office Supplies Pty Ltd' }) });
  const a = await missing.submit(await pdfText('INV-000003-harbour-bill-to.pdf'));
  assert.equal(a.invoice.extracted.customerName, 'Harbour Office Supplies Pty Ltd');
  await rejects(missing.act(a.invoice, 'approve', { note: 'Harbour is on the invoice' }), 409, SUPPLIER_BLOCK);

  const swapped = setup({ extract: aiReading({ vendorName: 'Harbour Office Supplies Pty Ltd', customerName: 'HARBOUR OFFICE SUPPLIES' }) });
  const b = await swapped.submit(await pdfText('INV-000003-harbour-bill-to.pdf'));
  await rejects(swapped.act(b.invoice, 'approve', { note: 'Approve' }), 409, SUPPLIER_BLOCK);
  assert.equal(missing.ledger.payments.length + swapped.ledger.payments.length, 0);
});

test('21d. a suggested PO, a VAT number or an ABN match do not identify a supplier whose name is missing', async () => {
  const pallets = (await pdfText('INV-000003-no-po.pdf'))
    .replace('1 Normal pipe 1.00 120.00 120.00', '1 Standard timber pallet 1200 x 1000 20 38.50 770.00')
    .replace('Sub Total 120.00', 'Sub Total 770.00')
    .replace('Tax 5% (5%) 6.00', 'Tax 10% (10%) 77.00')
    .replace('Total $126.00', 'Total $847.00');
  const { submit, act, ledger } = setup({ extract: aiReading({ vendorName: null }) });
  const { invoice } = await submit(pallets);
  assert.ok(invoice.match.suggestions.length > 0, 'a PO is suggested');
  assert.equal(invoice.extracted.vatNumber, '50110219460', 'a VAT number is printed');
  await rejects(act(invoice, 'approve', { note: 'The PO matches' }), 409, SUPPLIER_BLOCK);

  // The ABN identifies an approved supplier, but no supplier name was read: still blocked.
  const byAbn = setup({ extract: aiReading({ vendorName: null }) });
  const c = await byAbn.submit(renderInvoiceText(findSample('over-limit')));
  assert.equal(c.invoice.supplier?.by, 'abn');
  await rejects(byAbn.act(c.invoice, 'approve', { note: 'ABN is Bluegum' }), 409, SUPPLIER_BLOCK);
  assert.equal(ledger.payments.length + byAbn.ledger.payments.length, 0);
});

test('21e. an identified supplier with no ABN is NOT blocked by this rule: approval with exceptions still works', async () => {
  const { submit, act, ledger } = setup();
  const { invoice } = await submit(renderInvoiceText(findSample('clean')).replace(/^.*ABN.*$/gim, ''));
  assert.equal(invoice.extracted.vendorName, 'Harbour Office Supplies Pty Ltd');
  assert.equal(check(invoice, 'supplier_tax_id').status, 'fail', 'the missing ABN is still its own review item');
  assert.equal(allowedActions(invoice, {}).find((a) => a.id === 'approve').enabled, true);
  await act(invoice, 'approve', { note: 'ABN confirmed by phone with the supplier.' });
  assert.equal(invoice.status, 'approved');
  assert.equal(ledger.payments.length, 0, 'approval is not payment');
});

test('21f. an identified supplier with unknown tax rules is NOT blocked by this rule', async () => {
  const { submit, act } = setup();
  const { invoice } = await submit(await pdfText('INV-000003-no-po.pdf'));
  assert.equal(invoice.extracted.vendorName, 'Australia org');
  assert.equal(invoice.validation.jurisdiction.code, 'unknown');
  const approve = allowedActions(invoice, {}).find((a) => a.id === 'approve');
  assert.equal(approve.enabled, true);
  assert.equal(approve.reason, null);
  await act(invoice, 'approve', { note: 'Tax treatment confirmed with the accountant.' });
  assert.equal(invoice.status, 'approved');
});

test('21g. reopening still works for an invoice approved before this rule existed; approving again is then refused', async () => {
  const { ledger, submit, act } = setup({ extract: aiReading({ vendorName: null }) });
  const { invoice } = await submit(renderInvoiceText(findSample('clean')));
  // An approval recorded before the rule existed (for example, older data).
  Object.assign(invoice, { status: 'approved', approval: { decision: 'approve', decidedBy: 'Someone', amount: 1402.5 } });
  await act(invoice, 'reopen', { note: 'The supplier was never identified.' });
  assert.equal(invoice.status, 'needs_review');
  assert.equal(invoice.reopened.priorDecision.type, 'approval');
  await rejects(act(invoice, 'approve', { note: 'Again' }), 409, SUPPLIER_BLOCK);
  await act(invoice, 'reject', { note: 'Supplier unknown.' });
  assert.equal(invoice.status, 'rejected');
  assert.equal(ledger.payments.length, 0);
});

test('16j. tax regime: "Australia" in an address is not evidence; an inferred currency is not evidence; VAT is for a person to confirm', async () => {
  assert.equal(detectJurisdiction({}, 'Australia org\nAustralian Capital Territory\nAustralia\nTotal $126.00').code, 'unknown');
  assert.equal(detectJurisdiction({ currency: 'AUD' }, 'Total $126.00').code, 'unknown', 'a reader inferring AUD from "$" is not the invoice showing it');
  const vat = detectJurisdiction({ abn: '50110219460' }, 'ABN 50 110 219 460\nVAT 5%\nTotal $126.00');
  assert.equal(vat.code, 'unknown', 'ABN and VAT together are conflicting evidence');
  assert.ok(vat.reasons.includes('tax labelled VAT'));
  assert.equal(detectJurisdiction({}, 'Chemical vat, 200L 1 50.00 50.00\nAUD').code, 'AU', 'an item called a "vat" is not VAT');
});

test('16k. a confirmed Australian GST invoice still gets the 10% GST check, rounding tolerance included', async () => {
  const { submit } = setup();
  const base = (await pdfText('INV-000003-no-po.pdf'))
    .replace('VAT 50110219460', 'ABN 50 110 219 460')
    .replace('1 Normal pipe 1.00 120.00 120.00', '1 Normal pipe 1.00 123.45 123.45')
    .replace('Sub Total 120.00', 'Sub Total 123.45');
  const ok = await submit(base.replace('Tax 5% (5%) 6.00', 'GST (10%) 12.35').replace('Total $126.00', 'Total $135.80'));
  assert.equal(ok.invoice.validation.jurisdiction.code, 'AU');
  assert.equal(ok.invoice.extracted.abn, '50110219460');
  assert.equal(check(ok.invoice, 'tax_charged').status, 'pass', '12.35 is 10% of 123.45, rounded');
  const off = await submit(base.replace('Tax 5% (5%) 6.00', 'GST (10%) 12.41').replace('Total $126.00', 'Total $135.86').replace('INV-000003', 'INV-000004'));
  assert.equal(check(off.invoice, 'tax_charged').status, 'fail');
  assert.match(check(off.invoice, 'tax_charged').detail, /GST shown is \$12\.41, but 10% of \$123\.45 is \$12\.35/);
  // The real document: ABN printed, but 5% tax labelled "Tax", with GST 10% nowhere: still Australian, GST check fails.
  const fivePct = await submit((await pdfText('INV-000003-no-po.pdf')).replace('VAT 50110219460', 'ABN 50 110 219 460').replace('INV-000003', 'INV-000005'));
  assert.equal(fivePct.invoice.validation.jurisdiction.code, 'AU');
  assert.match(check(fivePct.invoice, 'tax_charged').detail, /GST shown is \$6\.00, but 10% of \$120\.00 is \$12\.00/);
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
