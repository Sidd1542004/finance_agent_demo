// A reviewer corrects fields the reader got wrong; the agent re-checks the
// invoice on the corrected values and learns, per supplier, where to look.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent } from '../src/agent/finance/invoiceAgent.js';
import { extractWithRules, extractWithGroq } from '../src/agent/finance/extract.js';
import { allowedActions, ActionError } from '../src/agent/finance/lifecycle.js';
import { correctionChanges, latestCorrections, describeChange } from '../src/agent/finance/corrections.js';
import { labelNear, hintsForText, hintsPrompt } from '../src/agent/finance/supplierHints.js';
import { createInvoiceActions } from '../src/services/invoiceActions.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { vendors, purchaseOrders, goodsReceipts, sampleInvoices, renderInvoiceText } from '../src/seed/data.js';

const policy = { matchThreshold: 85, missingAbn: 'review', priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };
const sampleText = (id) => renderInvoiceText(sampleInvoices.find((s) => s.id === id));
const failedIds = (invoice) => invoice.checks.filter((c) => c.status === 'fail').map((c) => c.id);
const check = (invoice, id) => invoice.checks.find((c) => c.id === id);

// A stand-in for Groq that reads the invoice correctly except for what `misread`
// changes, and records every request so the prompt can be checked.
function fakeGroq(misread = () => ({})) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const text = body.messages[1].content.match(/"""\n([\s\S]*?)\n"""/)[1];
    const { extracted } = extractWithRules(text);
    const answer = { ...extracted, confidence: 0.95, notes: null, ...misread(text) };
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) };
  };
  return { fetchImpl, requests };
}

function setup({ misread, roles = {} } = {}) {
  const invoices = [];
  const ledger = createMemoryLedger({ vendors, purchaseOrders, goodsReceipts, invoices });
  const groq = fakeGroq(misread);
  const extract = (text, { hints } = {}) => extractWithGroq(text, { apiKey: 'k', model: 'fake-model', fetchImpl: groq.fetchImpl, hints });
  const agent = createInvoiceAgent({ ledger, extract, policy, save: async () => {}, today: () => '2026-10-12' });
  const rerun = async (id) => runAgent(agent, { invoice: invoices.find((i) => i.id === id) });
  const actions = createInvoiceActions({ store: ledger, policy, roles, rerun });
  const submit = async (rawText) => {
    const invoice = { id: `inv-${invoices.length + 1}`, createdAt: new Date(Date.UTC(2026, 9, 1, invoices.length)), source: { kind: 'upload' }, rawText, status: 'received' };
    invoices.push(invoice);
    await runAgent(agent, { invoice });
    return invoice;
  };
  const act = (invoice, action, input = {}) => actions.perform(invoice.id, action, { decidedBy: 'Priya N', ...input });
  return { ledger, invoices, groq, submit, act };
}

// The reader puts the decimal point in the wrong place on the clean invoice's total.
const misreadTotal = (text) => (/HOS-10482/.test(text) ? { total: 14025 } : {});

test('a correction fixes a misread total, and the invoice is re-checked on the corrected value', async () => {
  const s = setup({ misread: misreadTotal });
  const invoice = await s.submit(sampleText('clean'));
  assert.equal(invoice.status, 'needs_review');
  assert.equal(invoice.extracted.total, 14025);
  assert.ok(failedIds(invoice).includes('arithmetic'));
  assert.ok(failedIds(invoice).includes('reader_confidence'), 'the misread total is not in the text, so confidence is cut');
  assert.ok(allowedActions(invoice, {}).some((a) => a.id === 'edit_fields' && a.enabled && a.noteRequired));

  const { summary } = await s.act(invoice, 'edit_fields', { note: 'Total checked against the PDF.', fields: { total: '1,402.50' } });
  assert.match(summary, /Fields corrected by Priya N: Total: 14025\.00 → 1402\.50/);

  assert.equal(invoice.extracted.total, 1402.5);
  assert.deepEqual(failedIds(invoice), []);
  assert.equal(invoice.status, 'under_review', 'eligible for approval review; still not approved');
  assert.equal(check(invoice, 'arithmetic').status, 'pass');
  assert.match(check(invoice, 'reader_confidence').detail, /total corrected by Priya N/);
  assert.deepEqual(
    invoice.extraction.corrected.map((c) => [c.field, c.by]),
    [['total', 'Priya N']],
  );
  assert.equal(invoice.approval ?? null, null, 'correcting a field approves nothing');

  assert.equal(invoice.corrections.length, 1);
  assert.deepEqual(
    { field: invoice.corrections[0].field, from: invoice.corrections[0].from, to: invoice.corrections[0].to, by: invoice.corrections[0].by, note: invoice.corrections[0].note },
    { field: 'total', from: 14025, to: 1402.5, by: 'Priya N', note: 'Total checked against the PDF.' },
  );
  assert.ok(invoice.corrections[0].at);

  // The status history records the person, the before and after values, and the note.
  const ev = invoice.events.find((e) => e.action === 'edit_fields');
  assert.equal(ev.actor, 'Priya N');
  assert.equal(ev.from, 'needs_review');
  assert.equal(ev.to, 'processing');
  assert.deepEqual(ev.changes, [{ field: 'total', from: 14025, to: 1402.5 }]);
  assert.equal(ev.reason, 'Total checked against the PDF.');
});

test('a corrected ABN that fails the checksum still fails', async () => {
  const s = setup();
  const invoice = await s.submit(sampleText('clean'));
  assert.equal(invoice.status, 'under_review');

  await s.act(invoice, 'edit_fields', { note: 'Supplier says this is their ABN.', fields: { abn: '57 600 410 276' } });
  assert.equal(invoice.extracted.abn, '57600410276');
  assert.equal(check(invoice, 'supplier_tax_id').status, 'fail');
  assert.match(check(invoice, 'supplier_tax_id').detail, /fails the ATO checksum/);
  assert.equal(invoice.status, 'needs_review');
  assert.ok(!failedIds(invoice).includes('reader_confidence'), 'the person typed it, so it is not "not in the text"');
});

test('corrections survive processing again, and the latest correction of a field wins', async () => {
  const s = setup({ misread: misreadTotal });
  const invoice = await s.submit(sampleText('clean'));
  await s.act(invoice, 'edit_fields', { note: 'First go.', fields: { total: 1400 } });
  assert.equal(invoice.extracted.total, 1400);
  assert.ok(failedIds(invoice).includes('arithmetic'), 'the other checks run normally on the corrected value');

  await s.act(invoice, 'edit_fields', { note: 'Looked again.', fields: { total: 1402.5 } });
  assert.equal(invoice.corrections.length, 2, 'every correction is kept');
  assert.deepEqual([invoice.corrections[1].from, invoice.corrections[1].to], [1400, 1402.5]);

  await s.act(invoice, 'rerun', { note: 'Again, to be sure.' });
  assert.equal(invoice.extracted.total, 1402.5, 'the reader still misreads it, the correction still applies');
  assert.equal(invoice.status, 'under_review');
  assert.equal(s.groq.requests.length, 4);
});

test('a correction for an identified supplier becomes a hint for its later invoices; an ungrounded value is still caught', async () => {
  const s = setup({ misread: (text) => (/HOS-10482/.test(text) ? { total: 14025 } : /HOS-10517/.test(text) ? { total: 9999.99 } : {}) });
  const first = await s.submit(sampleText('clean'));
  await s.act(first, 'edit_fields', { note: 'Read the total wrong.', fields: { total: 1402.5 } });

  assert.equal(s.ledger.hints.length, 1);
  const [hint] = s.ledger.hints;
  assert.equal(hint.vendorAbn, '57600410275');
  assert.equal(hint.vendorName, 'Harbour Office Supplies Pty Ltd');
  assert.equal(hint.field, 'total');
  assert.equal(hint.label, 'Total (inc GST):');
  assert.equal(hint.example, '1402.50');
  assert.ok(!JSON.stringify(hint).includes('A4 copy paper'), 'never the whole invoice');

  // The same supplier's next invoice: the hint goes to the reader...
  const second = await s.submit(sampleText('price-variance'));
  const prompt = s.groq.requests.at(-1).messages[1].content;
  assert.match(prompt, /Reviewers corrected earlier invoices from Harbour Office Supplies Pty Ltd/);
  assert.match(prompt, /total \(Total\): printed next to "Total \(inc GST\):"; an earlier correct value looked like "1402\.50"/);
  assert.deepEqual(second.extraction.hints, { count: 1, supplier: 'Harbour Office Supplies Pty Ltd' });

  // ...but the value the reader returned is not on this invoice, and that is still caught.
  assert.equal(second.extracted.total, 9999.99);
  assert.match(second.extraction.notes, /do not appear in the invoice text as read: total/);
  assert.ok(failedIds(second).includes('reader_confidence'));
  assert.equal(second.status, 'needs_review');

  // Another supplier's invoice gets no hints.
  await s.submit(sampleText('quantity-variance'));
  assert.doesNotMatch(s.groq.requests.at(-1).messages[1].content, /Reviewers corrected/);
});

test('an unidentified supplier gets no hint', async () => {
  const s = setup({ misread: (text) => (/CPS-0388/.test(text) ? { total: 1 } : {}) });
  const invoice = await s.submit(sampleText('unknown-supplier'));
  await s.act(invoice, 'edit_fields', { note: 'Fixed the total.', fields: { total: invoice.extracted.total + 1 } });
  assert.equal(s.ledger.hints.length, 0);
});

test('edit fields: role, note, status and value rules', async () => {
  const s = setup({ roles: { reviewers: ['Priya N'] } });
  const invoice = await s.submit(sampleText('clean'));
  const tryEdit = (input) => s.act(invoice, 'edit_fields', { note: 'Fix.', ...input });
  const refused = async (input, status, message) => {
    await assert.rejects(tryEdit(input), (err) => err instanceof ActionError && err.status === status && message.test(err.message));
  };

  await refused({ decidedBy: 'Sam K', fields: { total: 1 } }, 403, /Sam K is not allowed to edit fields/);
  await refused({ note: '', fields: { total: 1 } }, 400, /Add a note/);
  await refused({ fields: { invoiceDate: '14/09/2026' } }, 400, /YYYY-MM-DD/);
  await refused({ fields: { dueDate: '2026-02-30' } }, 400, /YYYY-MM-DD/);
  await refused({ fields: { total: 'lots' } }, 400, /Total must be a number/);
  await refused({ fields: { gst: Infinity } }, 400, /GST must be a number/);
  await refused({ fields: { abn: '57-600-410-275' } }, 400, /digits only/);
  await refused({ fields: { abn: '5760041027' } }, 400, /11 digits/);
  await refused({ fields: { currency: 'dollars' } }, 400, /three-letter code/);
  await refused({ fields: { customerName: 'X' } }, 400, /cannot be edited: customerName/);
  await refused({ fields: { lines: [{ qty: 1 }] } }, 400, /Line 1 needs an item code or a description/);
  await refused({ fields: { total: 1402.5 } }, 400, /Nothing was changed/);
  await refused({ fields: undefined }, 400, /Send the corrected fields/);
  assert.equal(invoice.corrections, undefined, 'nothing was saved by a refused edit');
  assert.equal(invoice.status, 'under_review');

  // Lines can be corrected too; the arithmetic is then checked on them.
  const lines = invoice.extracted.lines.map((l) => ({ ...l }));
  lines[0].qty = 21;
  await tryEdit({ fields: { lines } });
  assert.equal(invoice.extracted.lines[0].qty, 21);
  assert.ok(failedIds(invoice).includes('arithmetic'));

  // Not once the invoice has been approved.
  const ok = await s.submit(sampleText('quantity-variance'));
  await s.act(ok, 'cancel', { note: 'Not needed.' });
  await assert.rejects(
    s.act(ok, 'edit_fields', { note: 'Fix.', fields: { total: 1 } }),
    (err) => err.status === 409 && /Not allowed while the invoice is Cancelled/.test(err.message),
  );
});

test('correction helpers', () => {
  assert.deepEqual(correctionChanges({ total: 10, vendorName: 'A' }, { total: '10.00', vendorName: ' B ' }), [{ field: 'vendorName', from: 'A', to: 'B' }]);
  assert.deepEqual(correctionChanges({ poNumber: null }, { poNumber: 'po-2041' }), [{ field: 'poNumber', from: null, to: 'PO-2041' }]);
  assert.deepEqual(correctionChanges({ dueDate: '2026-10-14' }, { dueDate: '' }), [{ field: 'dueDate', from: '2026-10-14', to: null }], 'a field can be cleared');
  const latest = latestCorrections([
    { field: 'total', to: 1 },
    { field: 'total', to: 2 },
    { field: 'nope', to: 3 },
  ]);
  assert.deepEqual([...latest.keys()], ['total']);
  assert.equal(latest.get('total').to, 2);
  assert.equal(describeChange({ field: 'abn', from: null, to: '57600410275' }), 'ABN: blank → 57 600 410 275');

  const text = sampleText('clean');
  assert.equal(labelNear('total', 1402.5, text), 'Total (inc GST):');
  assert.equal(labelNear('invoiceNumber', 'HOS-10482', text), 'Invoice number:');
  assert.equal(labelNear('abn', '57600410275', text), 'ABN');
  assert.equal(labelNear('total', 123.45, text), null, 'a value not on the invoice has no label');

  const hints = [{ vendorAbn: '57600410275', vendorName: 'Harbour Office Supplies Pty Ltd', field: 'total', label: 'Total:', example: '1.00' }];
  assert.equal(hintsForText(hints, text).length, 1);
  assert.equal(hintsForText(hints, 'Some other supplier, ABN 11 111 111 111').length, 0);
  assert.equal(hintsPrompt([]), '');
});
