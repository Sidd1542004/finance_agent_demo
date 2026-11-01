// The two read-only lookup tools added for Phase 2 (docs/phase2-design.md
// §3.3): find_invoices (an invoice by its number, as duplicate detection
// compares numbers) and list_open_invoices (unpaid invoices with the matched
// supplier's ABN). /api/invoices is unchanged (listingsParity.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PEOPLE } from '../test-support/app.js';
import { person } from '../test-support/actors.js';

const t = await startApp({ BUSINESS_DAYS: 'Mon-Sun', PAYMENT_CUTOFF: '23:59', PAYMENT_DEFAULT_TIME: '00:00', BANK_HOLIDAYS: '2000-01-01' });
test.after(t.stop);

const { createToolContext } = await import('../src/orchestrator/context.js');
const { callTool } = await import('../src/orchestrator/tools.js');
const { Invoice, AuditEvent } = await import('../src/models/index.js');
const { invoiceKey } = await import('../src/agent/finance/duplicates.js');

const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.data));
  return res.data;
};
const reviewer = await t.signIn('reviewer');
const approver = await t.signIn('approver');
const add = async (sampleId) => String(ok(await reviewer.post('/api/invoices', { sampleId }), 201).invoice._id);
const clean = await add('clean'); // HOS-10482, Harbour Office Supplies
const cleanAgain = await add('clean'); // the same invoice sent twice
const priceVariance = await add('price-variance'); // HOS-10517
const unknownSupplier = await add('unknown-supplier'); // CPS-0388, not on file
const gstError = await add('gst-error'); // SCP-7790
ok(await approver.post(`/api/invoices/${gstError}/actions/reject`, { note: 'GST is wrong.' }));
// An invoice with a number but no fingerprints (read before fingerprints existed).
const legacy = String((await Invoice.create({ source: { kind: 'paste' }, rawText: 'old', status: 'needs_review', extracted: { invoiceNumber: 'OLD 77', total: 5 } }))._id);

const HARBOUR = '57600410275';
let n = 0;
const ctx = (key = 'reviewer') => createToolContext({ actor: person(PEOPLE[key].name, PEOPLE[key].roles), runId: `lookup-${++n}` });
const ids = (r) => r.items.map((i) => i.id).sort();

test('find_invoices: the number as duplicate detection compares it (case, punctuation, leading zeros)', async () => {
  for (const typed of ['HOS-10482', 'hos-10482', 'HOS 10482', 'hos10482', 'HOS-010482', ' HOS-10482 ']) {
    assert.deepEqual(ids(await callTool(ctx(), 'find_invoices', { invoiceNumber: typed })), [clean, cleanAgain].sort(), typed);
  }
  const one = await callTool(ctx(), 'find_invoices', { invoiceNumber: 'HOS-10517' });
  assert.deepEqual(ids(one), [priceVariance]);
  assert.equal(one.items[0].supplierAbn, HARBOUR);
  assert.equal(one.items[0].invoiceNumber, 'HOS-10517');
  assert.equal(invoiceKey('HOS-010482'), invoiceKey('hos 10482'));
});

test('find_invoices: nothing found is an empty list; no pattern can match everything', async () => {
  for (const typed of ['HOS-99999', 'X', '.*', '^', '$', '|', '(', '.+|.*', '\\d+', '*']) {
    const r = await callTool(ctx(), 'find_invoices', { invoiceNumber: typed });
    assert.deepEqual(r.items, [], typed);
  }
  await assert.rejects(() => callTool(ctx(), 'find_invoices', { invoiceNumber: '' }), { status: 400 });
  await assert.rejects(() => callTool(ctx(), 'find_invoices', { invoiceNumber: 'x'.repeat(41) }), { status: 400 });
  await assert.rejects(() => callTool(ctx(), 'find_invoices', {}), { status: 400 });
});

test('find_invoices: an invoice without fingerprints is found by its number as written', async () => {
  assert.deepEqual(ids(await callTool(ctx(), 'find_invoices', { invoiceNumber: 'old 77' })), [legacy]);
  assert.deepEqual(ids(await callTool(ctx(), 'find_invoices', { invoiceNumber: 'OLD-77' })), [], 'punctuation must match for a number with no fingerprint');
});

test('list_open_invoices: unpaid only, by stage or supplier, with the ABN and the count', async () => {
  const all = await callTool(ctx(), 'list_open_invoices', {});
  assert.ok(!ids(all).includes(gstError), 'a rejected invoice is not open');
  for (const id of [clean, cleanAgain, priceVariance, unknownSupplier, legacy]) assert.ok(ids(all).includes(id), id);
  assert.equal(all.total, all.items.length);
  assert.equal(all.more, false);
  const stored = await Invoice.find({ _id: { $in: all.items.map((i) => i.id) } }).lean();
  for (const item of all.items) {
    const doc = stored.find((d) => String(d._id) === item.id);
    assert.equal(item.status, doc.status);
    assert.equal(item.supplierAbn, doc.supplier?.abn ?? null);
  }
  assert.equal(all.items.find((i) => i.id === unknownSupplier).supplierAbn, null, 'not matched to a supplier on file');

  const harbour = await callTool(ctx(), 'list_open_invoices', { abn: HARBOUR });
  assert.deepEqual(ids(harbour), [clean, cleanAgain, priceVariance].sort());
  const review = await callTool(ctx(), 'list_open_invoices', { stage: 'review' });
  assert.ok(review.items.every((i) => i.status === 'needs_review'));
  assert.deepEqual(ids(await callTool(ctx(), 'list_open_invoices', { stage: 'payment' })), []);

  await assert.rejects(() => callTool(ctx(), 'list_open_invoices', { stage: 'paid' }), { status: 400 });
  await assert.rejects(() => callTool(ctx(), 'list_open_invoices', { abn: '123' }), { status: 400 });
});

test('the lookups are refused without a role, audited once per call, and keep reviewers free of bank fields', async () => {
  const roleless = createToolContext({ actor: person('No Role', []), runId: 'lookup-roleless' });
  await assert.rejects(() => callTool(roleless, 'find_invoices', { invoiceNumber: 'HOS-10482' }), { status: 403 });
  await assert.rejects(() => callTool(roleless, 'list_open_invoices', {}), { status: 403 });
  const c = ctx('reviewer');
  const found = await callTool(c, 'find_invoices', { invoiceNumber: 'HOS-10482' });
  await callTool(c, 'list_open_invoices', {});
  assert.equal(await AuditEvent.countDocuments({ subjectKind: 'orchestrator', subjectId: c.runId }), 2);
  for (const item of found.items) assert.ok(c.hasSeen(item.id));
  const json = JSON.stringify(found);
  for (const k of ['"bank"', 'bsb', 'accountNumber', '•']) assert.ok(!json.includes(k), k);
});
