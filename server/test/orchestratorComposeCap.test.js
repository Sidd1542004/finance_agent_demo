// The output caps of the assistant's model calls against a reasoning model
// (docs/phase2-design.md §18). openai/gpt-oss-120b counts its reasoning as
// output: when the cap is too small it runs out before writing any JSON, and
// Groq refuses the call with 400 json_validate_failed. The stand-in below does
// the same, using the most output tokens a real call needed (measured
// 2026-11-02 with the configured model): 705 for an explanation (compose),
// about 200 for a classification.

import test from 'node:test';
import assert from 'node:assert/strict';

import { compose, COMPOSE } from '../src/orchestrator/compose.js';
import { classify, CLASSIFY } from '../src/orchestrator/classify.js';
import { callModel, resetModelPause } from '../src/orchestrator/model.js';
import { invoiceClaims } from '../src/orchestrator/ground.js';

const NEEDED = { compose: 705, classify: 200 };

// Answers like Groq for gpt-oss: a cap below what the answer needs is a 400 json_validate_failed.
function groqLike(content, needed) {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if ((body.max_completion_tokens ?? Infinity) < needed) {
      return {
        ok: false,
        status: 400,
        headers: new Headers(),
        json: async () => ({
          error: {
            type: 'invalid_request_error',
            code: 'json_validate_failed',
            message: "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
          },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 793, completion_tokens: needed } }),
    };
  };
  return { fetchImpl, bodies };
}

// One invoice on hold, as facts.js builds it.
const view = { invoiceNumber: 'HOS-10517', total: 2890.36, currency: 'AUD', status: 'on_hold' };
const facts = {
  records: [
    {
      handle: 'I1',
      kind: 'invoice',
      id: '6ae72014e574214a187cd9e8',
      invoiceNumber: 'HOS-10517',
      supplier: 'Harbour Office Supplies Pty Ltd',
      total: 2890.36,
      currency: 'AUD',
      status: 'on_hold',
      due: null,
      failedChecks: [],
    },
  ],
  history: [],
  extra: [],
  grounding: { records: [{ handle: 'I1', refs: ['HOS-10517'], claims: invoiceClaims(view) }], views: [view] },
};
const EXPLANATION = { summary: 'HOS-10517 is on hold.', items: [{ handle: 'I1', text: 'A reviewer put it on hold.' }] };
const deps = (fetchImpl) => ({ apiKey: 'test-key', model: 'openai/gpt-oss-120b', fetchImpl });

test.beforeEach(() => resetModelPause());

test('the caps: compose 1200 output tokens, classify unchanged at 500', () => {
  assert.equal(COMPOSE.maxTokens, 1200);
  assert.equal(CLASSIFY.maxTokens, 500);
  assert.ok(COMPOSE.maxTokens >= NEEDED.compose * 1.5, 'room above the most a real explanation used');
  assert.ok(CLASSIFY.maxTokens >= NEEDED.classify * 2);
});

test('compose sends its 1200 cap and gets an explanation from a reasoning model', async () => {
  const g = groqLike(EXPLANATION, NEEDED.compose);
  const r = await compose('explain_invoice_status', facts, {}, deps(g.fetchImpl));
  assert.equal(g.bodies.length, 1);
  assert.equal(g.bodies[0].max_completion_tokens, 1200);
  assert.equal(g.bodies[0].model, 'openai/gpt-oss-120b', 'the configured model, as for classification');
  assert.equal(g.bodies[0].reasoning_effort, undefined, 'no reasoning effort for compose');
  assert.equal(r.source, 'model');
  assert.equal(r.summary, 'HOS-10517 is on hold.');
  assert.equal(r.call.outcome, 'ok');
});

test('the regression: with the old 400 cap the stand-in refuses the call, as Groq did', async () => {
  const g = groqLike(EXPLANATION, NEEDED.compose);
  const r = await callModel({ purpose: 'compose', ...deps(g.fetchImpl), system: 's', user: '{}', maxTokens: 400, timeoutMs: COMPOSE.timeoutMs });
  assert.deepEqual([r.ok, r.code], [false, 'bad_request']);
  assert.equal(g.bodies[0].max_completion_tokens, 400);
});

test('classification still sends its 500 cap and works', async () => {
  const g = groqLike({ intent: 'unknown', args: {}, clarity: 'clear' }, NEEDED.classify);
  const r = await classify('hello there', deps(g.fetchImpl));
  assert.equal(g.bodies[0].max_completion_tokens, 500);
  assert.deepEqual([r.ok, r.intent], [true, 'unknown']);
});

test('genuine failures still fall back to the records, with their reason', async () => {
  // Groq refuses the JSON whatever the cap.
  const refused = groqLike(EXPLANATION, Infinity);
  const a = await compose('explain_invoice_status', facts, {}, deps(refused.fetchImpl));
  assert.deepEqual([a.source, a.fallback, refused.bodies.length], ['template', 'bad_request', 1], 'no retry');

  const busy = async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '5' }), json: async () => ({}) });
  const b = await compose('explain_invoice_status', facts, {}, deps(busy));
  assert.deepEqual([b.source, b.fallback], ['template', 'rate_limit']);
  resetModelPause();

  const slow = async () => {
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  };
  const c = await compose('explain_invoice_status', facts, {}, deps(slow));
  assert.deepEqual([c.source, c.fallback], ['template', 'timeout']);

  const notJson = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: 'not json' } }] }) });
  const d = await compose('explain_invoice_status', facts, {}, deps(notJson));
  assert.deepEqual([d.source, d.fallback], ['template', 'bad_output']);
});
