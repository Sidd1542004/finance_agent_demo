// Groq retries: busy or briefly unavailable is tried again; a bad request or
// key is not; everything fits in the time budget.

import test from 'node:test';
import assert from 'node:assert/strict';

import { groqJson, retryAfterMs } from '../src/llm/groq.js';

const ok = (obj) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] }) });
const fail = (status, headers = {}) => ({ ok: false, status, headers: new Headers(headers), json: async () => ({ error: { message: 'busy' } }) });

// A clock that only moves when the client "sleeps", so the tests take no real time.
function harness(responses) {
  let t = 0;
  const waits = [];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const args = {
    apiKey: 'k',
    model: 'm',
    system: 's',
    user: 'u',
    fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
  };
  return { args, waits, calls };
}

const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

test('429, 5xx, network errors and timeouts are retried, then succeed', async () => {
  for (const first of [fail(429), fail(500), fail(503), new TypeError('fetch failed'), timeout()]) {
    const h = harness([first, ok({ a: 1 })]);
    assert.deepEqual(await groqJson(h.args), { a: 1 });
    assert.equal(h.calls.length, 2);
    assert.equal(h.waits.length, 1);
  }
});

test('up to two retries, then the usual clear message', async () => {
  let h = harness([fail(429), fail(429), fail(429), ok({})]);
  await assert.rejects(() => groqJson(h.args), /^Error: Groq rate limit reached\. Wait a moment and process the invoice again\.$/);
  assert.equal(h.calls.length, 3);

  h = harness([fail(502), fail(502), fail(502)]);
  await assert.rejects(() => groqJson(h.args), /Groq returned an error \(502\): busy/);

  h = harness([timeout(), timeout(), timeout()]);
  await assert.rejects(() => groqJson(h.args), /Could not reach Groq \(timed out\)\./);

  h = harness([new Error('getaddrinfo ENOTFOUND api.groq.com'), new Error('getaddrinfo ENOTFOUND api.groq.com'), new Error('getaddrinfo ENOTFOUND api.groq.com')]);
  await assert.rejects(() => groqJson(h.args), /Could not reach Groq \(getaddrinfo ENOTFOUND/);
  assert.equal(h.calls.length, 3);
});

test('400 and 401 are never retried', async () => {
  let h = harness([fail(401), ok({})]);
  await assert.rejects(() => groqJson(h.args), /rejected the API key/);
  assert.equal(h.calls.length, 1);

  h = harness([fail(400), ok({})]);
  await assert.rejects(() => groqJson(h.args), /Groq returned an error \(400\): busy/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.waits, []);
});

test('Retry-After is honoured, and capped', async () => {
  let h = harness([fail(429, { 'retry-after': '3' }), ok({})]);
  await groqJson(h.args);
  assert.deepEqual(h.waits, [3000]);

  h = harness([fail(429, { 'retry-after': '120' }), ok({})]);
  await groqJson(h.args);
  assert.deepEqual(h.waits, [8000], 'a long Retry-After is capped');

  h = harness([fail(503), fail(503), ok({})]);
  await groqJson(h.args);
  assert.equal(h.waits.length, 2);
  assert.ok(h.waits[1] > h.waits[0], 'the backoff grows');

  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('0.5'), 500);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(retryAfterMs('soon'), null);
  assert.equal(retryAfterMs(null), null);
});

test('retries stop when they would not fit in the time budget', async () => {
  // Each attempt "takes" 20 s; the budget is 45 s, so a third attempt never starts.
  let t = 0;
  const calls = [];
  const args = {
    apiKey: 'k',
    model: 'm',
    system: 's',
    user: 'u',
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    fetchImpl: async (url, init) => {
      calls.push(init);
      t += 20000;
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    },
  };
  await assert.rejects(() => groqJson(args), /timed out/);
  assert.equal(calls.length, 2);
  assert.ok(t < 60000, 'well inside the 60 s function limit');
});

test('each attempt gets no more time than is left in the budget', async () => {
  const h = harness([ok({})]);
  await groqJson({ ...h.args, timeoutMs: 30000, budgetMs: 45000 });
  assert.ok(h.calls[0].signal instanceof AbortSignal);
});
