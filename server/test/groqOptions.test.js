// groqJson's per-call options (docs/phase2-design.md decision 6): retries,
// maxTokens and reasoningEffort. Without them, the request is exactly as before.

import test from 'node:test';
import assert from 'node:assert/strict';

import { groqJson, GroqError, RETRY } from '../src/llm/groq.js';

const answer = (content) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content } }] }) });
const busy = (retryAfter = '3') => ({
  ok: false,
  status: 429,
  headers: new Headers(retryAfter ? { 'retry-after': retryAfter } : {}),
  json: async () => ({ error: { message: 'busy' } }),
});

function harness(responses) {
  let t = 0;
  const bodies = [];
  const args = {
    apiKey: 'k',
    model: 'test-model',
    system: 's',
    user: 'u',
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return responses.shift();
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { args, bodies };
}

test('without the new options the request body is unchanged', async () => {
  const h = harness([answer('{"a":1}')]);
  await groqJson(h.args);
  assert.deepEqual(h.bodies, [
    {
      model: 'test-model',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ],
    },
  ]);
});

test('maxTokens and reasoningEffort are sent as max_completion_tokens and reasoning_effort', async () => {
  const h = harness([answer('{"a":1}')]);
  await groqJson({ ...h.args, maxTokens: 200, reasoningEffort: 'low' });
  assert.equal(h.bodies[0].max_completion_tokens, 200);
  assert.equal(h.bodies[0].reasoning_effort, 'low');
  assert.equal(h.bodies[0].temperature, 0);
});

test('retries: the default still tries again; retries 0 makes one request and reports the wait Groq asked for', async () => {
  const again = harness([busy(), busy(), answer('{"ok":true}')]);
  assert.deepEqual(await groqJson(again.args), { ok: true });
  assert.equal(again.bodies.length, RETRY.retries + 1);

  const once = harness([busy('7'), answer('{"ok":true}')]);
  const err = await groqJson({ ...once.args, retries: 0 }).then(
    () => assert.fail('no error'),
    (e) => e,
  );
  assert.ok(err instanceof GroqError);
  assert.equal(err.code, 'rate_limit');
  assert.equal(err.retryAfterMs, 7000);
  assert.equal(once.bodies.length, 1, 'no second request');

  const noHeader = harness([busy(null)]);
  const e2 = await groqJson({ ...noHeader.args, retries: 0 }).then(
    () => assert.fail('no error'),
    (e) => e,
  );
  assert.equal(e2.retryAfterMs, null);
});
