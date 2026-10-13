// The whole agent, end to end, with an in-memory ledger and the basic pattern
// reader. No database, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent } from '../src/agent/finance/invoiceAgent.js';
import { extractWithRules, extractWithGroq } from '../src/agent/finance/extract.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { vendors, purchaseOrders, goodsReceipts, sampleInvoices, renderInvoiceText, sampleTotals, findSample } from '../src/seed/data.js';

const policy = { matchThreshold: 85, missingAbn: 'review', priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };

function setup({ extract = async (text) => extractWithRules(text), ledgerPatch = {} } = {}) {
  const invoices = [];
  const ledger = Object.assign(createMemoryLedger({ vendors, purchaseOrders, goodsReceipts, invoices }), ledgerPatch);
  const agent = createInvoiceAgent({ ledger, extract, policy, save: async () => {}, today: () => '2026-10-01' });
  let n = 0;
  const submit = async (rawText, kind = 'sample') => {
    n += 1;
    const invoice = { id: `inv-${n}`, createdAt: new Date(2026, 9, 1, 9, n), source: { kind }, rawText, status: 'received' };
    invoices.push(invoice);
    const result = await runAgent(agent, { invoice });
    return { invoice, result };
  };
  return { ledger, submit };
}

const failed = (invoice) => invoice.checks.filter((c) => c.status === 'fail').map((c) => c.id);

for (const sample of sampleInvoices) {
  test(`sample "${sample.id}" -> ${sample.expect.outcome}`, async () => {
    const { ledger, submit } = setup();
    const { invoice, result } = await submit(renderInvoiceText(sample));

    assert.equal(result.outcome, sample.expect.outcome);
    assert.deepEqual(failed(invoice), sample.expect.failed);
    assert.equal(result.steps.length, 6);
    assert.equal(result.error, null);

    assert.equal(invoice.status, sample.expect.outcome);
    assert.equal(ledger.payments.length, 0, 'the agent never creates a payment, whatever the score');
    assert.equal(invoice.approval, undefined, 'the agent never approves');
    assert.equal(invoice.decision.reasons.length, sample.expect.failed.length);
    assert.ok(invoice.events.some((e) => e.actor === 'Agent' && e.from === 'received' && e.to === sample.expect.outcome), 'the status change is in the audit trail');
  });
}

test('the same invoice twice: the second is flagged as a duplicate for review', async () => {
  const { ledger, submit } = setup();
  const text = renderInvoiceText(findSample('clean'));
  const first = await submit(text);
  const second = await submit(text, 'upload');

  assert.equal(first.result.outcome, 'under_review');
  assert.equal(second.result.outcome, 'needs_review');
  assert.deepEqual(failed(second.invoice), ['duplicate']);
  assert.match(second.invoice.checks.find((c) => c.id === 'duplicate').detail, /same supplier and invoice number/);
  assert.equal(ledger.payments.length, 0);
});

test('a failed first attempt does not make the retry a duplicate', async () => {
  let fail = true;
  const { submit } = setup({ extract: async (text) => { if (fail) throw new Error('Groq rate limit reached.'); return extractWithRules(text); } });
  const text = renderInvoiceText(findSample('clean'));
  const first = await submit(text);
  fail = false;
  const second = await submit(text);
  assert.equal(first.invoice.status, 'failed');
  assert.equal(second.result.outcome, 'under_review');
});

test('if the reader fails, the invoice is flagged and nothing is queued', async () => {
  const { ledger, submit } = setup({ extract: async () => { throw new Error('Could not reach Groq (timed out).'); } });
  const { invoice, result } = await submit(renderInvoiceText(findSample('clean')));

  assert.equal(result.outcome, 'failed');
  assert.equal(invoice.status, 'failed');
  assert.match(invoice.decision.reasons[0], /"understand" step: Could not reach Groq/);
  assert.deepEqual(result.steps.map((s) => s.status), ['done', 'error', 'skipped', 'skipped', 'skipped', 'done']);
  assert.equal(ledger.payments.length, 0);
});

// Reproduces the "paste text" bug report end to end: the Groq request comes
// back with HTTP 200, but the connection drops before the body is fully read
// (the same read ECONNRESET a flaky proxy or network blip produces). This
// must flow through the whole six-step loop and land on "Could not process"
// with a clear reason, exactly like any other reader failure, not crash.
test('a Groq response that fails while reading the body ends as a clean "could not process", not a crash', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('read ECONNRESET'); } });
  const extract = (text) => extractWithGroq(text, { apiKey: 'k', model: 'openai/gpt-oss-120b', fetchImpl });
  const { ledger, submit } = setup({ extract });

  const { invoice, result } = await submit(renderInvoiceText(findSample('clean')), 'paste');

  assert.equal(result.outcome, 'failed');
  assert.equal(invoice.status, 'failed');
  assert.match(invoice.decision.reasons[0], /Could not read Groq's response \(read ECONNRESET\)/);
  assert.deepEqual(result.steps.map((s) => s.status), ['done', 'error', 'skipped', 'skipped', 'skipped', 'done']);
  assert.equal(ledger.payments.length, 0, 'nothing is ever queued for an invoice the reader could not read');
});

test('an invoice with no readable text is flagged at the first step', async () => {
  const { invoice, result } = await setup().submit('   \n  ', 'upload');
  assert.equal(result.outcome, 'failed');
  assert.equal(invoice.status, 'failed');
  assert.equal(result.error.stage, 'receive');
});

test('verify finds a payment the agent should never have left and puts it on hold', async () => {
  const { ledger, submit } = setup();
  // Something outside the agent queued a payment for this invoice.
  ledger.payments.push({ id: 'stray', invoiceId: 'inv-1', amount: 1, status: 'queued' });
  const { invoice, result } = await submit(renderInvoiceText(findSample('clean')));

  assert.equal(result.outcome, 'needs_review');
  assert.equal(invoice.status, 'needs_review');
  assert.match(invoice.decision.reasons.at(-1), /payment existed for an invoice that has not been approved/);
  assert.deepEqual(ledger.payments.map((p) => p.status), ['on_hold']);
});

test('an AI reading with a made-up invoice number goes to a person', async () => {
  const sample = findSample('clean');
  const extract = async (text) => {
    const good = extractWithRules(text);
    // Simulate a model that "corrected" the invoice number and claimed to be sure.
    const { ungroundedFields } = await import('../src/agent/finance/extract.js');
    const extracted = { ...good.extracted, invoiceNumber: 'HOS-10483' };
    const missing = ungroundedFields(extracted, text);
    return { extracted, extraction: { method: 'groq', model: 'm', confidence: missing.length ? 0.5 : 0.99, notes: null } };
  };
  const { invoice, result } = await setup({ extract }).submit(renderInvoiceText(sample));
  assert.equal(result.outcome, 'needs_review');
  assert.deepEqual(failed(invoice), ['reader_confidence']);
});
