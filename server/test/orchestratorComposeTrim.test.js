// Explanation items over the 300-character limit (src/orchestrator/compose.js
// fitItems). Observed on real Groq (openai/gpt-oss-120b, 2026-11-02): items of
// 308 and 328 characters made the whole explanation fall back to the records.
// Now an over-long item is trimmed at a sentence ending when what is removed is
// plain words only, and dropped otherwise; the grounding checks run on the
// trimmed text.

import test from 'node:test';
import assert from 'node:assert/strict';

import { compose, fitItems, tailProblem, ITEM_MAX, COMPOSE_SYSTEM } from '../src/orchestrator/compose.js';
import { groundExplanation, groundingNumbers, groundingRefs, invoiceClaims, paymentClaims } from '../src/orchestrator/ground.js';
import { resetModelPause } from '../src/orchestrator/model.js';

// SCP-7731 as the facts block builds it: approved for the received quantity, cheque payment queued.
const invoiceView = {
  invoiceNumber: 'SCP-7731',
  total: 872.52,
  currency: 'AUD',
  status: 'payment_pending',
  approval: { decision: 'approve_received', amount: 727.1 },
  due: { date: '2026-10-15', state: 'overdue', daysUntil: -18 },
};
const paymentView = { invoiceNumber: 'SCP-7731', amount: 727.1, currency: 'AUD', status: 'queued', method: 'Cheque', scheduledFor: '2026-10-03' };
const facts = {
  records: [
    {
      handle: 'I1',
      kind: 'invoice',
      id: 'i1',
      invoiceNumber: 'SCP-7731',
      supplier: 'Southern Cross Pallets Pty Ltd',
      total: 872.52,
      currency: 'AUD',
      status: 'payment_pending',
      due: invoiceView.due,
      failedChecks: ['quantity_match'],
    },
    {
      handle: 'P1',
      kind: 'payment',
      id: 'p1',
      invoiceId: 'i1',
      invoiceNumber: 'SCP-7731',
      supplier: 'Southern Cross Pallets Pty Ltd',
      amount: 727.1,
      currency: 'AUD',
      status: 'queued',
      method: 'Cheque',
      scheduledFor: '2026-10-03',
    },
  ],
  history: [],
  extra: [],
  grounding: {
    records: [
      { handle: 'I1', refs: ['SCP-7731'], claims: invoiceClaims(invoiceView) },
      { handle: 'P1', refs: ['SCP-7731'], claims: paymentClaims(paymentView) },
    ],
    views: [invoiceView, paymentView],
  },
};

// A head of grounded sentences ending at a sentence boundary within 300 characters ...
const HEAD =
  'I1 was approved for the received quantity only, so it waits for its cheque payment P1 of $727.10. That cheque was scheduled for 2026-10-03 and is still queued, which is why the invoice now shows as overdue.';
// ... then a tail of `length` characters in all; `words` is what the tail says (cut to fit).
const item = (length, words) => {
  const room = length - HEAD.length - 2;
  const tail = (words + ' ').repeat(Math.ceil(room / words.length) + 1).slice(0, room);
  const text = `${HEAD} ${tail}.`;
  assert.equal(text.length, length);
  return text;
};
const SAFE = 'Nothing else about it looks unusual or out of the ordinary at all here';

const SHORT = { handle: 'P1', text: 'P1 is a cheque payment that is still queued.' };
const reply = (obj) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 793, completion_tokens: 520 } }),
});
const run = (answer) => compose('explain_invoice_status', facts, { invoiceId: 'i1' }, { apiKey: 'k', model: 'openai/gpt-oss-120b', fetchImpl: async () => reply(answer) });
const SUMMARY = 'SCP-7731 is overdue because its cheque payment is still queued.';

test.beforeEach(() => resetModelPause());

test('the prompt states the limit', () => {
  assert.ok(COMPOSE_SYSTEM.includes('Each explanation item must be at most 300 characters.'));
  assert.equal(ITEM_MAX, 300);
  assert.ok(HEAD.length <= ITEM_MAX);
});

test('the observed 308- and 328-character items are trimmed when the tail is plain words, and pass grounding', async () => {
  for (const length of [308, 328]) {
    const r = await run({ summary: SUMMARY, items: [{ handle: 'I1', text: item(length, SAFE) }, SHORT] });
    assert.equal(r.source, 'model', `${length}`);
    assert.deepEqual(r.items, [{ handle: 'I1', text: HEAD }, SHORT], `${length}: cut at the last sentence ending, grounded`);
    assert.ok(r.items.every((i) => i.text.length <= ITEM_MAX));
    assert.deepEqual([r.call.itemsTrimmed, r.call.itemsDropped, r.call.itemReasons], [1, 0, ['too_long_trimmed']]);
  }
});

test('the same items with a number, reference, date, amount or action in the tail are dropped, and the others survive', async () => {
  const tails = {
    number: 'It has been waiting like this for 14 days in all',
    reference: 'The same thing happened with HOS-10482 before',
    date: 'It has looked like this since October without change',
    amount: 'Nothing else about it is unusual for a few dollars',
    action: 'The payer should chase the supplier about the missing pallets',
    verify: 'Someone should verify the delivery against the purchase order',
  };
  for (const [kind, words] of Object.entries(tails)) {
    const r = await run({ summary: SUMMARY, items: [{ handle: 'I1', text: item(318, words) }, SHORT] });
    assert.equal(r.source, 'model', kind);
    assert.deepEqual(r.items, [SHORT], `${kind}: the long item is dropped, not trimmed`);
    assert.deepEqual([r.call.itemsTrimmed, r.call.itemsDropped, r.call.itemReasons], [0, 1, ['too_long_dropped_has_facts']], kind);
  }
  assert.equal(tailProblem(' Nothing else looks unusual.'), null);
  for (const t of [
    'in 3 days',
    'on Friday',
    'for $5',
    'like SCP-7731',
    'see I2',
    'approve it',
    'request a new invoice',
    'schedule it',
    'put it on hold',
    'check it',
    'contact them',
    'reject it',
    'pay it',
  ]) {
    assert.notEqual(tailProblem(` ${t}.`), null, t);
  }
});

test('an item with no sentence ending within 300 characters is dropped', async () => {
  const runOn = `${'I1 waits for its cheque payment and '.repeat(9)}nothing else`;
  assert.ok(runOn.length > ITEM_MAX && !/[.!?]/.test(runOn));
  const r = await run({ summary: SUMMARY, items: [{ handle: 'I1', text: `${runOn}.` }, SHORT] });
  assert.equal(r.source, 'model');
  assert.deepEqual(r.items, [SHORT]);
  assert.deepEqual(r.call.itemReasons, ['too_long_no_boundary']);
  // A sentence ending only after 300 characters does not count.
  assert.deepEqual(fitItems([{ handle: 'I1', text: `${'a'.repeat(305)}. Short.` }]).reasons, [{ handle: 'I1', reason: 'too_long_no_boundary' }]);
});

test('all items dropped: the record-based answer, with bad_output', async () => {
  const r = await run({
    summary: SUMMARY,
    items: [
      { handle: 'I1', text: item(320, 'The payer should chase it') },
      { handle: 'P1', text: `${'P1 is queued and '.repeat(20)}waiting.` },
    ],
  });
  assert.equal(r.source, 'template');
  assert.equal(r.fallback, 'bad_output');
  assert.deepEqual([r.call.outcome, r.call.itemsTrimmed, r.call.itemsDropped], ['bad_output', 0, 2]);
  // No items at all from the model is not a reason to fall back (as before).
  const none = await run({ summary: SUMMARY });
  assert.equal(none.source, 'model');
});

test('a trimmed item is still checked: an ungrounded number, an unknown reference or a contradicting status is rejected', async () => {
  const head = (sentence) => `${sentence} ${'P1 is a queued cheque payment. '.repeat(8)}`.trim();
  const cases = {
    'ungrounded number': 'I1 was short by 999 pallets.',
    'unknown reference': 'I1 is like INV-4040 from last month.',
    'contradicting status': 'I1 has already been paid.',
  };
  for (const [kind, bad] of Object.entries(cases)) {
    const text = `${head(bad)} ${SAFE}.`;
    assert.ok(text.length > ITEM_MAX, kind);
    const r = await run({ summary: SUMMARY, items: [{ handle: 'I1', text }, SHORT] });
    assert.equal(r.call.itemsTrimmed, 1, `${kind}: trimmed first`);
    const kept = JSON.stringify(r.items ?? []);
    assert.ok(!kept.includes(bad), `${kind}: the bad sentence did not survive`);
    assert.ok(r.source === 'template' || r.dropped.some((d) => d.handle === 'I1'), `${kind}: grounding rejected it`);
  }
});

test('items within 300 characters are checked exactly as before', async () => {
  const items = [
    { handle: 'I1', text: 'I1 was approved for the received quantity only. It was paid yesterday.' },
    { handle: 'P1', text: 'P1 is a cheque for $999.00.' },
    { handle: 'I1', text: 'I1 is like INV-4040.' },
    SHORT,
  ];
  const r = await run({ summary: SUMMARY, items });
  const direct = groundExplanation(
    { summary: SUMMARY, items },
    { records: facts.grounding.records, numbers: groundingNumbers(facts.grounding.views, facts.extra), refs: groundingRefs(facts.grounding.views) },
  );
  assert.deepEqual(r.items, direct.items, 'the same result as grounding alone');
  assert.deepEqual(r.items, [{ handle: 'I1', text: 'I1 was approved for the received quantity only.' }, SHORT]);
  assert.deepEqual([r.call.itemsTrimmed, r.call.itemsDropped, r.call.itemReasons], [0, 0, []]);
  assert.deepEqual(fitItems(items).items, items, 'nothing changed by fitItems');
});

test('the counts and reasons are recorded on the call, which the audit log keeps', async () => {
  const r = await run({
    summary: SUMMARY,
    items: [{ handle: 'I1', text: item(308, SAFE) }, { handle: 'P1', text: item(310, 'Contact the supplier') }, { handle: 'I1', text: `${'x'.repeat(301)}` }, SHORT],
  });
  assert.equal(r.source, 'model');
  assert.deepEqual(
    { trimmed: r.call.itemsTrimmed, dropped: r.call.itemsDropped, reasons: r.call.itemReasons },
    { trimmed: 1, dropped: 2, reasons: ['too_long_trimmed', 'too_long_dropped_has_facts', 'too_long_no_boundary'] },
  );
  const detail = JSON.parse(JSON.stringify(r.call)); // what ask.js writes as the model_called entry
  assert.deepEqual(Object.keys(detail).sort(), [
    'completionTokens',
    'itemReasons',
    'itemsDropped',
    'itemsRejected',
    'itemsTrimmed',
    'model',
    'ms',
    'outcome',
    'promptTokens',
    'purpose',
    'rejectReasons',
  ]);
  assert.ok(!JSON.stringify(detail).includes('Pallets'), 'no text from the answer in the record');
});
