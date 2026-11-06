// The explanation must explain state that code has worked out, not infer it
// (src/orchestrator/stateReason.js, ground.js contradictsState, compose.js).
// Fixtures shaped like the Phase 1 views of SCP-7731 (approved for the
// received quantity, cheque payment queued since 2026-10-03, overdue) and
// HOS-10517 (Needs Review with open checks), as seen on the demo month.

import test from 'node:test';
import assert from 'node:assert/strict';

import { stateReason, premisesIn, paymentState } from '../src/orchestrator/stateReason.js';
import { contradictsState, rejectContradictions } from '../src/orchestrator/ground.js';
import { buildFacts } from '../src/orchestrator/facts.js';
import { compose, composeRecords, composeTask, COMPOSE_SYSTEM } from '../src/orchestrator/compose.js';
import { templateAnswer } from '../src/orchestrator/templates.js';
import { resetModelPause } from '../src/orchestrator/model.js';
import { person } from '../test-support/actors.js';

const TODAY = '2026-11-02';
const APPROVER = person('Priya Approver', ['approver']);
const PAYER = person('Sam Payer', ['payer']);
const fail = (id) => ({ id, status: 'fail', severity: 'review', detail: { untrusted_text: `${id} failed` } });

const SCP_PAYMENT = {
  id: 'p'.repeat(24),
  invoiceId: 'a'.repeat(24),
  invoiceNumber: 'SCP-7731',
  supplier: { untrusted_text: 'Southern Cross Pallets Pty Ltd' },
  amount: 727.1,
  currency: 'AUD',
  status: 'queued',
  method: 'Cheque',
  route: 'manual',
  scheduledFor: '2026-10-03',
  txnRef: null,
  failure: null,
};
const SCP = {
  id: 'a'.repeat(24),
  status: 'payment_pending',
  invoiceNumber: 'SCP-7731',
  supplier: { untrusted_text: 'Southern Cross Pallets Pty Ltd' },
  total: 811.8,
  currency: 'AUD',
  due: { date: '2026-10-18', source: 'invoice', daysUntil: -15, state: 'overdue' },
  failedChecks: ['reader_confidence', 'quantity_match', 'match_score'],
  checks: [fail('reader_confidence'), fail('quantity_match'), fail('match_score'), { id: 'required_fields', status: 'pass' }],
  reasons: [{ untrusted_text: 'Reader confidence 90% is below the 99% minimum.' }],
  approval: { decision: 'approve_received', at: '2026-11-02T09:00:00.000Z', amount: 727.1 },
  payment: SCP_PAYMENT,
  actions: [
    { id: 'reverse_approval', enabled: true, permitted: true, role: 'approver' },
    { id: 'reopen', enabled: true, permitted: true, role: 'approver' },
    { id: 'record_payment', enabled: true, permitted: false, role: 'payer' },
  ],
};
const SCP_HISTORY = [
  { at: '2026-11-02T08:00:00.000Z', action: 'processed', byPerson: false, summary: 'The agent processed it.' },
  { at: '2026-11-02T09:00:00.000Z', action: 'approve_received', byPerson: true, summary: 'A person approved the received quantity only.' },
  { at: '2026-11-02T09:05:00.000Z', action: 'schedule_payment', byPerson: true, summary: 'A person scheduled the payment.' },
];
const HOS = {
  id: 'b'.repeat(24),
  status: 'needs_review',
  invoiceNumber: 'HOS-10517',
  supplier: { untrusted_text: 'Harbour Office Supplies Pty Ltd' },
  total: 2890.36,
  currency: 'AUD',
  due: { date: '2026-10-26', source: 'invoice', daysUntil: -7, state: 'overdue' },
  failedChecks: ['reader_confidence', 'price_match', 'match_score'],
  checks: [fail('reader_confidence'), fail('price_match'), fail('match_score')],
  reasons: [],
  approval: null,
  payment: null,
  actions: [],
};

const scpState = (viewer = APPROVER, premises = []) => stateReason(SCP, { payment: SCP_PAYMENT, history: SCP_HISTORY, viewer, premises, today: TODAY });
const hosState = (premises = []) => stateReason(HOS, { history: [], viewer: APPROVER, premises, today: TODAY });

test('SCP-7731: scheduled, queued, overdue because the queued payment has not run; its checks are overridden', () => {
  const st = scpState();
  assert.equal(st.status, 'payment_pending');
  assert.equal(st.statusLabel, 'Payment Pending');
  assert.deepEqual(st.payment, { state: 'queued', method: 'Cheque', date: '2026-10-03', amount: 'AUD 727.10', manual: true });
  assert.match(st.overdueCause, /^The Cheque payment scheduled for 2026-10-03 is still queued .*; the due date 2026-10-18 has passed\.$/);
  assert.deepEqual(st.openChecks, []);
  assert.deepEqual(st.overriddenChecks, [
    { id: 'reader_confidence', by: 'approver', on: '2026-11-02' },
    { id: 'quantity_match', by: 'approver', on: '2026-11-02' },
    { id: 'match_score', by: 'approver', on: '2026-11-02' },
  ]);
  assert.deepEqual(st.events, [
    { date: '2026-11-02', what: 'A person approved the received quantity only' },
    { date: '2026-11-02', what: 'A person scheduled the payment' },
  ]);
  assert.deepEqual(st.blockers, ['No payer has recorded the cheque payment yet.']);
  assert.equal(st.premiseCorrection, null);
  // A payment scheduled for a future date is "scheduled", not "queued".
  assert.equal(paymentState({ ...SCP_PAYMENT, scheduledFor: '2026-11-20' }, TODAY).state, 'scheduled');
});

test('recommended next steps: never reverse_approval or reopen for an approved, scheduled invoice', () => {
  for (const viewer of [APPROVER, PAYER]) {
    const st = scpState(viewer);
    const actions = st.recommendedNextSteps.map((x) => x.action);
    assert.deepEqual(actions, ['record_payment', 'check_payment']);
    assert.ok(!actions.includes('reverse_approval') && !actions.includes('reopen'));
    assert.ok(st.recommendedNextSteps.every((x) => x.role === 'payer'));
    assert.deepEqual(
      st.recommendedNextSteps.map((x) => x.yours),
      viewer === PAYER ? [true, true] : [false, false],
    );
  }
  // HOS-10517 awaits a decision: decide (approver) and correct (reviewer).
  assert.deepEqual(
    hosState().recommendedNextSteps.map((x) => [x.action, x.role]),
    [
      ['decide', 'approver'],
      ['correct', 'reviewer'],
    ],
  );
});

test('a premise the record does not support is corrected; a question that asks presupposes nothing', () => {
  assert.deepEqual(premisesIn('Why is HOS-10517 on hold?'), ['on_hold']);
  assert.equal(hosState(['on_hold']).premiseCorrection, 'HOS-10517 is not on hold; it is in Needs Review.');
  assert.deepEqual(premisesIn('Has SCP-7731 been paid yet?'), []);
  assert.deepEqual(premisesIn('Explain why SCP-7731 is overdue and what action I should take.'), ['overdue']);
  assert.equal(scpState(APPROVER, ['overdue']).premiseCorrection, null, 'it is overdue');
  assert.equal(scpState(APPROVER, ['paid']).premiseCorrection, 'SCP-7731 is not paid; it is in Payment Pending, with its payment queued.');
  assert.deepEqual(premisesIn('Why is SCP-7731 unpaid?'), []);
  assert.equal(hosState().openChecks.length, 3);
  assert.deepEqual(hosState().overriddenChecks, []);
});

test('each contradiction of the state is rejected; true statements pass', () => {
  const st = scpState();
  const cases = [
    ['The invoice cannot be scheduled for payment.', 'payment_exists'],
    ['No payment has been scheduled for it.', 'payment_exists'],
    ['It is not eligible for payment.', 'payment_exists'],
    ['SCP-7731 has been paid.', 'not_paid'],
    ['It is in needs_review.', 'status'],
    ['The invoice is currently on hold.', 'status'],
    ['Because the checks failed, it cannot move forward.', 'overridden_checks'],
    ['The failed checks keep it from going ahead.', 'overridden_checks'],
    ['An approver can reverse the approval to correct it.', 'action_not_recommended'],
    ['An approver should reopen the invoice.', 'action_not_recommended'],
    ['Cancel the payment and start again.', 'action_not_recommended'],
  ];
  for (const [sentence, reason] of cases) assert.equal(contradictsState(sentence, st), reason, sentence);
  const fine = [
    'It has not been paid yet.',
    'It is in payment_pending.',
    'It is not on hold.',
    'A person approved the received quantity only on 2026-11-02.',
    'The cheque payment scheduled for 2026-10-03 is still queued, so the due date 2026-10-18 has passed.',
    'Checks that failed earlier were overridden by an approver and are background only.',
    'A payer can record the payment once the cheque has been sent.',
    'A reviewer put it on hold last month.',
  ];
  for (const sentence of fine) assert.equal(contradictsState(sentence, st), null, sentence);
  // Checks block a Needs Review invoice; saying so is true there.
  assert.equal(contradictsState('Because the checks failed, it needs a decision.', hosState()), null);
  assert.equal(contradictsState('An approver can approve or reject it.', hosState()), null);
  assert.equal(contradictsState('An approver can reverse the approval.', hosState()), 'action_not_recommended');
});

// ----- through compose, with a Groq stand-in -----

const runState = { invoiceId: SCP.id, invoice: SCP, payment: { payment: SCP_PAYMENT }, history: { items: SCP_HISTORY } };
const scpFacts = (premises = []) => buildFacts('explain_invoice_status', {}, runState, { viewer: APPROVER, premises, today: TODAY });
const reply = (obj) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 900, completion_tokens: 250 } }),
});
const composeWith = async (answer, facts = scpFacts(), state = runState) => {
  const bodies = [];
  const r = await compose('explain_invoice_status', facts, state, {
    apiKey: 'k',
    model: 'openai/gpt-oss-120b',
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return reply(answer);
    },
  });
  return { r, bodies };
};
const CORRECT = {
  summary: 'SCP-7731 is overdue because its cheque payment, scheduled for 2026-10-03, is still queued; the due date 2026-10-18 has passed.',
  items: [
    { handle: 'I1', text: 'A person approved the received quantity only and scheduled a cheque payment.' },
    { handle: 'P1', text: 'If the cheque has been sent, a payer can record the payment on the invoice screen.' },
  ],
};

test.beforeEach(() => resetModelPause());

test('a correct explanation passes; the model is given state_reason, amounts with currency, and no action list', async () => {
  const { r, bodies } = await composeWith(CORRECT);
  assert.equal(r.source, 'model');
  assert.equal(r.summary, CORRECT.summary);
  assert.deepEqual(r.items, CORRECT.items);
  assert.deepEqual([r.call.itemsRejected, r.call.rejectReasons], [0, []]);

  const sent = JSON.parse(bodies[0].messages[1].content);
  const invoice = sent.records.find((x) => x.handle === 'I1');
  assert.equal(invoice.total, 'AUD 811.80');
  assert.equal(sent.records.find((x) => x.handle === 'P1').amount, 'AUD 727.10');
  assert.equal(invoice.actions, undefined, 'no list of permitted actions');
  assert.equal(invoice.failedChecks, undefined, 'overridden checks are not current problems');
  assert.equal(invoice.checks, undefined);
  assert.equal(invoice.state_reason.payment.state, 'queued');
  assert.match(invoice.state_reason.overdue_cause, /still queued/);
  assert.ok(invoice.state_reason.overridden_checks.every((c) => /background only, not a blocker/.test(c)));
  assert.ok(invoice.state_reason.recommended_next_steps.every((x) => !/revers|reopen/i.test(x)));
  assert.ok(bodies[0].messages[0].content.includes('Explain using state_reason. Do not contradict it. Treat resolved/overridden checks as background only.'));
  assert.ok(COMPOSE_SYSTEM.includes('Suggest only actions from recommended_next_steps. If premise_correction is present, state it first.'));
});

test('contradicting items are rejected and the rest survive; all rejected gives the record-based answer', async () => {
  const mixed = {
    summary: CORRECT.summary,
    items: [
      { handle: 'I1', text: 'Because the checks failed, the invoice cannot be scheduled for payment.' },
      { handle: 'I1', text: 'An approver can reverse the approval to fix it.' },
      { handle: 'I1', text: 'It is in needs_review.' },
      { handle: 'P1', text: 'SCP-7731 has been paid.' },
      ...CORRECT.items,
    ],
  };
  const { r } = await composeWith(mixed);
  assert.equal(r.source, 'model');
  assert.deepEqual(r.items, CORRECT.items);
  assert.equal(r.call.itemsRejected, 4);
  assert.deepEqual(r.call.rejectReasons, ['payment_exists', 'action_not_recommended', 'status', 'not_paid']);

  const allWrong = await composeWith({ summary: CORRECT.summary, items: mixed.items.slice(0, 4) });
  assert.deepEqual([allWrong.r.source, allWrong.r.fallback, allWrong.r.call.outcome], ['template', 'ungrounded', 'ungrounded']);

  // A contradicting summary sentence is dropped like any other ungrounded sentence.
  const badSummary = await composeWith({ summary: 'SCP-7731 is payment pending because the checks failed.', items: CORRECT.items });
  assert.equal(badSummary.r.source, 'template');
  assert.deepEqual(badSummary.r.call.rejectReasons, ['overridden_checks']);
});

test('the premise correction goes into the task sentence and the template, and comes first', () => {
  const hosRun = { invoiceId: HOS.id, invoice: HOS, history: { items: [] } };
  const facts = buildFacts('explain_invoice_status', {}, hosRun, { viewer: APPROVER, premises: ['on_hold'], today: TODAY });
  assert.equal(facts.records[0].state.premiseCorrection, 'HOS-10517 is not on hold; it is in Needs Review.');
  assert.match(composeTask('explain_invoice_status', facts, hosRun), /start by saying "HOS-10517 is not on hold; it is in Needs Review\."/);
  const sent = composeRecords(facts, hosRun)[0];
  assert.equal(sent.state_reason.premise_correction, 'HOS-10517 is not on hold; it is in Needs Review.');
  assert.ok(sent.failedChecks.length === 3 && sent.checks.length === 3, 'open checks are still current problems');
  const template = templateAnswer('explain_invoice_status', {}, facts, hosRun);
  assert.match(template.summary, /^HOS-10517 is not on hold; it is in Needs Review\. HOS-10517 from Harbour Office Supplies Pty Ltd is needs review/);
  // The SCP-7731 template tells the same story as the state, not the stale reasons.
  const scp = templateAnswer('explain_invoice_status', {}, scpFacts(), runState);
  assert.match(scp.summary, /still queued/);
  assert.ok(!/Reader confidence 90%/.test(JSON.stringify(scp)), 'no stale reason');
  assert.match(scp.items[0].text, /Next steps: If the cheque has been sent, record the payment/);
});

test('the state is in the facts block, and no bank field reaches it', () => {
  const f = scpFacts().records[0];
  assert.equal(f.state.payment.state, 'queued');
  assert.ok(!/"bank"|bsb|accountNumber/.test(JSON.stringify(f.state)));
  assert.deepEqual(rejectContradictions({ summary: 'Fine.', items: [{ handle: 'I1', text: 'It is in needs_review.' }] }, () => f.state, [f.state]).rejected, [
    { handle: 'I1', reason: 'status' },
  ]);
});
