// No request runs past its budget because of the AI reader: every /api
// request has a deadline (REQUEST_BUDGET_SECONDS), and each Groq call's
// timeout and retries are cut to the time left. With too little left, the call
// fails at once (code "timeout") and the reader's fallback takes over.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../test-support/app.js';

// Groq stand-in: count the calls; answer 503 if one is ever made.
const realFetch = globalThis.fetch;
const groq = { calls: 0 };
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith('https://api.groq.com/')) return realFetch(url, opts);
  groq.calls += 1;
  return new Response('{}', { status: 503 });
};

// 5 seconds: less than one attempt needs after the safety margin, so no Groq call is ever started.
const t = await startApp({ GROQ_API_KEY: 'test-groq-key', REQUEST_BUDGET_SECONDS: '5' });
test.after(async () => {
  globalThis.fetch = realFetch;
  await t.stop();
});

const { withDeadline, timeLeftMs, currentDeadline } = await import('../src/llm/deadline.js');
const { groqChat, GroqError, REQUEST_MARGIN_MS } = await import('../src/llm/groq.js');

test('deadlines nest: the earlier one stays in force; without one there is no limit', async () => {
  assert.equal(currentDeadline(), null);
  assert.equal(timeLeftMs(), Infinity);
  const now = Date.now();
  await withDeadline(now + 10000, () =>
    withDeadline(now + 60000, async () => {
      assert.equal(currentDeadline(), now + 10000, 'a later deadline cannot extend an earlier one');
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(currentDeadline(), now + 10000, 'kept across awaits');
    }),
  );
  await withDeadline(now + 60000, () => withDeadline(now + 5000, () => assert.equal(currentDeadline(), now + 5000)));
});

test('a Groq call is cut to the time left: too little, and it fails at once without calling Groq', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
  };
  const clock = { t: 1_000_000 };
  const opts = { apiKey: 'k', model: 'm', body: {}, fetchImpl, now: () => clock.t, sleep: async (ms) => (clock.t += ms) };

  // After the margin, 4.999 s usable: under one attempt's 5 s minimum. No call.
  await withDeadline(clock.t + REQUEST_MARGIN_MS + 4999, () =>
    assert.rejects(groqChat(opts), (err) => err instanceof GroqError && err.code === 'timeout' && /not enough time left/.test(err.message)),
  );
  assert.equal(calls, 0);

  // Without a deadline: the first try and both retries.
  await assert.rejects(groqChat(opts), (err) => err.code === 'server');
  assert.equal(calls, 3);

  // 6 s usable: the first try and one retry; the second retry would not fit, so it is not made.
  calls = 0;
  await withDeadline(clock.t + 6000 + REQUEST_MARGIN_MS, () => assert.rejects(groqChat(opts), (err) => err.code === 'server'));
  assert.equal(calls, 2);
});

test('Process again, uploads and supplier emails never wait on Groq past the request budget: they fall back at once', async () => {
  const reviewer = await t.signIn('reviewer');
  const added = await reviewer.post('/api/invoices', { sampleId: 'clean' });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.equal(added.data.invoice.extraction.fallback.code, 'timeout');
  assert.match(added.data.invoice.extraction.fallback.reason, /not enough time left/);
  assert.equal(added.data.invoice.status, 'needs_review');

  const again = await reviewer.post(`/api/invoices/${added.data.invoice._id}/rerun`, {});
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.invoice.extraction.fallback.code, 'timeout', 'Process again: the same');
  assert.equal(again.data.invoice.checks.find((c) => c.id === 'ai_reader_unavailable').status, 'fail');

  const email = await reviewer.post('/api/queries', { sampleId: 'status-approved' });
  assert.equal(email.status, 201, JSON.stringify(email.data));
  assert.equal(email.data.query.reading.fallback.code, 'timeout');
  assert.equal(email.data.query.status, 'needs_person', 'never answered automatically');

  assert.equal(groq.calls, 0, 'no Groq call was started that could not finish in time');
});
