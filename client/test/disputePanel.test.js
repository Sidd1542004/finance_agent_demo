// The invoice screen's query to the supplier (src/disputePanel.js), rendered to
// HTML in Node: no query yet, an AI-drafted draft, a template draft, sent, resolved.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { DisputePanel, draftLabel, sentNote, factRows, hasVariance, canWrite } from '../src/disputePanel.js';

const render = (props) => ReactDOMServer.renderToStaticMarkup(React.createElement(DisputePanel, props));
const REVIEWER = { name: 'Rita', roles: ['reviewer'] };
const PAYER = { name: 'Sam', roles: ['payer'] };
const ADMIN = { name: 'Ada', roles: ['admin'] };

const FACTS = {
  invoiceNumber: 'SCP-7731',
  poNumber: 'PO-2042',
  deliveryDate: '2026-09-17',
  outcome: 'credit_note',
  outcomeText: 'a credit note for AUD 84.70',
  credit: { exGstText: 'AUD 77.00', gstText: 'AUD 7.70', totalText: 'AUD 84.70' },
  variances: [
    {
      type: 'quantity',
      item: 'PAL-STD-1200 Standard timber pallet 1200 x 1000',
      ordered: 12,
      received: 10,
      invoiced: 12,
      excess: 2,
      poUnitPriceText: 'AUD 38.50',
      amountExGstText: 'AUD 77.00',
    },
  ],
};
const draft = (over = {}) => ({
  id: 'd1',
  status: 'draft',
  to: 'ar@southerncrosspallets.example',
  version: 1,
  facts: FACTS,
  draft: {
    subject: 'Invoice SCP-7731: credit note requested (AUD 84.70)',
    greeting: 'Dear Southern Cross Pallets Pty Ltd accounts team,',
    body: 'Thank you for invoice SCP-7731.\n\nCould you please issue a credit note for AUD 84.70?',
    signOff: 'Kind regards,',
    aiDrafted: true,
    fallbackReason: null,
  },
  sentAt: null,
  ...over,
});

test('no query yet: one button for a reviewer, approver or admin; a payer only reads; nothing without a variance', () => {
  const none = { items: [], canDraft: true };
  assert.match(render({ data: none, user: REVIEWER }), /<button[^>]*>Draft query to supplier<\/button>/);
  assert.match(render({ data: none, user: ADMIN }), /Draft query to supplier/);
  const payer = render({ data: none, user: PAYER });
  assert.doesNotMatch(payer, /<button/);
  assert.match(payer, /A reviewer, approver or administrator can draft a query/);
  assert.equal(render({ data: { items: [], canDraft: false }, user: REVIEWER }), '');
  assert.equal(hasVariance({ checks: [{ id: 'quantity_match', status: 'fail' }] }), true);
  assert.equal(
    hasVariance({
      checks: [
        { id: 'quantity_match', status: 'unverified' },
        { id: 'match_score', status: 'fail' },
      ],
    }),
    false,
  );
  assert.deepEqual([canWrite(REVIEWER), canWrite(ADMIN), canWrite(PAYER)], [true, true, false]);
});

test('an AI-drafted draft: the facts table, the editable subject and email, Send as the main action, Discard', () => {
  const html = render({ data: { items: [draft()], company: 'Meridian Logistics Pty Ltd' }, user: REVIEWER });
  assert.match(html, /Query to supplier: draft <span class="dispute-label dispute-ai">AI-drafted<\/span>/);
  assert.match(
    html,
    /<td>PAL-STD-1200 Standard timber pallet 1200 x 1000: quantity<\/td><td>12<\/td><td>10<\/td><td>12<\/td><td>AUD 38.50<\/td><td>—<\/td><td>AUD 77.00 ex GST<\/td>/,
  );
  assert.match(html, /Credit: AUD 77\.00 plus GST of AUD 7\.70 = AUD 84\.70\./);
  assert.match(html, /To ar@southerncrosspallets\.example\. Nothing is sent until you press Send\./);
  assert.match(html, /id="dispute-subject"[^>]*value="Invoice SCP-7731: credit note requested \(AUD 84.70\)"/);
  // Code's structure around the editable paragraphs: the greeting, then the signature of whoever sends it.
  assert.match(html, /<p class="dispute-greeting">Dear Southern Cross Pallets Pty Ltd accounts team,<\/p><textarea id="dispute-body"[^>]*>Thank you for invoice SCP-7731\./);
  assert.match(html, /<pre class="dispute-signature">Kind regards,\nRita\nMeridian Logistics Pty Ltd<\/pre>/);
  assert.match(html, /Signed by whoever sends it\./);
  assert.match(html, /<button type="button" class="btn btn-primary">Send<\/button>/);
  assert.match(html, />Discard<\/button>/);
  // A payer sees the draft, read-only, with no buttons.
  const payer = render({ data: { items: [draft()] }, user: PAYER });
  assert.match(payer, /id="dispute-subject"[^>]*readonly=""/);
  assert.match(payer, /<textarea id="dispute-body"[^>]*readonly=""/);
  assert.doesNotMatch(payer, /<button/);
});

test('a template draft says so, and why', () => {
  const d = draft({ draft: { ...draft().draft, aiDrafted: false, fallbackReason: 'rate_limit' } });
  assert.equal(draftLabel(d), 'From template (the AI was busy)');
  assert.match(render({ data: { items: [d] }, user: REVIEWER }), /<span class="dispute-label dispute-template">From template \(the AI was busy\)<\/span>/);
  assert.equal(draftLabel(draft({ draft: { ...draft().draft, aiDrafted: false, fallbackReason: 'payment' } })), 'From template (the AI mentioned payment)');
  assert.deepEqual(
    factRows({
      variances: [
        { type: 'gst', ratePct: 10, subtotalText: 'AUD 770.00', chargedText: 'AUD 70.00', correctText: 'AUD 77.00', differenceText: 'AUD 7.00', direction: 'undercharged' },
      ],
    }),
    [['GST (10% of AUD 770.00)', '—', '—', '—', 'should be AUD 77.00', 'charged AUD 70.00', 'AUD 7.00 undercharged']],
  );
});

test('sent: the note with the date and the credit, the email read-only, and "Mark resolved"', () => {
  const sent = draft({
    status: 'sent',
    sentAt: '2026-11-06T00:30:00.000Z',
    sentBy: 'Rita Reviewer',
    delivery: { mode: 'simulated_outbox', redirected: true, deliveredTo: null },
    sentEmail: {
      subject: 'Invoice SCP-7731: credit note requested (AUD 84.70)',
      text: 'Dear Southern Cross Pallets Pty Ltd accounts team,\n\nThank you for invoice SCP-7731.\n\nKind regards,\nRita Reviewer\nMeridian Logistics Pty Ltd',
      replyTo: 'ap@meridian.example',
    },
  });
  assert.match(sentNote(sent), /^Query sent to supplier on .+ \(credit requested AUD 84\.70\)$/);
  const html = render({ data: { items: [sent] }, user: REVIEWER });
  assert.match(html, /Query to supplier: sent/);
  assert.match(html, /<strong>Query sent to supplier on .+ \(credit requested AUD 84\.70\)<\/strong> by Rita Reviewer/);
  assert.match(html, /kept in the simulated outbox, not emailed/);
  // Exactly what was sent, with the sender's signature, and where replies go.
  assert.match(
    html,
    /<pre class="dispute-body">Dear Southern Cross Pallets Pty Ltd accounts team,\n\nThank you for invoice SCP-7731\.\n\nKind regards,\nRita Reviewer\nMeridian Logistics Pty Ltd<\/pre>/,
  );
  assert.match(html, /Replies go to ap@meridian\.example\./);
  assert.doesNotMatch(html, /<textarea|>Send</);
  assert.match(html, />Mark resolved<\/button>/);
  assert.match(html, /<option value="credit_note_received" selected="">Credit note received<\/option>/);
  assert.doesNotMatch(render({ data: { items: [sent] }, user: PAYER }), /Mark resolved/);
  const gst = draft({ status: 'sent', sentAt: '2026-11-06T00:30:00.000Z', facts: { ...FACTS, outcome: 'corrected_invoice' } });
  assert.match(sentNote(gst), /\(corrected tax invoice requested\)$/);
});

test('resolved: what came back and the note; no more buttons', () => {
  const done = draft({
    status: 'resolved',
    sentAt: '2026-11-06T00:30:00.000Z',
    resolution: { outcome: 'credit_note_received', label: 'Credit note received', note: 'CN-7731 for AUD 84.70.', name: 'Rita Reviewer', at: '2026-11-08T01:00:00.000Z' },
  });
  const html = render({ data: { items: [done] }, user: REVIEWER });
  assert.match(html, /Query to supplier: resolved/);
  assert.match(html, /<strong>Resolved: Credit note received<\/strong> \(Rita Reviewer, .+\)\. CN-7731 for AUD 84\.70\./);
  assert.doesNotMatch(html, /<button/);
});
