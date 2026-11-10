// The Ask panel's answer (src/askAnswer.js), rendered to HTML in Node: an
// answer, a clarification and a fallback answer, as the server sends them
// (server/src/orchestrator/ask.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { AskAnswer, answerParts, explanationHeading, stateLines, amount } from '../src/askAnswer.js';

const render = (response, props = {}) => ReactDOMServer.renderToStaticMarkup(React.createElement(AskAnswer, { response, ...props }));

const INVOICE = {
  handle: 'I1',
  kind: 'invoice',
  id: '6ae72014e574214a187cd9e8',
  invoiceNumber: 'HOS-10517',
  supplier: 'Harbour Office Supplies Pty Ltd',
  total: 2890.36,
  currency: 'AUD',
  status: 'on_hold',
  due: { date: '2026-10-26', state: 'overdue', daysUntil: -6 },
  failedChecks: ['price_match'],
};
const ANSWERED = {
  requestId: 'q_x',
  threadId: 't_x',
  status: 'answered',
  intent: 'explain_invoice_status',
  facts: [
    INVOICE,
    {
      handle: 'P1',
      kind: 'payment',
      id: 'p1',
      invoiceId: '6ae72014e574214a187cd9a4',
      invoiceNumber: 'SCP-7731',
      supplier: 'Southern Cross Pallets',
      amount: 727.1,
      currency: 'AUD',
      status: 'queued',
      method: 'Cheque',
      scheduledFor: '2026-10-03',
    },
  ],
  history: [{ at: '2026-11-01T11:18:44.429Z', action: 'hold', summary: 'A person put it on hold.' }],
  explanation: {
    source: 'model',
    label: 'AI explanation',
    summary: 'HOS-10517 is on hold while the price is checked.',
    items: [{ handle: 'I1', text: 'The chair price is above the PO price.' }],
    fallback: null,
    note: null,
  },
  notes: ['The simulated bank balance needs the payer, approver or admin role.'],
  failures: [],
};

test('an answer: facts from the response with links to the invoice screen, and the "AI explanation"', () => {
  const html = render(ANSWERED);
  assert.match(html, /HOS-10517/);
  assert.match(html, /On Hold/, 'the status label');
  assert.match(html, /AUD 2,890\.36/, 'the amount from the record, with its currency code');
  assert.match(html, /Overdue since 2026-10-26/);
  assert.match(html, /data-invoice-id="6ae72014e574214a187cd9e8"/, 'the invoice links to its screen');
  assert.match(html, /data-invoice-id="6ae72014e574214a187cd9a4"/, 'a payment links to its invoice');
  assert.match(html, /<h3 class="ask-label">AI explanation<\/h3>/);
  assert.match(html, /HOS-10517 is on hold while the price is checked\./);
  assert.match(html, /A person put it on hold\./);
  assert.match(html, /needs the payer, approver or admin role/);
  assert.ok(!/From records/.test(html));

  // Clicking a reference opens the invoice.
  const opened = [];
  const tree = AskAnswer({ response: ANSWERED, onOpenInvoice: (id) => opened.push(id) });
  const find = (node) => (node && typeof node === 'object' ? (node.props?.['data-invoice-id'] ? [node] : [].concat(node.props?.children || []).flatMap(find)) : []);
  find(tree)[0].props.onClick();
  assert.deepEqual(opened, ['6ae72014e574214a187cd9e8']);
});

test('a clarification: the question and each option as a button', () => {
  const response = {
    status: 'needs_clarification',
    threadId: 't_x',
    message: 'Which invoice do you mean? These are on hold:',
    clarification: {
      question: 'Which invoice do you mean? These are on hold:',
      options: [
        { optionId: 'o_aaaaaaaaaaaaaaaaaaaaaa', label: 'HOS-10517, Harbour Office Supplies Pty Ltd' },
        { optionId: 'o_bbbbbbbbbbbbbbbbbbbbbb', label: 'CPS-0388, Coastal Print & Sign Pty Ltd' },
      ],
    },
    fallback: null,
  };
  const html = render(response);
  assert.match(html, /Which invoice do you mean\?/);
  assert.equal((html.match(/<button/g) || []).length, 2);
  assert.match(html, /HOS-10517, Harbour Office Supplies Pty Ltd/);
  assert.match(html, /Coastal Print &amp; Sign/, 'text is escaped');
  assert.ok(!/AI was not available/.test(html));

  const chosen = [];
  const tree = AskAnswer({ response, onChoose: (id) => chosen.push(id) });
  const buttons = [].concat(tree.props.children).filter(Boolean).at(-1).props.children;
  buttons[1].props.onClick();
  assert.deepEqual(chosen, ['o_bbbbbbbbbbbbbbbbbbbbbb']);

  // The menu when the AI could not work out the question.
  const menu = render({
    ...response,
    fallback: 'rate_limit',
    clarification: { question: 'Choose one of these:', options: [{ optionId: 'o_cccccccccccccccccccccc', label: 'Unpaid invoices' }] },
  });
  assert.match(menu, /The AI was not available to work out the question/);
});

test('a fallback answer: "From records", with a note that the AI was unavailable', () => {
  const html = render({
    ...ANSWERED,
    explanation: {
      source: 'template',
      label: 'From records',
      summary: 'HOS-10517 from Harbour Office Supplies Pty Ltd is on hold, overdue since 2026-10-26.',
      items: [{ handle: 'I1', text: 'Why: The chair price is above the PO price.' }],
      fallback: 'rate_limit',
      note: 'The AI explanation was not available just now, so this answer comes from the records.',
    },
  });
  assert.match(html, /<h3 class="ask-label">From records<\/h3>/);
  assert.match(html, /The AI explanation was not available just now/);
  assert.ok(!/AI explanation<\/h3>/.test(html));

  // A list answer is "From records" by design: no note.
  const list = render({ ...ANSWERED, explanation: { source: 'template', label: 'From records', summary: '1 invoice is on hold.', items: [], fallback: null, note: null } });
  assert.match(list, /From records/);
  assert.ok(!/not available/.test(list));
});

test('other replies and the parts the panel shows', () => {
  assert.match(render({ status: 'not_permitted', message: 'This needs the admin role.' }), /This needs the admin role\./);
  assert.match(render({ status: 'not_found', message: 'Nothing matching "X-1" was found. Check the number.' }), /Nothing matching &quot;X-1&quot; was found/);
  assert.equal(render(null), '');
  const partial = answerParts({ ...ANSWERED, status: 'partial', failures: [{ step: 'invoice', code: 'not_found', text: 'A record this answer needed no longer exists.' }] });
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.failures, ['A record this answer needed no longer exists.']);
  assert.equal(explanationHeading({ source: 'model' }), 'AI explanation');
  assert.equal(explanationHeading({ source: 'template' }), 'From records');
  // Outside text is shown as text, never as markup.
  assert.ok(!/<script>/.test(render({ ...ANSWERED, facts: [{ ...INVOICE, supplier: '<script>alert(1)</script>' }] })));
});

// The state the server worked out (server/src/orchestrator/stateReason.js), as an invoice fact carries it.
const SCP_STATE = {
  status: 'payment_pending',
  statusLabel: 'Payment Pending',
  events: [{ date: '2026-09-30', what: 'A person approved the received quantity only' }],
  openChecks: [],
  overriddenChecks: [{ id: 'quantity_match', by: 'approver', on: '2026-09-30' }],
  payment: { state: 'queued', method: 'Cheque', date: '2026-10-03', amount: 'AUD 727.10', manual: true },
  overdueCause: 'The Cheque payment scheduled for 2026-10-03 is still queued; the due date 2026-10-18 has passed.',
  blockers: ['No payer has recorded the cheque payment yet.'],
  recommendedNextSteps: [
    { action: 'record_payment', role: 'payer', text: 'If the cheque has been sent, record the payment on the invoice screen.', yours: false },
    { action: 'check_payment', role: 'payer', text: 'If the cheque has not been sent, send it or reschedule the payment.', yours: false },
  ],
  premiseCorrection: null,
};
const SCP_FACT = {
  handle: 'I1',
  kind: 'invoice',
  id: '6ae72014e574214a187cd9a4',
  invoiceNumber: 'SCP-7731',
  supplier: 'Southern Cross Pallets Pty Ltd',
  total: 811.8,
  currency: 'AUD',
  status: 'payment_pending',
  due: { date: '2026-10-18', state: 'overdue', daysUntil: -19 },
  failedChecks: ['quantity_match'],
  state: SCP_STATE,
};
const withState = (fact, explanation) => ({ ...ANSWERED, facts: [fact], history: [], notes: [], explanation });
const AI = { source: 'model', label: 'AI explanation', summary: 'SCP-7731 waits for its cheque.', items: [], fallback: null, note: null };
const TEMPLATE = { source: 'template', label: 'From records', summary: 'SCP-7731 is payment pending.', items: [], fallback: 'ungrounded', note: 'From the records.' };
const stateHtml = (html) => html.match(/<div class="ask-state">.*?<\/ul><\/div><\/div>/)?.[0];

test('every amount in the facts block carries its currency code', () => {
  assert.equal(amount(727.1, 'AUD'), 'AUD 727.10');
  assert.equal(amount(18953), 'AUD 18,953.00');
  assert.equal(amount(5, 'NZD'), 'NZD 5.00');
  assert.equal(amount(null), '—');
  const html = render(ANSWERED);
  assert.match(html, /AUD 727\.10/, 'the payment amount');
  assert.ok(!/\$\d/.test(html), 'no bare dollar sign');
  const supplier = render({ ...ANSWERED, facts: [{ handle: 'S1', kind: 'supplier', id: '1', name: 'Bluegum IT', state: 'verified', openCount: 2, openTotal: 18953 }] });
  assert.match(supplier, /AUD 18,953\.00/);
  const dated = render({
    ...ANSWERED,
    facts: [
      { handle: 'S1', kind: 'supplier', id: '1', name: 'Bluegum IT', state: 'verified', openCount: 2, openTotal: 18953, overdue: 2, oldestDue: '2026-10-25', pendingChange: true },
    ],
  });
  assert.match(dated, /2 unpaid, 2 overdue/);
  assert.match(dated, /Oldest due 2026-10-25; Bank details change pending/, 'the oldest due date is shown in the facts block');
});

test("the state block: Status, Why and Next steps with the role, from the response's state", () => {
  const html = render(withState(SCP_FACT, AI));
  assert.match(html, /<strong>Status: <\/strong>Payment Pending; payment queued \(Cheque, 2026-10-03, AUD 727\.10\)/);
  assert.match(
    html,
    /<strong>Why: <\/strong>The Cheque payment scheduled for 2026-10-03 is still queued; the due date 2026-10-18 has passed\. No payer has recorded the cheque payment yet\./,
  );
  assert.match(html, /<strong>Next steps:<\/strong><ul><li>If the cheque has been sent, record the payment on the invoice screen\. <span class="ask-role">\(Payer\)<\/span><\/li>/);
  assert.ok(!/ask-premise/.test(html), 'no premise correction when the question assumed nothing');
  // The steps that are the viewer's own are marked.
  const mine = stateLines({ ...SCP_FACT, state: { ...SCP_STATE, recommendedNextSteps: [{ ...SCP_STATE.recommendedNextSteps[0], yours: true }] } });
  assert.deepEqual(mine.nextSteps, [{ text: 'If the cheque has been sent, record the payment on the invoice screen.', role: 'Payer', yours: true }]);
  // No state (a list answer): no block.
  assert.ok(!/ask-state/.test(render(ANSWERED)));
});

test('the premise correction comes first, before the facts', () => {
  const hos = {
    ...INVOICE,
    status: 'needs_review',
    state: {
      ...SCP_STATE,
      status: 'needs_review',
      statusLabel: 'Needs Review',
      payment: { state: 'none' },
      overdueCause: 'It still needs a decision (Needs Review); the due date 2026-10-26 has passed.',
      blockers: ["3 failed checks need a person's decision: reader_confidence, price_match, match_score."],
      recommendedNextSteps: [
        { action: 'correct', role: 'reviewer', text: 'Correct any fields read wrongly.', yours: false },
        { action: 'decide', role: 'approver', text: 'Then approve or reject it.', yours: true },
      ],
      premiseCorrection: 'HOS-10517 is not on hold; it is in Needs Review.',
    },
  };
  const html = render(withState(hos, AI));
  const premise = html.indexOf('<p class="ask-premise" role="note">HOS-10517 is not on hold; it is in Needs Review.</p>');
  assert.ok(premise >= 0);
  assert.ok(premise < html.indexOf('ask-facts') && premise < html.indexOf('ask-explanation'), 'at the top');
  assert.match(html, /Needs Review; no payment/);
  assert.match(html, /Correct any fields read wrongly\. <span class="ask-role">\(Reviewer\)<\/span>.*Then approve or reject it\. <span class="ask-role">\(Approver, you\)<\/span>/);
});

test('the state block reads the same whether the explanation came from the AI or the records', () => {
  const ai = render(withState(SCP_FACT, AI));
  const records = render(withState(SCP_FACT, TEMPLATE));
  assert.ok(stateHtml(ai), 'the AI answer has the block');
  assert.equal(stateHtml(ai), stateHtml(records));
  assert.deepEqual(answerParts(withState(SCP_FACT, AI)).states, answerParts(withState(SCP_FACT, TEMPLATE)).states);
  // Built from the state, never from the explanation's text.
  const odd = render(withState(SCP_FACT, { ...AI, summary: 'It is on hold and paid.' }));
  assert.equal(stateHtml(odd), stateHtml(ai));
});
