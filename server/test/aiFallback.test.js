// When the AI reader fails (unavailable, rate limited, timed out, a bad key,
// an answer that is not JSON, or an empty one), the rules reader reads the
// invoice instead. The invoice goes to Needs Review with the
// ai_reader_unavailable check, which blocks approval until the AI reader reads
// it again or a person corrects its fields. Nothing is ever approved or paid
// because of it. In memory, with a stand-in for Groq: no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent, fallbackCheck } from '../src/agent/finance/invoiceAgent.js';
import { extractWithGroq, extractWithRules } from '../src/agent/finance/extract.js';
import { groqChat, GroqError } from '../src/llm/groq.js';
import { ActionError, allowedActions } from '../src/agent/finance/lifecycle.js';
import { createInvoiceActions } from '../src/services/invoiceActions.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { vendors, purchaseOrders, goodsReceipts, renderInvoiceText, findSample } from '../src/seed/data.js';
import { person } from '../test-support/actors.js';

const BASE = { matchThreshold: 85, missingAbn: 'review', segregateDuties: false, priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };
const clean = renderInvoiceText(findSample('clean'));

// Groq stand-ins, by what goes wrong.
const answer = (content) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content } }] }) });
const failing = (status) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({ error: { message: 'stand-in error' } }) });
const GROQ = {
  server: async () => failing(503),
  rate_limit: async () => failing(429),
  auth: async () => failing(401),
  bad_request: async () => failing(400),
  network: async () => {
    throw new TypeError('fetch failed');
  },
  timeout: async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  },
  bad_output: async () => answer('Sorry, I cannot help with that.'),
  empty: async () => answer('{}'),
};
// What a working AI reader returns for the clean sample: the same fields, read with confidence.
const cleanFields = { ...extractWithRules(clean).extracted, confidence: 0.99, notes: null };
const working = async () => answer(JSON.stringify(cleanFields));

function setup({ policy = {}, withFallback = true } = {}) {
  const p = { ...BASE, ...policy };
  const invoices = [];
  const groq = { fetch: GROQ.server };
  const ledger = createMemoryLedger({ vendors, purchaseOrders, goodsReceipts, invoices });
  const agent = createInvoiceAgent({
    ledger,
    extract: (text, { hints } = {}) => extractWithGroq(text, { apiKey: 'test-key', model: 'stand-in-model', fetchImpl: (...a) => groq.fetch(...a), hints, retries: 0 }),
    fallback: withFallback ? async (text, fb) => extractWithRules(text, { fallback: fb }) : null,
    policy: p,
    save: async () => {},
    today: () => '2026-10-12',
  });
  const run = (invoice, opts = {}) => runAgent(agent, { invoice, ...opts });
  const actions = createInvoiceActions({ store: ledger, policy: p, rerun: async (id) => run(invoices.find((i) => i.id === id)) });
  let n = 0;
  const submit = async (rawText = clean) => {
    n += 1;
    const invoice = { id: `inv-${n}`, createdAt: new Date(2026, 9, 1, 9, n), source: { kind: 'paste' }, rawText, status: 'received' };
    invoices.push(invoice);
    const result = await run(invoice);
    return { invoice, result };
  };
  const act = (invoice, action, input = {}, actor = person('Priya N')) => actions.perform(invoice.id, action, input, actor);
  return { ledger, groq, submit, act, run };
}

const check = (invoice) => invoice.checks.find((c) => c.id === 'ai_reader_unavailable');

test('the Groq client says why a call failed, with a code', async () => {
  const call = (fetchImpl) => groqChat({ apiKey: 'k', model: 'm', body: {}, fetchImpl, retries: 0 });
  for (const [code, fetchImpl] of Object.entries(GROQ)) {
    if (code === 'empty') continue; // valid JSON: not an error for the client
    await assert.rejects(call(fetchImpl), (err) => err instanceof GroqError && err.code === code, code);
  }
  await assert.rejects(groqChat({ apiKey: '', model: 'm', body: {} }), (err) => err.code === 'not_configured');
});

test('every way the AI reader fails ends in Needs Review, read by the rules reader, with the reason; nothing approved or paid', async () => {
  for (const kind of Object.keys(GROQ)) {
    const s = setup();
    s.groq.fetch = GROQ[kind];
    const { invoice, result } = await s.submit();
    assert.equal(result.outcome, 'needs_review', kind);
    assert.equal(invoice.status, 'needs_review', kind);
    assert.equal(invoice.extraction.method, 'rules', `${kind}: read by the rules reader`);
    assert.equal(invoice.extraction.fallback.code, kind === 'empty' ? 'bad_output' : kind);
    assert.match(invoice.extraction.notes, /The AI reader was unavailable \(.+\), so the basic rules reader was used\./, kind);
    const c = check(invoice);
    assert.equal(c.status, 'fail', kind);
    assert.equal(c.severity, 'review');
    assert.match(c.detail, /basic rules reader/);
    assert.ok(
      invoice.decision.reasons.some((r) => /AI reader was unavailable/.test(r)),
      `${kind}: the reason is given to the person`,
    );
    assert.ok(invoice.aiFallback?.since, kind);
    assert.equal(invoice.approval, undefined);
    assert.equal(s.ledger.payments.length, 0);
    // The stages ran; the agent did not stop at "understand".
    assert.deepEqual(
      result.steps.map((st) => st.status),
      ['done', 'done', 'done', 'done', 'done', 'done'],
      kind,
    );
  }
});

test('the check does not depend on the confidence slider: even at 50% the invoice goes to Needs Review', async () => {
  const s = setup({ policy: { minConfidence: 0.5, matchThreshold: 50 } });
  const { invoice } = await s.submit();
  assert.equal(invoice.checks.find((c) => c.id === 'reader_confidence').status, 'pass', 'confidence alone would let it through');
  assert.equal(check(invoice).status, 'fail');
  assert.equal(invoice.status, 'needs_review');
});

test('approval is blocked, with the reason, for an approver and an administrator alike; rejecting is still possible', async () => {
  const s = setup();
  const { invoice } = await s.submit();
  const approve = allowedActions(invoice, { actor: person('Priya N') }).find((a) => a.id === 'approve');
  assert.equal(approve.enabled, false);
  assert.match(approve.reason, /rules reader because the AI reader was unavailable/);
  for (const actor of [person('Priya N', ['approver']), person('Ada Admin', ['admin'])]) {
    await assert.rejects(
      s.act(invoice, 'approve', { note: 'Looks fine to me.' }, actor),
      (err) => err instanceof ActionError && err.status === 409 && /Edit fields/.test(err.message),
    );
  }
  assert.equal(invoice.status, 'needs_review');
  await s.act(invoice, 'reject', { note: 'Asked the supplier to resend it.' });
  assert.equal(invoice.status, 'rejected');
});

test('a person correcting the fields (Edit fields) clears the block, even while the AI reader is still down', async () => {
  const s = setup();
  const { invoice } = await s.submit();
  await s.act(invoice, 'edit_fields', { note: 'Checked every field against the PDF; the due date was wrong.', fields: { dueDate: '2026-10-21' } });
  assert.equal(invoice.extraction.method, 'rules', 'still the rules reader: Groq is still down');
  const c = check(invoice);
  assert.equal(c.status, 'pass');
  assert.match(c.detail, /Priya N corrected its fields since then/);
  assert.equal(invoice.status, 'under_review', 'only eligible for approval: a person still approves');
  assert.equal(invoice.approval, undefined);
  await s.act(invoice, 'approve', {});
  assert.equal(invoice.status, 'approved');
});

test('processed again once the AI reader is back: the check is gone and the record is cleared', async () => {
  const s = setup();
  const { invoice } = await s.submit();
  assert.ok(invoice.aiFallback);
  s.groq.fetch = working;
  await s.act(invoice, 'rerun', {});
  assert.equal(invoice.extraction.method, 'groq');
  assert.equal(invoice.extraction.fallback, undefined);
  assert.equal(check(invoice), undefined);
  assert.equal(invoice.aiFallback, null);
  assert.equal(invoice.status, 'under_review');
  assert.equal(invoice.approval, undefined, 'never approved by being read again');
});

test('only corrections made after the AI reader first failed count', () => {
  const fb = { code: 'server', reason: 'Groq returned an error (503).', at: '2026-10-31T10:05:00.000Z', since: '2026-10-31T10:00:00.000Z' };
  assert.equal(fallbackCheck({ aiFallback: null }), null);
  assert.equal(fallbackCheck({ aiFallback: fb, corrections: [] }).status, 'fail');
  assert.equal(fallbackCheck({ aiFallback: fb, corrections: [{ field: 'total', by: 'Rita', at: '2026-10-31T09:59:59.000Z' }] }).status, 'fail', 'an earlier correction');
  assert.equal(fallbackCheck({ aiFallback: fb, corrections: [{ field: 'total', by: 'Rita', at: '2026-10-31T10:01:00.000Z' }] }).status, 'pass');
});

test('no fallback reader configured (no Groq key): an AI failure is still "could not process", as before', async () => {
  const s = setup({ withFallback: false });
  const { invoice, result } = await s.submit();
  assert.equal(result.outcome, 'failed');
  assert.equal(invoice.status, 'failed');
  assert.ok(!invoice.aiFallback, 'no fallback record');
});

test('a reading from the vision reader is used as it is: no fallback, nothing to clear', async () => {
  const s = setup();
  const invoice = {
    id: 'scan-1',
    createdAt: new Date(2026, 9, 1),
    source: { kind: 'upload', scan: { from: 'image', pages: 1, model: 'v' } },
    rawText: clean,
    status: 'received',
    aiFallback: { since: 'x', reason: 'old' },
  };
  const reading = extractWithRules(clean);
  await s.run(invoice, { reading });
  assert.equal(invoice.aiFallback, null);
  assert.equal(check(invoice), undefined);
});
