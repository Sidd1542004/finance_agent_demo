// The Ask panel's answer (src/askAnswer.js), rendered to HTML in Node: an
// answer, a clarification and a fallback answer, as the server sends them
// (server/src/orchestrator/ask.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { AskAnswer, answerParts, explanationHeading } from '../src/askAnswer.js';

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
  assert.match(html, /\$2,890\.36/, 'the amount from the record');
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
