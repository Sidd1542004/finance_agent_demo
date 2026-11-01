// The classify call (src/orchestrator/classify.js, model.js;
// docs/phase2-design.md §3.2). Groq is a stand-in fetch: no network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { classify, classifyInput, CLASSIFY, CLASSIFY_SYSTEM } from '../src/orchestrator/classify.js';
import { modelPaused, resetModelPause } from '../src/orchestrator/model.js';
import { withDeadline } from '../src/llm/deadline.js';
import { MENU, parseIntent } from '../src/orchestrator/intents.js';

const ok = (content, usage = { prompt_tokens: 600, completion_tokens: 40 }) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ choices: [{ message: { content } }], usage }),
});
const status = (code, headers = {}) => ({ ok: false, status: code, headers: new Headers(headers), json: async () => ({ error: { message: 'no' } }) });

function standIn(responses) {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  return { fetchImpl, bodies };
}
const answer = (obj) => ok(JSON.stringify(obj));
const run = (question, s, extra = {}) => classify(question, { apiKey: 'test-key', model: 'test-model', fetchImpl: s.fetchImpl, ...extra });

test.beforeEach(() => resetModelPause());

test('one request: JSON, temperature 0, capped output, no retries; only the question and the previous intent', async () => {
  const s = standIn([answer({ intent: 'payment_status', args: { thisRecord: true }, clarity: 'clear' })]);
  const r = await run('has it been paid', s, { previous: { intent: 'find_invoice', records: 1 } });
  assert.equal(s.bodies.length, 1);
  const [body] = s.bodies;
  assert.equal(body.model, 'test-model');
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_completion_tokens, CLASSIFY.maxTokens);
  assert.equal(body.reasoning_effort, undefined, 'none unless configured');
  assert.equal(body.messages[0].content, CLASSIFY_SYSTEM);
  assert.deepEqual(JSON.parse(body.messages[1].content), { question: 'has it been paid', previous: { intent: 'find_invoice', records: 1 } });
  assert.deepEqual(classifyInput('q'), JSON.stringify({ question: 'q' }));
  assert.equal(r.ok, true);
  assert.deepEqual([r.intent, r.args, r.clarity], ['payment_status', { thisRecord: true }, 'clear']);
  assert.deepEqual(r.call, { purpose: 'classify', model: 'test-model', ms: r.call.ms, promptTokens: 600, completionTokens: 40, outcome: 'ok' });

  const low = standIn([answer({ intent: 'unknown', args: {}, clarity: 'clear' })]);
  await run('hello', low, { reasoningEffort: 'low' });
  assert.equal(low.bodies[0].reasoning_effort, 'low');
});

test('a typed argument that is not in the question is dropped and the person is asked', async () => {
  const fixed = await run('why is scp 7713 on hold', standIn([answer({ intent: 'explain_invoice_status', args: { invoiceRef: 'SCP-7731' }, clarity: 'clear' })]));
  assert.deepEqual([fixed.intent, fixed.args, fixed.clarity, fixed.dropped], ['explain_invoice_status', {}, 'unclear', ['invoiceRef']]);
  const find = await run('find that invoice', standIn([answer({ intent: 'find_invoice', args: { invoiceRef: 'HOS-10482' }, clarity: 'clear' })]));
  assert.deepEqual([find.intent, find.args, find.clarity], ['find_invoice', {}, 'unclear'], 'find_invoice without a number no longer fits');
  const kept = await run('Why is scp 7731 held?', standIn([answer({ intent: 'explain_invoice_status', args: { invoiceRef: 'scp 7731' }, clarity: 'clear' })]));
  assert.deepEqual([kept.args, kept.clarity], [{ invoiceRef: 'scp 7731' }, 'clear']);
  const back = await run('why is it held', standIn([answer({ intent: 'explain_invoice_status', args: { thisRecord: true }, clarity: 'clear' })]));
  assert.equal(back.clarity, 'unclear', 'points back with no previous record');
  const unsure = await run(
    'the Acme stuff',
    standIn([
      answer({
        intent: 'supplier_summary',
        args: { supplierRef: 'Acme' },
        clarity: 'unclear',
        alternatives: ['explain_invoice_status', 'approve_all', 'supplier_summary', 'unknown'],
      }),
    ]),
  );
  assert.deepEqual([unsure.clarity, unsure.alternatives], ['unclear', ['explain_invoice_status']], 'alternatives from the list only');
});

test('an answer outside the closed list or its schema is bad_output', async () => {
  const bad = [
    answer({ intent: 'approve_invoice', args: {}, clarity: 'clear' }),
    answer({ intent: 'list_unpaid_invoices', args: { invoiceId: '6ae72014e574214a187cd9a4' }, clarity: 'clear' }),
    answer({ intent: 'list_unpaid_invoices', args: {} }),
    answer({ intent: 'list_unpaid_invoices', args: {}, clarity: 0.93 }),
    ok('{}'),
    ok('not json at all'),
    ok(''),
    ok('[1,2]'),
  ];
  for (const response of bad) {
    const r = await run('list unpaid', standIn([response]));
    assert.deepEqual([r.ok, r.code, r.call.outcome], [false, 'bad_output', 'bad_output']);
  }
});

test('Groq failures are reason codes with one request at most; a 429 pauses the model for every question', async () => {
  const limited = standIn([status(429, { 'retry-after': '9' }), answer({ intent: 'unknown', args: {}, clarity: 'clear' })]);
  const r = await run('hello', limited);
  assert.deepEqual([r.ok, r.code], [false, 'rate_limit']);
  assert.equal(limited.bodies.length, 1, 'no retry');
  assert.equal(modelPaused(), true);
  const during = standIn([answer({ intent: 'unknown', args: {}, clarity: 'clear' })]);
  assert.equal((await run('hello again', during)).code, 'rate_limit');
  assert.equal(during.bodies.length, 0, 'no request while paused');
  assert.equal(modelPaused(Date.now() + 10000), false, 'the pause ends');
  resetModelPause();

  const cases = [
    [status(500), 'server'],
    [status(503), 'server'],
    [status(401), 'auth'],
    [status(400), 'bad_request'],
    [Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'timeout'],
    [new Error('socket hang up'), 'network'],
  ];
  for (const [response, code] of cases) {
    const s = standIn([response, answer({ intent: 'unknown', args: {}, clarity: 'clear' })]);
    const out = await run('hello', s);
    assert.deepEqual([out.ok, out.code, s.bodies.length], [false, code, 1], code);
  }
});

test('the menu offered when a question cannot be classified: complete requests that need no record', () => {
  assert.ok(MENU.length >= 5);
  for (const m of MENU) {
    assert.deepEqual(parseIntent(m.intent, m.args), { intent: m.intent, args: m.args }, m.label);
    assert.ok(!Object.keys(m.args).some((k) => ['invoiceRef', 'supplierRef', 'recordRef', 'thisRecord'].includes(k)), `${m.label} needs no record`);
    assert.notEqual(m.intent, 'unknown');
  }
});

test('no key, or too little time left in the request: no request at all', async () => {
  const s = standIn([answer({ intent: 'unknown', args: {}, clarity: 'clear' })]);
  assert.equal((await classify('hello', { apiKey: '', model: 'm', fetchImpl: s.fetchImpl })).code, 'not_configured');
  const late = await withDeadline(Date.now() + 4000, () => run('hello', s));
  assert.equal(late.code, 'timeout');
  assert.equal(s.bodies.length, 0);
});
