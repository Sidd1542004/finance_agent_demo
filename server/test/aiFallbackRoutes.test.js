// The Groq fallback through the real app, with GROQ_API_KEY set and Groq
// replaced by a stand-in: an invoice read while Groq is down goes to Needs
// Review, GET /api/invoices/summary says so, approval is refused by the API, and correcting
// the fields or processing it again once Groq is back clears it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../test-support/app.js';

// Groq stand-in: every call to api.groq.com is answered here; everything else goes through.
const realFetch = globalThis.fetch;
const groq = { status: 401, content: null, calls: 0 };
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith('https://api.groq.com/')) return realFetch(url, opts);
  groq.calls += 1;
  if (groq.status !== 200) return new Response(JSON.stringify({ error: { message: 'stand-in' } }), { status: groq.status, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ choices: [{ message: { content: groq.content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const t = await startApp({ GROQ_API_KEY: 'test-groq-key', GROQ_MODEL: 'stand-in-model' });
test.after(async () => {
  globalThis.fetch = realFetch;
  await t.stop();
});

const { extractWithRules } = await import('../src/agent/finance/extract.js');
const { renderInvoiceText, findSample } = await import('../src/seed/data.js');
const reviewer = await t.signIn('reviewer');
const approver = await t.signIn('approver');
const check = (inv) => inv.checks.find((c) => c.id === 'ai_reader_unavailable');
// The header's count: signed in, any role. (GET /api/health says nothing about it.)
const health = async () => {
  const [summary, status] = await Promise.all([reviewer.get('/api/invoices/summary'), reviewer.get('/api/status')]);
  return { mode: status.data.reader.mode, fallback: summary.data.readerFallback };
};

test('Groq rejects the key: the invoice is read by the rules reader, goes to Needs Review, and the invoice summary shows it', async () => {
  assert.equal((await health()).mode, 'groq');
  assert.deepEqual((await health()).fallback, { invoicesWaiting: 0, lastAt: null, lastCode: null });
  const res = await reviewer.post('/api/invoices', { sampleId: 'clean' });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.ok(groq.calls >= 1, 'the AI reader was tried first');
  assert.equal(res.data.invoice.status, 'needs_review');
  assert.equal(res.data.invoice.extraction.method, 'rules');
  assert.equal(res.data.invoice.extraction.fallback.code, 'auth');
  assert.equal(check(res.data.invoice).status, 'fail');
  assert.equal(res.data.invoice.approval, null);
  const h = await health();
  assert.equal(h.fallback.invoicesWaiting, 1);
  assert.equal(h.fallback.lastCode, 'auth');
  assert.ok(h.fallback.lastAt);
});

test('the API refuses to approve it; correcting the fields clears the block, while Groq is still down', async () => {
  const inv = (await reviewer.get('/api/invoices?filter=waiting')).data.items[0];
  const refused = await approver.post(`/api/invoices/${inv._id}/actions/approve`, { note: 'Looks fine.' });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /rules reader because the AI reader was unavailable/);
  const edited = await reviewer.post(`/api/invoices/${inv._id}/actions/edit_fields`, { note: 'Checked every field against the original.', fields: { dueDate: '2026-10-21' } });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(check(edited.data.invoice).status, 'pass');
  const ok = await approver.post(`/api/invoices/${inv._id}/actions/approve`, { note: 'Fields confirmed by Rita against the original.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.invoice.status, 'approved');
  assert.equal(ok.data.invoice.approval.decidedBy, 'Priya Approver', 'approved by a person');
});

test('Groq unavailable (503 after its retries), then back: processing again reads it with the AI reader and clears it', async () => {
  groq.status = 503;
  const res = await reviewer.post('/api/invoices', { sampleId: 'quantity-variance' });
  assert.equal(res.data.invoice.extraction.fallback.code, 'server');
  assert.equal(res.data.invoice.status, 'needs_review');
  assert.equal((await health()).fallback.invoicesWaiting, 1, 'the approved one no longer counts');

  const text = renderInvoiceText(findSample('quantity-variance'));
  groq.status = 200;
  groq.content = JSON.stringify({ ...extractWithRules(text).extracted, confidence: 0.99, notes: null });
  const again = await reviewer.post(`/api/invoices/${res.data.invoice._id}/rerun`, {});
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.invoice.extraction.method, 'groq');
  assert.equal(check(again.data.invoice), undefined);
  assert.equal(again.data.invoice.aiFallback, null);
  assert.equal(again.data.invoice.approval, null, 'still waiting for a person');
  assert.equal((await health()).fallback.invoicesWaiting, 0);
});
