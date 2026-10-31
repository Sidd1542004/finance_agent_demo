// The 99% thresholds (client request): the default match score threshold and
// the default minimum reading confidence for invoices are both 99%. An invoice
// below either goes to a person through the existing workflow; nothing is ever
// approved because of a score or an AI confidence. Supplier emails keep their
// own 80% floor. In memory, no database, no network.

import test from 'node:test';
import assert from 'node:assert/strict';

// The built-in defaults, whatever a local server/.env says (dotenv never
// replaces a variable that is already set, even to '').
Object.assign(process.env, { MATCH_THRESHOLD: '', MIN_CONFIDENCE: '', MIN_EMAIL_CONFIDENCE: '', PRICE_TOLERANCE_PCT: '', MISSING_ABN_POLICY: '' });
const { config } = await import('../src/config.js');
const { runAgent } = await import('../src/agent/core/loop.js');
const { createInvoiceAgent } = await import('../src/agent/finance/invoiceAgent.js');
const { extractWithRules } = await import('../src/agent/finance/extract.js');
const { allowedActions, ActionError } = await import('../src/agent/finance/lifecycle.js');
const { runQueryChecks } = await import('../src/agent/finance/queryRules.js');
const { createInvoiceActions } = await import('../src/services/invoiceActions.js');
const { createMemoryLedger } = await import('../src/integrations/memoryLedger.js');
const { vendors, purchaseOrders, goodsReceipts, renderInvoiceText, findSample } = await import('../src/seed/data.js');

const policy = config.policy;

// The basic reader's fields, reported with the given confidence, as an AI reader would.
const readerAt = (confidence) => async (text) => {
  const r = extractWithRules(text);
  return { ...r, extraction: { ...r.extraction, method: 'groq', model: 'stand-in', confidence, reader: { confidence, notes: null } } };
};

function setup(extract) {
  const invoices = [];
  const ledger = createMemoryLedger({ vendors, purchaseOrders, goodsReceipts, invoices });
  const agent = createInvoiceAgent({ ledger, extract, policy, save: async () => {}, today: () => '2026-10-12' });
  const actions = createInvoiceActions({ store: ledger, policy, rerun: async () => {} });
  let n = 0;
  const submit = async (rawText) => {
    n += 1;
    const invoice = { id: `inv-${n}`, createdAt: new Date(2026, 9, 1, 9, n), source: { kind: 'paste' }, rawText, status: 'received' };
    invoices.push(invoice);
    await runAgent(agent, { invoice });
    return invoice;
  };
  const approver = { id: 'u-approver', name: 'Priya Approver', roles: ['approver'] };
  return { ledger, submit, act: (invoice, action, input = {}) => actions.perform(invoice.id, action, input, approver) };
}

const check = (invoice, id) => invoice.checks.find((c) => c.id === id);
const clean = renderInvoiceText(findSample('clean'));

test('the defaults: 99% match score, 99% invoice reading confidence, 80% for supplier emails', () => {
  assert.equal(policy.matchThreshold, 99);
  assert.equal(policy.minConfidence, 0.99);
  assert.equal(policy.emailMinConfidence, 0.8);
});

test('read at 99% and scoring 100%: only eligible for approval review; never approved, no payment', async () => {
  const { ledger, submit } = setup(readerAt(0.99));
  const invoice = await submit(clean);
  assert.equal(invoice.match.score.total, 100);
  assert.equal(invoice.match.score.threshold, 99);
  assert.equal(check(invoice, 'reader_confidence').status, 'pass');
  assert.equal(invoice.status, 'under_review');
  assert.equal(invoice.approval, undefined);
  assert.equal(ledger.payments.length, 0);
});

test('even 100% confidence and a 100% score approve nothing: approving still needs an approver', async () => {
  const { ledger, submit } = setup(readerAt(1));
  const invoice = await submit(clean);
  assert.equal(invoice.status, 'under_review');
  assert.equal(invoice.approval, undefined);
  assert.equal(ledger.payments.length, 0);
  const approve = allowedActions(invoice, {}).find((a) => a.id === 'approve');
  assert.equal(approve.role, 'approver');
  assert.equal(approve.enabled, true, 'a person may approve it; the agent does not');
});

test('read at 98%: below the 99% minimum, so the invoice goes to Needs Review with the reason', async () => {
  const { submit, act } = setup(readerAt(0.98));
  const invoice = await submit(clean);
  const c = check(invoice, 'reader_confidence');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /98% is below the 99% minimum/);
  assert.equal(c.severity, 'review');
  assert.equal(invoice.status, 'needs_review');
  assert.ok(invoice.decision.reasons.some((r) => /below the 99% minimum/.test(r)));
  // The existing Needs Review workflow: a person may approve with exceptions, and must say why.
  await assert.rejects(act(invoice, 'approve', {}), (err) => err instanceof ActionError && err.status === 400 && /despite the exceptions/.test(err.message));
  await act(invoice, 'approve', { note: 'Checked every field against the PDF.' });
});

test('the basic pattern reader (at most 90% confident) always sends the invoice to Needs Review', async () => {
  const { submit } = setup(async (text) => extractWithRules(text));
  const invoice = await submit(clean);
  assert.equal(invoice.extraction.confidence, 0.9);
  assert.equal(check(invoice, 'reader_confidence').status, 'fail');
  assert.equal(invoice.status, 'needs_review');
});

test('a 95% match score is below 99%: the score check fails and the invoice goes to a person (On Hold, as before)', async () => {
  const { submit } = setup(readerAt(0.99));
  // GST-free lines from a GST-registered supplier: tax cannot be fully verified, 5 points lost.
  const s = structuredClone(findSample('clean'));
  s.gst = 0;
  const invoice = await submit(renderInvoiceText(s));
  assert.equal(invoice.match.score.total, 95);
  assert.equal(check(invoice, 'match_score').status, 'fail');
  assert.match(check(invoice, 'match_score').detail, /Match score 95% \(threshold 99%\)/);
  assert.equal(invoice.status, 'on_hold');
  assert.equal(invoice.approval, undefined);
});

test('supplier emails keep their own 80% floor: an 85% reading still passes', () => {
  const checks = runQueryChecks({
    text: 'When will invoice HOS-10482 be paid?',
    understood: { intent: 'payment_status', invoiceNumbers: ['HOS-10482'] },
    reading: { confidence: 0.85 },
    vendor: null,
    sender: 'accounts@example.com',
    items: [],
    policy,
  });
  assert.equal(checks.find((c) => c.id === 'reader_confidence').status, 'pass');
  assert.match(checks.find((c) => c.id === 'reader_confidence').detail, /minimum 80%/);
});
