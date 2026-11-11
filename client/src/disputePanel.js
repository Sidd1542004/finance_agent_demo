// The invoice screen's query to the supplier about a variance (quantity, price
// or GST). Written with createElement instead of JSX so the client tests can
// render it in Node (test/disputePanel.test.js). The server works out the facts
// and checks every change again (server/src/services/supplierDisputes.js).
//
//   no query yet      "Draft query to supplier" (reviewer, approver, admin)
//   draft             the facts table, an editable subject and email, the
//                     "AI-drafted" or "From template" label; Send (the main
//                     action) and Discard
//   sent              "Query sent to supplier on <date> (...)", the email as
//                     sent (read-only), and "Mark resolved"
//   resolved          what came back, and the note
// Payers see everything and change nothing.

import React from 'react';
import { hasRole, when, day } from './format.js';

const h = React.createElement;

export const VARIANCE_CHECKS = ['quantity_match', 'price_match', 'tax_charged'];
export const RESOLUTIONS = { credit_note_received: 'Credit note received', corrected_invoice_received: 'Corrected invoice received' };
const FALLBACK_REASON = {
  rate_limit: 'the AI was busy',
  timeout: 'the AI took too long',
  bad_output: 'the AI’s answer could not be read',
  not_configured: 'the AI is not set up',
  ungrounded_number: 'the AI used a number that is not in the facts',
  unknown_reference: 'the AI named a document that is not in the facts',
  unknown_email: 'the AI added an email address',
  link: 'the AI added a link',
  bank_details: 'the AI mentioned bank details',
  payment: 'the AI mentioned payment',
  accusation: 'the AI’s wording was not neutral',
  unsupported_comparison: 'the AI made a comparison the facts do not support',
};

/** Did a variance check fail on the invoice? The panel shows only then. */
export const hasVariance = (invoice) => (invoice?.checks || []).some((c) => c.status === 'fail' && VARIANCE_CHECKS.includes(c.id));

/** May this person draft, edit, send, discard and resolve? (The server checks again.) */
export const canWrite = (user) => hasRole(user, 'reviewer', 'approver', 'admin');

/** "AI-drafted", or "From template" with why. */
export function draftLabel(dispute) {
  if (dispute.draft.aiDrafted) return 'AI-drafted';
  const why = FALLBACK_REASON[dispute.draft.fallbackReason];
  return why ? `From template (${why})` : 'From template';
}

/** "Query sent to supplier on 6 Nov 2026, 10:30 am (credit requested AUD 84.70)". */
export function sentNote(dispute) {
  if (!dispute?.sentAt) return null;
  const f = dispute.facts || {};
  const asked = f.outcome === 'credit_note' ? `credit requested ${f.credit?.totalText}` : 'corrected tax invoice requested';
  return `Query sent to supplier on ${when(dispute.sentAt)} (${asked})`;
}

/** The facts table, one row per variance: [what, ordered, received, invoiced, PO price, invoiced price, amount]. */
export function factRows(facts) {
  return (facts?.variances || []).map((v) => {
    if (v.type === 'quantity') return [`${v.item}: quantity`, v.ordered ?? '—', v.received ?? 'no receipt', v.invoiced, v.poUnitPriceText, '—', `${v.amountExGstText} ex GST`];
    if (v.type === 'price') return [`${v.item}: unit price`, '—', '—', v.invoiced, v.poUnitPriceText, v.invoicedUnitPriceText, `${v.amountExGstText} ex GST`];
    if (v.missing) return ['GST', '—', '—', '—', '—', '—', `no ${v.missing === 'gst' ? 'GST amount' : 'subtotal'} shown`];
    return [`GST (${v.ratePct}% of ${v.subtotalText})`, '—', '—', '—', `should be ${v.correctText}`, `charged ${v.chargedText}`, `${v.differenceText} ${v.direction}`];
  });
}

function FactsTable({ facts }) {
  const head = ['Variance', 'Ordered', 'Received', 'Invoiced', 'PO', 'Invoice', 'In question'];
  return h(
    'div',
    { className: 'dispute-facts' },
    h(
      'table',
      { className: 'table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          head.map((x) => h('th', { key: x }, x)),
        ),
      ),
      h(
        'tbody',
        null,
        factRows(facts).map((row, i) =>
          h(
            'tr',
            { key: i },
            row.map((c, j) => h('td', { key: j }, String(c))),
          ),
        ),
      ),
    ),
    h(
      'p',
      { className: 'hint' },
      `Invoice ${facts.invoiceNumber || '(no number)'}${facts.poNumber ? `, ${facts.poNumber}` : ''}${facts.deliveryDate ? `, delivered ${day(facts.deliveryDate)}` : ''}. Asks for ${facts.outcomeText}.`,
      facts.outcome === 'credit_note' ? ` Credit: ${facts.credit.exGstText} plus GST of ${facts.credit.gstText} = ${facts.credit.totalText}.` : '',
    ),
  );
}

/** The sign-off and signature as they will be sent: the person sending it, then the company. */
export function signature(dispute, user, company) {
  return [dispute?.draft?.signOff || 'Kind regards,', user?.name || 'Your name', company].filter(Boolean).join('\n');
}

/**
 * The panel. data: { items, canDraft, company } from GET /api/invoices/:id/disputes.
 * Handlers return promises; the panel stays as it is if one fails.
 */
export function DisputePanel({ data, user, busy = false, onDraft = () => {}, onSave = () => {}, onSend = () => {}, onDiscard = () => {}, onResolve = () => {} }) {
  const current = (data?.items || []).find((d) => ['draft', 'sending', 'sent', 'resolved'].includes(d.status)) || null;
  const writer = canWrite(user);
  const [subject, setSubject] = React.useState(current?.draft.subject ?? '');
  const [body, setBody] = React.useState(current?.draft.body ?? '');
  const [noteText, setNoteText] = React.useState('');
  const [outcome, setOutcome] = React.useState(current?.facts?.outcome === 'credit_note' ? 'credit_note_received' : 'corrected_invoice_received');
  React.useEffect(() => {
    setSubject(current?.draft.subject ?? '');
    setBody(current?.draft.body ?? '');
    setNoteText('');
  }, [current?.id, current?.version, current?.draft.subject, current?.draft.body]);

  if (!current) {
    if (!data?.canDraft) return null;
    return h(
      'section',
      { className: 'panel dispute' },
      h('h2', null, 'Query to supplier'),
      h(
        'p',
        { className: 'hint' },
        'A check found a quantity, price or GST variance. The agent can draft an email asking the supplier for a credit note or a corrected invoice. You review it before anything is sent.',
      ),
      writer
        ? h(
            'div',
            { className: 'decision-actions' },
            h('button', { type: 'button', className: 'btn btn-primary', disabled: busy, onClick: () => onDraft() }, 'Draft query to supplier'),
          )
        : h('p', { className: 'hint' }, 'A reviewer, approver or administrator can draft a query.'),
    );
  }

  const label = h('span', { className: `dispute-label ${current.draft.aiDrafted ? 'dispute-ai' : 'dispute-template'}` }, draftLabel(current));
  const facts = h(FactsTable, { facts: current.facts });

  if (current.status === 'draft' || current.status === 'sending') {
    const edited = subject !== current.draft.subject || body !== current.draft.body;
    const editable = writer && current.status === 'draft';
    return h(
      'section',
      { className: 'panel dispute' },
      h('h2', null, 'Query to supplier: draft ', label),
      facts,
      h('p', { className: 'hint' }, `To ${current.to}. Nothing is sent until you press Send.`),
      h('label', { className: 'field-label', htmlFor: 'dispute-subject' }, 'Subject'),
      h('input', { id: 'dispute-subject', type: 'text', value: subject, maxLength: 150, readOnly: !editable, disabled: busy, onChange: (e) => setSubject(e.target.value) }),
      h('label', { className: 'field-label', htmlFor: 'dispute-body' }, 'Email (the greeting and signature are added for you)'),
      h('p', { className: 'dispute-greeting' }, current.draft.greeting),
      h('textarea', { id: 'dispute-body', rows: 14, value: body, maxLength: 3000, readOnly: !editable, disabled: busy, onChange: (e) => setBody(e.target.value) }),
      h('pre', { className: 'dispute-signature' }, signature(current, user, data?.company)),
      h('p', { className: 'hint' }, 'Signed by whoever sends it.'),
      editable
        ? h(
            'div',
            { className: 'decision-actions' },
            edited
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'btn btn-primary',
                    disabled: busy || !subject.trim() || !body.trim(),
                    onClick: () => onSave(current.id, { subject, body, expectedVersion: current.version }),
                  },
                  'Save changes',
                )
              : h('button', { type: 'button', className: 'btn btn-primary', disabled: busy, onClick: () => onSend(current.id) }, 'Send'),
            h('input', {
              type: 'text',
              placeholder: 'Reason to discard',
              value: noteText,
              maxLength: 500,
              disabled: busy,
              onChange: (e) => setNoteText(e.target.value),
              'aria-label': 'Reason to discard',
            }),
            h('button', { type: 'button', className: 'btn btn-outline', disabled: busy || !noteText.trim(), onClick: () => onDiscard(current.id, noteText.trim()) }, 'Discard'),
          )
        : null,
    );
  }

  const sent = h(
    'div',
    { className: 'dispute-sent' },
    h('p', null, h('strong', null, sentNote(current)), current.sentBy ? ` by ${current.sentBy}` : ''),
    current.delivery?.redirected
      ? h(
          'p',
          { className: 'hint' },
          current.delivery.deliveredTo
            ? `Not production: it went to the test recipient (${current.delivery.deliveredTo}), not the supplier.`
            : 'Not production: it was kept in the simulated outbox, not emailed.',
        )
      : null,
    current.sentEmail?.replyTo ? h('p', { className: 'hint' }, `Replies go to ${current.sentEmail.replyTo}.`) : null,
    // Exactly what was sent, with the sender's signature.
    h('p', { className: 'dispute-subject' }, current.sentEmail?.subject || current.draft.subject),
    h('pre', { className: 'dispute-body' }, current.sentEmail?.text || current.draft.body),
  );

  if (current.status === 'resolved') {
    return h(
      'section',
      { className: 'panel dispute' },
      h('h2', null, 'Query to supplier: resolved ', label),
      sent,
      h('p', null, h('strong', null, `Resolved: ${current.resolution.label}`), ` (${current.resolution.name}, ${when(current.resolution.at)}). ${current.resolution.note}`),
    );
  }

  return h(
    'section',
    { className: 'panel dispute' },
    h('h2', null, 'Query to supplier: sent ', label),
    facts,
    sent,
    writer
      ? h(
          'div',
          { className: 'decision-actions' },
          h(
            'select',
            { value: outcome, disabled: busy, onChange: (e) => setOutcome(e.target.value), 'aria-label': 'What came back' },
            Object.entries(RESOLUTIONS).map(([id, text]) => h('option', { key: id, value: id }, text)),
          ),
          h('input', {
            type: 'text',
            placeholder: 'Note (for example the credit note number)',
            value: noteText,
            maxLength: 500,
            disabled: busy,
            onChange: (e) => setNoteText(e.target.value),
            'aria-label': 'Note',
          }),
          h(
            'button',
            { type: 'button', className: 'btn btn-primary', disabled: busy || !noteText.trim(), onClick: () => onResolve(current.id, outcome, noteText.trim()) },
            'Mark resolved',
          ),
        )
      : null,
  );
}
