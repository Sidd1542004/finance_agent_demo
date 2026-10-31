// Supplier emails when the AI reader fails (429, a timeout, an answer that is
// not JSON or names no valid intent): the keyword reader reads the email for
// the person, the email is NEVER answered automatically, and it goes to a
// person with the reason, under the same codes as the invoice fallback.
// In memory, with a stand-in for Groq: no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent } from '../src/agent/finance/invoiceAgent.js';
import { createVendorQueryAgent } from '../src/agent/finance/vendorQueryAgent.js';
import { extractWithRules } from '../src/agent/finance/extract.js';
import { createQueryReader } from '../src/agent/finance/readQuery.js';
import { createInvoiceActions } from '../src/services/invoiceActions.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { vendors, purchaseOrders, goodsReceipts, sampleInvoices, renderInvoiceText, findSampleQuery } from '../src/seed/data.js';
import { person } from '../test-support/actors.js';

const policy = { matchThreshold: 85, missingAbn: 'review', priceTolerancePct: 2, minConfidence: 0.8, emailMinConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };

// Invoices on file, so that a status question could otherwise be answered automatically.
async function ledgerWithInvoices() {
  const invoices = [];
  const ledger = createMemoryLedger({ vendors, purchaseOrders, goodsReceipts, invoices, queries: [], statements: [] });
  const agent = createInvoiceAgent({ ledger, extract: async (t) => extractWithRules(t), policy, save: async () => {}, today: () => '2026-10-01' });
  const byId = {};
  let n = 0;
  for (const sample of sampleInvoices) {
    n += 1;
    const invoice = { id: `inv-${n}`, createdAt: new Date(2026, 9, 1, 9, n), source: { kind: 'sample' }, rawText: renderInvoiceText(sample), status: 'received' };
    invoices.push(invoice);
    await runAgent(agent, { invoice });
    byId[sample.id] = invoice;
  }
  const actions = createInvoiceActions({ store: ledger, policy, rerun: async () => {} });
  await actions.perform(byId.clean.id, 'approve', {}, person('Priya N', ['approver']));
  return ledger;
}

const answer = (content) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content } }] }) });
const GROQ = {
  rate_limit: async () => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: { message: 'Rate limit reached' } }) }),
  timeout: async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  },
  not_json: async () => answer('I think the supplier wants to know about payment.'),
  no_intent: async () => answer(JSON.stringify({ intent: 'pay me now', invoiceNumbers: ['HOS-10482'], summary: 'x', confidence: 0.99 })),
};
const EXPECTED_CODE = { rate_limit: 'rate_limit', timeout: 'timeout', not_json: 'bad_output', no_intent: 'bad_output' };

async function process(read, sampleId = 'status-approved') {
  const ledger = await ledgerWithInvoices();
  const agent = createVendorQueryAgent({ ledger, read, policy, companyName: 'Meridian Logistics Pty Ltd', save: async () => {} });
  const sample = findSampleQuery(sampleId);
  const query = { id: 'q-1', createdAt: new Date(2026, 9, 2), status: 'received', from: sample.from, subject: sample.subject, body: sample.body };
  const result = await runAgent(agent, { query });
  return { ledger, query, result };
}

const groqReader = (fetchImpl) => createQueryReader({ groqApiKey: 'test-key', groqModel: 'stand-in-model' }, { fetchImpl, retries: 0 });

test('control: with a working AI reader (or the keyword reader), the status question is answered automatically', async () => {
  const ok = await process(
    groqReader(async () => answer(JSON.stringify({ intent: 'payment_status', invoiceNumbers: ['HOS-10482'], summary: 'When will it be paid?', confidence: 0.95 }))),
  );
  assert.equal(ok.result.outcome, 'auto_answered');
  assert.equal(ok.query.reading.method, 'groq');
  const keywords = await process(createQueryReader({ groqApiKey: '' }));
  assert.equal(keywords.result.outcome, 'auto_answered');
});

for (const kind of Object.keys(GROQ)) {
  test(`the AI reader fails (${kind}): never answered automatically; a person gets it with the reason (${EXPECTED_CODE[kind]})`, async () => {
    const { ledger, query, result } = await process(groqReader(GROQ[kind]));
    assert.equal(result.outcome, 'needs_person');
    assert.equal(query.status, 'needs_person');
    assert.equal(result.error, null, 'not a crash: the email is waiting for a person');
    assert.equal(query.reading.method, 'rules', 'read by the keyword reader');
    assert.equal(query.reading.fallback.code, EXPECTED_CODE[kind]);
    assert.match(query.reading.notes, /The AI reader was unavailable \(.+\), so the keyword reader was used\./);
    const c = query.checks.find((x) => x.id === 'ai_reader_unavailable');
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /not answered automatically/);
    assert.ok(
      query.decision.reasons.some((r) => /AI reader was unavailable/.test(r)),
      'the reason goes to the person',
    );
    assert.ok(!ledger.messages.some((m) => m.status === 'sent' || m.status === 'queued'), 'nothing sent or waiting to be sent');
    // What the keyword reader found is still shown to the person.
    assert.equal(query.understood.intent, 'payment_status');
  });
}

test('an email that mentions bank details still goes to a person for that reason too', async () => {
  const { query } = await process(groqReader(GROQ.timeout), 'bank-change');
  const failed = query.checks.filter((c) => c.status === 'fail').map((c) => c.id);
  assert.ok(failed.includes('ai_reader_unavailable'));
  assert.ok(failed.includes('no_bank_details'));
  assert.equal(query.status, 'needs_person');
});
