import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWithRules, extractWithGroq, normalise, toIsoDate, ungroundedFields, abnLabel } from '../src/agent/finance/extract.js';
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

// ---------- Australian supplier/customer tax detail extraction ----------

test('1. the customer\'s ABN appears before the supplier\'s ABN: neither is mixed up', () => {
  const text = [
    'TAX INVOICE',
    '',
    'Bill to: Example Customer Pty Ltd',
    'ABN: 37 600 518 342',
    '',
    'Supplier: Harbour Office Supplies Pty Ltd',
    'ABN: 57 600 410 275',
    '',
    'Invoice number: HOS-9001',
    'Invoice date: 1 Oct 2026',
    'Due date: 31 Oct 2026',
    'Purchase order: PO-2041',
    '',
    'PAP-A4-80      A4 copy paper 80gsm, carton             20      $42.00       $840.00',
    '',
    'Subtotal (ex GST): $840.00',
    'GST (10%): $84.00',
    'Total (inc GST): $924.00',
  ].join('\n');
  const { extracted } = extractWithRules(text);
  assert.equal(extracted.vendorName, 'Harbour Office Supplies Pty Ltd', 'the label picks the supplier, not the first line');
  assert.equal(extracted.abn, '57600410275', 'the supplier ABN, not the one printed first');
  assert.equal(extracted.customerName, 'Example Customer Pty Ltd');
  assert.equal(extracted.customerAbn, '37600518342', 'the customer ABN is kept, not discarded');
});

test('2. the supplier ABN is printed in the footer, after the Bill To block and the totals', () => {
  const text = [
    'Harbour Office Supplies Pty Ltd',
    '14 Wharf Street, Fremantle WA 6160',
    '',
    'TAX INVOICE',
    'Invoice number: HOS-9002',
    'Invoice date: 1 Oct 2026',
    'Due date: 31 Oct 2026',
    'Purchase order: PO-2041',
    'Bill to: Meridian Logistics Pty Ltd',
    '',
    'PAP-A4-80      A4 copy paper 80gsm, carton             20      $42.00       $840.00',
    '',
    'Subtotal (ex GST): $840.00',
    'GST (10%): $84.00',
    'Total (inc GST): $924.00',
    '',
    'Supplier ABN: 57 600 410 275',
  ].join('\n');
  const { extracted } = extractWithRules(text);
  assert.equal(extracted.abn, '57600410275', 'found even though it is the very last line');
  assert.equal(extracted.vendorName, 'Harbour Office Supplies Pty Ltd');
});

test('3. an "ABN" label with no valid number is treated as missing, not invented', () => {
  const text = [
    'Harbour Office Supplies Pty Ltd',
    'ABN: Pending registration',
    '',
    'TAX INVOICE',
    'Invoice number: HOS-9003',
    'Invoice date: 1 Oct 2026',
    'Total (inc GST): $924.00',
  ].join('\n');
  const { extracted } = extractWithRules(text);
  assert.equal(extracted.abn, null, 'no 11-digit number follows the label, so it is null, not a guess');
});

// Regression: the layout of the INV-000003 invoice PDFs (numbered item rows,
// "Sub Total" with a space, and "PO - 0011" printed on its own under "Subject").
test('the basic pattern reader reads "Sub Total", numbered item rows and an unlabelled "PO - 0011"', () => {
  const text = [
    'Sub Total 120.00',
    'Tax 5% (5%) 6.00',
    'Total $126.00',
    'Australia org',
    'Invoice',
    '# INV-000003',
    'Bill To',
    'Cust sid abn',
    'Subject :',
    'PO - 0011',
    '# Item & Description Qty Rate Amount',
    '1 Normal pipe 1.00 120.00 120.00',
    'Tax Summary',
    'Tax 5% (5%) 120.00 6.00',
    'Total $120.00 $6.00',
  ].join('\n');
  const { extracted, extraction } = extractWithRules(text);
  assert.equal(extracted.subtotal, 120);
  assert.deepEqual(extracted.lines.map((l) => [l.description, l.qty, l.unitPrice, l.amount]), [['Normal pipe', 1, 120, 120]], 'the row number is not part of the description');
  assert.equal(extracted.poNumber, 'PO - 0011', 'kept as printed; resolved to a PO record only when matching');
  assert.equal(extracted.customerAbn, null, '"abn" in the customer\'s name is not an ABN');
  assert.doesNotMatch(extraction.notes || '', /purchase order number/, 'grounded in the text');
});

test('a bare "PO-2041" is read, and a labelled PO still wins', () => {
  assert.equal(extractWithRules('Australia org\nPO-2041\nTotal $1.00').extracted.poNumber, 'PO-2041');
  assert.equal(extractWithRules('Purchase order: PO-2044\nRef PO-2041\nTotal $1.00').extracted.poNumber, 'PO-2044');
  assert.equal(normalise({ poNumber: 'po - 0011' }).poNumber, 'PO - 0011', 'the AI reader\'s reference is kept as printed');
});

// ---------- ABN labels, VAT numbers and the supplier's name (both readers) ----------

const INV3 = [
  'Sub Total 120.00',
  'Tax 5% (5%) 6.00',
  'Total $126.00',
  'Australia org',
  'Australian Capital Territory',
  'Australia',
  'VAT 50110219460',
  'Invoice',
  '# INV-000003',
  'Bill To',
  'Harbour Office Supplies Pty Ltd',
  '1 Normal pipe 1.00 120.00 120.00',
].join('\n');
const inv3Answer = (overrides = {}) => ({
  vendorName: 'Australia org',
  abn: '50110219460', // what the AI reader actually returned for the VAT number
  customerName: 'Harbour Office Supplies Pty Ltd',
  invoiceNumber: 'INV-000003',
  lines: [{ description: 'Normal pipe', qty: 1, unitPrice: 120, amount: 120 }],
  subtotal: 120,
  gst: 6,
  total: 126,
  confidence: 0.9,
  ...overrides,
});

test('a number labelled VAT is never the supplier\'s ABN, even though it passes the ABN checksum (AI and pattern readers)', async () => {
  const { fetchImpl } = fakeGroq(inv3Answer());
  const ai = await extractWithGroq(INV3, { apiKey: 'k', model: 'm', fetchImpl });
  assert.equal(ai.extracted.abn, null);
  assert.equal(ai.extracted.vatNumber, '50110219460', 'kept separately as the VAT number');
  assert.deepEqual(ai.extracted.rejectedIds, [{ field: 'abn', value: '50110219460', label: 'VAT' }]);
  assert.match(ai.extraction.notes, /prints it labelled "VAT", not as an ABN/);

  const rules = extractWithRules(INV3);
  assert.equal(rules.extracted.abn, null);
  assert.equal(rules.extracted.vatNumber, '50110219460');

  // Labelled as both, or not labelled at all: still not an ABN.
  for (const line of ['ABN/VAT: 50 110 219 460', 'Reg 50110219460', '50110219460']) {
    const { fetchImpl: f } = fakeGroq(inv3Answer());
    const r = await extractWithGroq(INV3.replace('VAT 50110219460', line), { apiKey: 'k', model: 'm', fetchImpl: f });
    assert.equal(r.extracted.abn, null, line);
  }
});

test('an ABN printed with an "ABN" label is still used: header, next line, footer, and "Australian Business Number"', async () => {
  for (const line of ['ABN 50 110 219 460', 'ABN:\n50 110 219 460', 'Supplier A.B.N. 50110219460', 'Australian Business Number: 50 110 219 460']) {
    const { fetchImpl } = fakeGroq(inv3Answer());
    const r = await extractWithGroq(INV3.replace('VAT 50110219460', '') + `\n${line}`, { apiKey: 'k', model: 'm', fetchImpl });
    assert.equal(r.extracted.abn, '50110219460', line);
    assert.equal(r.extracted.rejectedIds, undefined, line);
  }
});

test('ABN label placements seen on real invoices are accepted; anything ambiguous still is not', () => {
  const accepted = [
    'ABN 50 110 219 460',
    'ABN: 50 110 219 460',
    'ABN : 50110219460',
    'ABN No.: 50 110 219 460',
    'ABN #50 110 219 460',
    'ABN - 50-110-219-460',
    'abn 50110219460',
    'A.B.N. 50.110.219.460',
    'Supplier ABN: 50 110 219 460',
    'Australian Business Number: 50 110 219 460',
    'Australian Business Number (ABN): 50 110 219 460',
    '(ABN) 50 110 219 460',
    'ABN 50 110 219 460', // non-breaking spaces from a PDF text layer
    'ABN 50  110  219  460',
    'ABN\n50 110 219 460', // label on the line above
    'Australia org | ABN: 50 110 219 460 | ACN: 004 085 616', // ACN after the number does not matter
  ];
  for (const t of accepted) assert.equal(abnLabel('50110219460', t), 'abn', JSON.stringify(t));
  const rejected = {
    'VAT 50110219460': 'VAT',
    'VAT No: 50 110 219 460': 'VAT',
    'ABN/VAT: 50 110 219 460': 'VAT',
    'ABN/GST No: 50 110 219 460': 'GST No',
    'Tax ID 50110219460': 'Tax ID',
    'ABN ACN\n50 110 219 460 004 085 616': 'ACN',
    'Phone 50110219460': 'Phone',
    '50 110 219 460 ABN': '', // the label after the number is not trusted
    'Ref 50110219460': 'Ref',
    'Our ABN is 50 110 219 460': 'Our ABN is',
    'ABN\n\n50 110 219 460': '', // label two lines up, with a gap: not trusted
  };
  for (const [t, label] of Object.entries(rejected)) assert.equal(abnLabel('50110219460', t), label, JSON.stringify(t));
  assert.equal(abnLabel('50110219460', 'ABN 150110219460'), '', 'part of a longer number is not this ABN');
});

test('AI reader: the customer\'s ABN printed before the supplier\'s ABN: both kept, neither mixed up', async () => {
  const text = 'Bill to: Harbour Office Supplies Pty Ltd\nABN: 57 600 410 275\n\nSupplier: Australia org\nABN: 50 110 219 460\nInvoice # INV-000003\nTotal $126.00';
  const { fetchImpl } = fakeGroq(inv3Answer({ customerAbn: '57600410275' }));
  const { extracted } = await extractWithGroq(text, { apiKey: 'k', model: 'm', fetchImpl });
  assert.equal(extracted.abn, '50110219460');
  assert.equal(extracted.customerAbn, '57600410275');
});

test('a missing supplier name caps the confidence, however sure the AI reader says it is', async () => {
  const { fetchImpl } = fakeGroq(inv3Answer({ vendorName: null, customerName: null, confidence: 0.97 }));
  const { extracted, extraction } = await extractWithGroq(INV3, { apiKey: 'k', model: 'm', fetchImpl });
  assert.equal(extracted.vendorName, null);
  assert.equal(extraction.confidence, 0.5, 'effective confidence, below the 80% minimum');
  assert.equal(extraction.rawConfidence, 0.97, 'what the reader claimed is kept for the audit trail');
  assert.match(extraction.notes, /supplier's name was not found/);
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
