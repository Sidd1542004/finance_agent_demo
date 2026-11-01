// Token accounting: the optional onUsage callback on groqChat / groqJson
// receives Groq's usage once per answer; callers without it behave as before.

import test from 'node:test';
import assert from 'node:assert/strict';

import { groqJson, groqChat } from '../src/llm/groq.js';

const USAGE = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
const answer = (content, usage = USAGE) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  // usage null: the answer has no usage field at all
  json: async () => ({ choices: [{ message: { content } }], ...(usage === null ? {} : { usage }) }),
});
const busy = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }), json: async () => ({ error: { message: 'busy' } }) });

function harness(responses) {
  let t = 0;
  const calls = [];
  const args = {
    apiKey: 'k',
    model: 'test-model',
    system: 's',
    user: 'u',
    fetchImpl: async (url, init) => {
      calls.push(init);
      return responses.shift();
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { args, calls };
}

test('onUsage receives the usage, the model and the purpose, once per answer', async () => {
  const seen = [];
  const h = harness([answer('{"a":1}')]);
  const out = await groqJson({ ...h.args, purpose: 'understand', onUsage: (usage, meta) => seen.push({ usage, meta }) });
  assert.deepEqual(out, { a: 1 });
  assert.deepEqual(seen, [{ usage: USAGE, meta: { model: 'test-model', purpose: 'understand' } }]);
});

test('after a retry it is still called once, for the answer', async () => {
  const seen = [];
  const h = harness([busy(), answer('{"a":1}')]);
  await groqJson({ ...h.args, onUsage: (usage, meta) => seen.push({ usage, meta }) });
  assert.equal(h.calls.length, 2);
  assert.deepEqual(seen, [{ usage: USAGE, meta: { model: 'test-model', purpose: null } }]);
});

test('without onUsage: the same answer and the same request to Groq', async () => {
  const plain = harness([answer('{"a":1}')]);
  const counted = harness([answer('{"a":1}')]);
  const a = await groqJson(plain.args);
  const b = await groqJson({ ...counted.args, purpose: 'understand', onUsage: () => {} });
  assert.deepEqual(a, b);
  // Neither the callback nor the purpose is sent to Groq.
  assert.equal(plain.calls[0].body, counted.calls[0].body);
  assert.deepEqual(Object.keys(JSON.parse(plain.calls[0].body)), ['model', 'temperature', 'response_format', 'messages']);
});

test('an answer that is not JSON still reports its tokens, then fails as before', async () => {
  const seen = [];
  const h = harness([answer('not json')]);
  await assert.rejects(
    () => groqJson({ ...h.args, onUsage: (usage) => seen.push(usage) }),
    (err) => err.code === 'bad_output',
  );
  assert.deepEqual(seen, [USAGE]);
  // And the same without a callback.
  await assert.rejects(
    () => groqJson(harness([answer('not json')]).args),
    (err) => err.code === 'bad_output',
  );
});

test('an answer without usage gives null', async () => {
  const seen = [];
  await groqJson({ ...harness([answer('{}', null)]).args, onUsage: (usage) => seen.push(usage) });
  assert.deepEqual(seen, [null]);
});

test('a callback that throws or rejects does not change the result', async () => {
  const thrown = await groqJson({
    ...harness([answer('{"a":1}')]).args,
    onUsage: () => {
      throw new Error('accounting down');
    },
  });
  assert.deepEqual(thrown, { a: 1 });
  const rejected = await groqJson({ ...harness([answer('{"a":2}')]).args, onUsage: async () => Promise.reject(new Error('accounting down')) });
  assert.deepEqual(rejected, { a: 2 });
});

test('groqChat takes the same callback', async () => {
  const seen = [];
  const h = harness([answer('{"ok":true}')]);
  const { system, user, ...rest } = h.args;
  const out = await groqChat({ ...rest, body: { messages: [{ role: 'user', content: user }], system }, purpose: 'summary', onUsage: (usage, meta) => seen.push(meta) });
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(seen, [{ model: 'test-model', purpose: 'summary' }]);
});

test('no API key: fails before any call, and onUsage is not called', async () => {
  let called = false;
  await assert.rejects(
    () => groqJson({ ...harness([]).args, apiKey: '', onUsage: () => (called = true) }),
    (err) => err.code === 'not_configured',
  );
  assert.equal(called, false);
});
