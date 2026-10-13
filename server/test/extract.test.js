import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWithRules, extractWithGroq, normalise, toIsoDate, ungroundedFields } from '../src/agent/finance/extract.js';
import { groqJson } from '../src/llm/groq.js';
import { sampleInvoices, renderInvoiceText, sampleTotals, findSample } from '../src/seed/data.js';

test('dates', () => {
  assert.equal(toIsoDate('14 Sep 2026'), '2026-09-14');
  assert.equal(toIsoDate('1 October 2026'), '2026-10-01');
  assert.equal(toIsoDate('03/10/2026'), '2026-10-03', 'day first');
  assert.equal(toIsoDate('2026-9-4'), '2026-09-04');
  assert.equal(toIsoDate(''), null);
});

test('the basic pattern reader reads every sample exactly', () => {
  for (const sample of sampleInvoices) {
    const { extracted, extraction } = extractWithRules(renderInvoiceText(sample));
    const totals = sampleTotals(sample);
    assert.equal(extracted.vendorName, sample.vendor.name, sample.id);
    assert.equal(extracted.abn, sample.vendor.abn, sample.id);
    assert.equal(extracted.invoiceNumber, sample.invoiceNumber, sample.id);
    assert.equal(extracted.poNumber, sample.poNumber, sample.id);
    assert.equal(extracted.invoiceDate, toIsoDate(sample.invoiceDate), sample.id);
    assert.equal(extracted.dueDate, toIsoDate(sample.dueDate), sample.id);
    assert.deepEqual({ subtotal: extracted.subtotal, gst: extracted.gst, total: extracted.total }, totals, sample.id);
    assert.deepEqual(
      extracted.lines.map((l) => [l.sku, l.description, l.qty, l.unitPrice]),
      sample.lines.map((l) => [l.sku, l.description, l.qty, l.unitPrice]),
      sample.id,
    );
    assert.equal(extraction.method, 'rules');
    assert.equal(extraction.confidence, 0.9, sample.id);
  }
});

test('the basic pattern reader admits when it cannot read a layout', () => {
  const { extraction } = extractWithRules('Hello,\nplease pay us eight hundred dollars for the pallets.\nThanks, Sam');
  assert.ok(extraction.confidence < 0.8);
  assert.match(extraction.notes, /could not find every field/);
});

test('normalise cleans up messy reader output', () => {
  const out = normalise({
    vendorName: '  Acme Pty Ltd ',
    abn: '51 824 753 556',
    invoiceNumber: 'N/A',
    poNumber: 'po-77',
    total: '$1,402.50',
    subtotal: 'abc',
    lines: [{ description: 'Widget', qty: '3', unitPrice: '10.00', amount: 30 }, {}, null],
  });
  assert.equal(out.vendorName, 'Acme Pty Ltd');
  assert.equal(out.abn, '51824753556');
  assert.equal(out.invoiceNumber, null);
  assert.equal(out.poNumber, 'PO-77');
  assert.equal(out.total, 1402.5);
  assert.equal(out.subtotal, null);
  assert.deepEqual(out.lines, [{ sku: null, description: 'Widget', qty: 3, unit: null, unitPrice: 10, amount: 30 }]);
});

// A stand-in for the Groq API so the AI path can be tested without a key or a network.
const fakeGroq = (payload, { status = 200 } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (status === 200 ? { choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }] } : { error: { message: 'nope' } }),
    };
  };
  return { fetchImpl, calls };
};

const groqAnswerFor = (sample, overrides = {}) => ({
  vendorName: sample.vendor.name,
  abn: sample.vendor.abn,
  invoiceNumber: sample.invoiceNumber,
  invoiceDate: '2026-09-14',
  dueDate: '2026-10-14',
  poNumber: sample.poNumber,
  lines: sample.lines.map((l) => ({ ...l, amount: l.qty * l.unitPrice })),
  ...sampleTotals(sample),
  confidence: 0.97,
  notes: null,
  ...overrides,
});

test('AI reader: sends a JSON-mode request and returns the fields', async () => {
  const sample = findSample('clean');
  const text = renderInvoiceText(sample);
  const { fetchImpl, calls } = fakeGroq(groqAnswerFor(sample));
  const { extracted, extraction } = await extractWithGroq(text, { apiKey: 'k', model: 'some-model', fetchImpl });

  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.equal(calls[0].body.model, 'some-model');
  assert.equal(calls[0].body.temperature, 0);
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.ok(calls[0].body.messages[1].content.includes('HOS-10482'));

  assert.equal(extracted.invoiceNumber, 'HOS-10482');
  assert.equal(extracted.total, 1402.5);
  assert.deepEqual(extraction, { method: 'groq', model: 'some-model', confidence: 0.97, notes: null });
});

test('AI reader: values that are not in the invoice text cut the confidence', async () => {
  const sample = findSample('clean');
  const text = renderInvoiceText(sample);
  const { fetchImpl } = fakeGroq(groqAnswerFor(sample, { invoiceNumber: 'HOS-99999', total: 1500 }));
  const { extraction } = await extractWithGroq(text, { apiKey: 'k', model: 'm', fetchImpl });
  assert.equal(extraction.confidence, 0.5);
  assert.match(extraction.notes, /invoice number, total/);
});

test('grounding check accepts the formats invoices use', () => {
  const text = 'ABN 51 824 753 556\nInvoice no: ab-12\nPO: po-7\nTotal $12,400.00';
  assert.deepEqual(ungroundedFields({ abn: '51824753556', invoiceNumber: 'AB-12', poNumber: 'PO-7', total: 12400 }, text), []);
  assert.deepEqual(ungroundedFields({ abn: '51824753557', invoiceNumber: 'AB-13', poNumber: null, total: 12400.5 }, text), ['invoice number', 'ABN', 'total']);
});

test('Groq client: clear errors for a bad key, rate limit, bad JSON and no network', async () => {
  const args = { apiKey: 'k', model: 'm', system: 's', user: 'u' };
  await assert.rejects(() => groqJson({ ...args, apiKey: '' }), /GROQ_API_KEY is not set/);
  await assert.rejects(() => groqJson({ ...args, fetchImpl: fakeGroq({}, { status: 401 }).fetchImpl }), /rejected the API key/);
  await assert.rejects(() => groqJson({ ...args, fetchImpl: fakeGroq({}, { status: 429 }).fetchImpl }), /rate limit/);
  await assert.rejects(() => groqJson({ ...args, fetchImpl: fakeGroq({}, { status: 500 }).fetchImpl }), /error \(500\): nope/);
  await assert.rejects(() => groqJson({ ...args, fetchImpl: fakeGroq('not json at all').fetchImpl }), /not valid JSON/);
  await assert.rejects(() => groqJson({ ...args, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }), /Could not reach Groq/);
});

// A slow/large reasoning model occasionally reports 200 OK but the connection
// drops (or the proxy resets it) before the body finishes arriving. res.json()
// then rejects on a response that already passed the res.ok check. This must
// surface as the same kind of clean, catchable error as every other Groq
// failure, not an unguarded rejection that could escape the agent's try/catch.
test('Groq client: a 200 response whose body cannot be read is a clean error, not an unguarded rejection', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error('read ECONNRESET'); },
  });
  await assert.rejects(
    () => groqJson({ apiKey: 'k', model: 'm', system: 's', user: 'u', fetchImpl }),
    /Could not read Groq's response \(read ECONNRESET\)/,
  );
});

test('AI reader: a reasoning model that adds a "reasoning" field and sends nested/non-string values does not crash the reader', async () => {
  const sample = findSample('clean');
  const text = renderInvoiceText(sample);
  // gpt-oss style reasoning models put their chain of thought in a sibling
  // "reasoning" field (left alone by groqJson, which only reads .content) and
  // can be sloppy about the shape of individual fields inside the JSON body.
  const messyAnswer = {
    ...groqAnswerFor(sample),
    reasoning: 'Let me think through this invoice step by step...'.repeat(50),
    abn: { value: sample.vendor.abn }, // nested object instead of a string
    poNumber: ['PO-2041'], // array instead of a string
    lines: [...sample.lines.map((l) => ({ ...l, amount: l.qty * l.unitPrice, qty: String(l.qty) })), { sku: null, description: null, amount: null }, 'not an object', null],
    notes: { text: 'fine', confidence: 'high' }, // nested object instead of a string
  };
  const { fetchImpl } = fakeGroq(messyAnswer);

  const { extracted, extraction } = await extractWithGroq(text, { apiKey: 'k', model: 'm', fetchImpl });

  // The nested/odd fields are coerced into harmless strings/nulls rather than crashing the reader.
  assert.equal(extracted.abn, null, 'a nested object has no digits once stringified, so it normalises to null');
  assert.equal(typeof extracted.poNumber, 'string');
  assert.equal(extracted.lines.length, sample.lines.length, 'the malformed extra line entries are dropped');
  assert.equal(typeof extraction.notes, 'string');
  assert.ok(!('reasoning' in extraction), 'the reasoning field is never copied onto the extraction result');
});
