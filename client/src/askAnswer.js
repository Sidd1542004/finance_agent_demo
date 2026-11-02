// The Ask panel's answer (views/Ask.jsx): one response from POST
// /api/orchestrator/ask, rendered from its structured fields. Written with
// createElement instead of JSX so the client tests can render it in Node
// (test/askAnswer.test.js).
//
//   answered / partial     the facts (refs link to the invoice screen,
//                          statuses and amounts from the records) and the
//                          explanation: "AI explanation" or "From records",
//                          with a note when the AI was not available
//   needs_clarification    the question back, with each option as a button
//   not_found / not_permitted   the message

import React from 'react';
import { money, STATUS, PAYMENT_STATUS, BANK_STATUS } from './format.js';

// React is a CommonJS package: its default export works in Node and in Vite alike.
const h = React.createElement;

const statusLabel = (kind, status) => (kind === 'payment' ? PAYMENT_STATUS : kind === 'bank_line' ? BANK_STATUS : STATUS)[status]?.label || String(status || '').replace(/_/g, ' ');

// The person sees where an answer came from, and why it came from the records when the AI was unavailable.
export function explanationHeading(explanation) {
  if (!explanation) return null;
  return explanation.source === 'model' ? 'AI explanation' : 'From records';
}

/** The parts of a response the panel shows, in order (for the component and the tests). */
export function answerParts(response) {
  if (!response) return { kind: 'empty' };
  if (response.status === 'needs_clarification')
    return {
      kind: 'clarify',
      question: response.clarification?.question || response.message,
      options: response.clarification?.options || [],
      unavailable: Boolean(response.fallback),
    };
  if (response.status === 'not_found' || response.status === 'not_permitted') return { kind: 'message', text: response.message };
  const e = response.explanation || {};
  return {
    kind: 'answer',
    partial: response.status === 'partial',
    facts: response.facts || [],
    history: response.history || [],
    heading: explanationHeading(e),
    summary: e.summary || '',
    items: e.items || [],
    note: e.note || null,
    notes: response.notes || [],
    failures: (response.failures || []).map((f) => f.text),
  };
}

function factRow(f, onOpenInvoice) {
  const ref =
    f.kind === 'invoice' || (f.kind === 'payment' && f.invoiceId)
      ? h(
          'button',
          {
            type: 'button',
            className: 'link ask-ref',
            onClick: () => onOpenInvoice(f.kind === 'invoice' ? f.id : f.invoiceId),
            'data-invoice-id': f.kind === 'invoice' ? f.id : f.invoiceId,
          },
          f.invoiceNumber || 'Invoice',
        )
      : h('span', { className: 'ask-ref' }, f.name || f.invoiceNumber || f.provider || '');
  const cells = {
    invoice: [f.supplier, statusLabel('invoice', f.status), money(f.total, f.currency), f.due?.date ? `${f.due.state === 'overdue' ? 'Overdue since' : 'Due'} ${f.due.date}` : ''],
    payment: [f.supplier, statusLabel('payment', f.status), money(f.amount, f.currency), f.scheduledFor ? `Scheduled ${f.scheduledFor}` : f.method || ''],
    supplier: [
      f.state,
      f.openCount !== undefined ? `${f.openCount} unpaid` : '',
      f.openTotal !== undefined ? money(f.openTotal) : '',
      f.pendingChange ? 'Bank details change pending' : '',
    ],
    bank_line: [f.date, statusLabel('bank_line', f.status), money(f.amount), f.description],
    mailbox: [f.state, f.enabled ? 'Polling on' : 'Polling off', f.lastPollAt ? `Last checked ${f.lastPollAt.slice(0, 16).replace('T', ' ')} UTC` : '', ''],
    account: ['Simulated account', 'Available', money(f.available, f.currency), ''],
  }[f.kind];
  if (!cells) return null;
  return h(
    'tr',
    { key: f.handle || `${f.kind}-${f.id || f.provider}` },
    h('td', null, f.handle ? h('span', { className: 'ask-handle' }, f.handle) : null),
    h('td', null, ref),
    ...cells.map((c, i) => h('td', { key: i }, c || '')),
  );
}

/** The answer. onChoose(optionId) for a clarification button; onOpenInvoice(id) for a reference. */
export function AskAnswer({ response, onChoose = () => {}, onOpenInvoice = () => {}, disabled = false }) {
  const p = answerParts(response);
  if (p.kind === 'empty') return null;
  if (p.kind === 'message') return h('div', { className: 'ask-answer', role: 'status' }, h('p', null, p.text));
  if (p.kind === 'clarify') {
    return h(
      'div',
      { className: 'ask-answer', role: 'status' },
      h('p', null, p.question),
      p.unavailable ? h('p', { className: 'hint ask-note' }, 'The AI was not available to work out the question, so here are the questions it can answer.') : null,
      h(
        'div',
        { className: 'ask-options' },
        p.options.map((o) => h('button', { key: o.optionId, type: 'button', className: 'btn', disabled, onClick: () => onChoose(o.optionId) }, o.label)),
      ),
    );
  }
  const rows = p.facts.map((f) => factRow(f, onOpenInvoice)).filter(Boolean);
  return h(
    'div',
    { className: 'ask-answer' },
    p.failures.length
      ? h(
          'div',
          { className: 'ask-failures', role: 'alert' },
          p.failures.map((t, i) => h('p', { key: i }, t)),
        )
      : null,
    rows.length ? h('table', { className: 'ask-facts' }, h('tbody', null, rows)) : null,
    p.history.length
      ? h(
          'ul',
          { className: 'ask-history' },
          p.history.map((e, i) => h('li', { key: i }, `${(e.at || '').slice(0, 10)}: ${e.summary}`)),
        )
      : null,
    h(
      'section',
      { className: `ask-explanation ask-${p.heading === 'AI explanation' ? 'ai' : 'records'}` },
      h('h3', { className: 'ask-label' }, p.heading),
      p.note ? h('p', { className: 'hint ask-note' }, p.note) : null,
      p.summary ? h('p', null, p.summary) : null,
      p.items.length
        ? h(
            'ul',
            null,
            p.items.map((it, i) => h('li', { key: i }, it.handle ? h('span', { className: 'ask-handle' }, it.handle) : null, ' ', it.text)),
          )
        : null,
    ),
    p.notes.length
      ? h(
          'div',
          { className: 'hint' },
          p.notes.map((t, i) => h('p', { key: i }, t)),
        )
      : null,
  );
}
