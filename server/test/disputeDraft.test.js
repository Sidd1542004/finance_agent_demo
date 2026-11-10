// Queries to suppliers about a variance: the facts code works out
// (disputeFacts.js), the structure code owns, the checks on the model's
// paragraphs and the template (disputeDraft.js). The invoices are the sample
// ones, run through the agent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent } from '../src/agent/finance/invoiceAgent.js';
import { extractWithRules } from '../src/agent/finance/extract.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { vendors, purchaseOrders, goodsReceipts, renderInvoiceText, findSample } from '../src/seed/data.js';
import { disputeFacts, failedVariances, shortDate } from '../src/agent/finance/disputeFacts.js';
import { draftDispute, draftProblems, templateDraft, assembleEmail, dropRequests, requestSentence, DISPUTE_SYSTEM, DISPUTE_DRAFT } from '../src/agent/finance/disputeDraft.js';
import { resetModelPause } from '../src/orchestrator/model.js';

const policy = { matchThreshold: 99, missingAbn: 'review', priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };
const RAW_MARKER = 'RAWTEXT-MARKER-4411';

async function processed(id) {
  const invoices = [];
  const ledger = createMemoryLedger({ vendors, purchaseOrders, goodsReceipts, invoices });
  const agent = createInvoiceAgent({ ledger, extract: async (t) => extractWithRules(t), policy, save: async () => {}, today: () => '2026-10-06' });
  const invoice = {
    id: 'inv-1',
    createdAt: new Date(2026, 9, 6, 9),
    source: { kind: 'sample' },
    rawText: `${renderInvoiceText(findSample(id))}\nNote: ${RAW_MARKER}`,
    status: 'received',
  };
  invoices.push(invoice);
  await runAgent(agent, { invoice });
  return invoice;
}
const factsFor = async (id) => {
  const invoice = await processed(id);
  const vendor = vendors.find((v) => v.abn === invoice.supplier?.abn);
  return disputeFacts({ invoice, vendor, receipts: goodsReceipts.filter((r) => r.poNumber === invoice.matchedPo), gstRatePct: 10, buyer: 'Meridian Logistics Pty Ltd' });
};

// ----- the facts, and what is asked for -----

test('SCP-7731, quantity: 2 × AUD 38.50 = AUD 77.00 + GST = AUD 84.70; a credit note, or word that the rest is still to come', async () => {
  const f = await factsFor('quantity-variance');
  assert.deepEqual(f.failedChecks, ['quantity_match']);
  assert.deepEqual(
    f.variances.map((v) => [v.type, v.reason, v.item, v.ordered, v.received, v.invoiced, v.excess, v.poUnitPrice, v.amountExGst, v.working]),
    [['quantity', 'not_received', 'Standard timber pallet 1200 x 1000 (PAL-STD-1200)', 12, 10, 12, 2, 38.5, 77, '2 × AUD 38.50 = AUD 77.00 ex GST']],
  );
  // Quantities of an item read "<n> × <description>".
  assert.deepEqual([f.variances[0].invoicedText, f.variances[0].excessText], ['12 × Standard timber pallet 1200 x 1000', '2 × Standard timber pallet 1200 x 1000']);
  assert.deepEqual(f.credit, {
    exGst: 77,
    exGstText: 'AUD 77.00',
    gst: 7.7,
    gstText: 'AUD 7.70',
    total: 84.7,
    totalText: 'AUD 84.70',
    working: 'AUD 77.00 + GST AUD 7.70 = AUD 84.70',
  });
  assert.equal(f.outcome, 'credit_note');
  assert.deepEqual(f.requests, [
    { id: 'credit_note', text: 'issue a credit note for AUD 84.70' },
    { id: 'remaining_delivery', text: 'let us know if the remaining 2 × Standard timber pallet 1200 x 1000 are still to be delivered' },
  ]);
  assert.equal(f.outcomeText, 'issue a credit note for AUD 84.70, or let us know if the remaining 2 × Standard timber pallet 1200 x 1000 are still to be delivered');
  assert.deepEqual(
    [f.invoiceNumber, f.invoiceDate, f.poNumber, f.deliveryDate, f.supplierName, f.supplierEmail, f.currency],
    ['SCP-7731', '18 Sep 2026', 'PO-2042', '17 Sep 2026', 'Southern Cross Pallets Pty Ltd', 'ar@southerncrosspallets.example', 'AUD'],
  );
});

test('HOS-10517, price: 6 × AUD 19.60 = AUD 117.60 + GST = AUD 129.36; a credit note, or the confirmation of a revised price', async () => {
  const f = await factsFor('price-variance');
  assert.ok(f.failedChecks.includes('price_match'));
  assert.deepEqual(
    f.variances.map((v) => [v.type, v.item, v.invoiced, v.poUnitPrice, v.invoicedUnitPrice, v.unitDifference, v.pctAbovePo, v.amountExGst, v.working]),
    [['price', 'Ergonomic task chair (CHR-ERG-01)', 6, 245, 264.6, 19.6, 8, 117.6, '6 × AUD 19.60 = AUD 117.60 ex GST']],
  );
  assert.deepEqual([f.credit.exGst, f.credit.gst, f.credit.total, f.credit.totalText], [117.6, 11.76, 129.36, 'AUD 129.36']);
  assert.deepEqual(
    f.requests.map((r) => r.id),
    ['credit_note', 'revised_price'],
  );
  assert.equal(f.outcomeText, 'issue a credit note for AUD 129.36, or, if a revised price was agreed, send the confirmation so we can update our purchase order');
  assert.equal(f.invoiceDate, '26 Sep 2026');
});

test('SCP-7790, GST: AUD 70.00 shown; 10% × AUD 770.00 = AUD 77.00; undercharged, so a corrected tax invoice and no alternative', async () => {
  const f = await factsFor('gst-error');
  assert.deepEqual(f.failedChecks, ['tax_charged']);
  const [gst] = f.variances;
  assert.deepEqual(
    [gst.type, gst.charged, gst.subtotal, gst.correct, gst.difference, gst.direction, gst.working],
    ['gst', 70, 770, 77, 7, 'undercharged', '10% × AUD 770.00 = AUD 77.00'],
  );
  assert.equal(f.credit.total, 0);
  assert.equal(f.outcome, 'corrected_invoice');
  assert.deepEqual(f.requests, [{ id: 'corrected_invoice', text: 'send a corrected tax invoice showing GST of AUD 77.00' }]);
  assert.equal(f.outcomeText, 'send a corrected tax invoice showing GST of AUD 77.00');
});

test('dates in the facts read "18 Sep 2026"; a clean invoice has nothing to query', async () => {
  assert.deepEqual([shortDate('2026-09-18'), shortDate('2026-10-01T00:00:00.000Z'), shortDate(null), shortDate('soon')], ['18 Sep 2026', '1 Oct 2026', null, 'soon']);
  const clean = await processed('clean');
  assert.deepEqual(failedVariances(clean), []);
  assert.equal(disputeFacts({ invoice: clean }), null);
});

// ----- the structure code owns, and the template -----

test('code owns the subject, greeting, sign-off and signature; the signature is the sender and the company', async () => {
  const f = await factsFor('quantity-variance');
  const t = templateDraft(f);
  assert.equal(t.subject, 'Invoice SCP-7731: credit note requested (AUD 84.70)');
  assert.equal(t.greeting, 'Dear Southern Cross Pallets Pty Ltd accounts team,');
  const email = assembleEmail({ greeting: t.greeting, body: t.body }, { name: 'Priya Approver', company: 'Meridian Logistics Pty Ltd' });
  assert.ok(email.startsWith('Dear Southern Cross Pallets Pty Ltd accounts team,\n\nThank you for invoice SCP-7731 dated 18 Sep 2026 for purchase order PO-2042.'));
  assert.ok(email.endsWith('\n\nKind regards,\nPriya Approver\nMeridian Logistics Pty Ltd'));
  assert.equal(templateDraft(await factsFor('gst-error')).subject, 'Invoice SCP-7790: corrected tax invoice requested');
});

test('the template for each passes every check, shows the working, asks for the outcomes, and uses no internal terms', async () => {
  for (const id of ['quantity-variance', 'price-variance', 'gst-error']) {
    const f = await factsFor(id);
    const t = templateDraft(f);
    assert.deepEqual(draftProblems(t.body.split('\n\n'), f), [], `${id}: ${t.body}`);
    for (const v of f.variances) assert.ok(t.body.includes(v.working), `${id}: ${v.working}`);
    assert.ok(t.body.includes(`Could you please ${f.outcomeText}?`), id);
    assert.doesNotMatch(t.body, /pay(?!able)|bank|BSB|check|variance|match score|Dear|regards/i, id);
  }
  const q = templateDraft(await factsFor('quantity-variance')).body;
  assert.match(
    q,
    /- Standard timber pallet 1200 x 1000 \(PAL-STD-1200\): 12 invoiced, 12 ordered, 10 received\. The 2 × Standard timber pallet 1200 x 1000 not received: 2 × AUD 38\.50 = AUD 77\.00 ex GST\./,
  );
  assert.match(q, /In total: AUD 77\.00 \+ GST AUD 7\.70 = AUD 84\.70\./);
  assert.match(q, /Could you please issue a credit note for AUD 84\.70, or let us know if the remaining 2 × Standard timber pallet 1200 x 1000 are still to be delivered\?/);
});

// ----- the model's paragraphs: checked, or the template with the reason -----

const reply = (obj, status = 200) => ({
  ok: status < 400,
  status,
  headers: new Headers(status === 429 ? { 'retry-after': '6' } : {}),
  text: async () => JSON.stringify(obj),
  json: async () => obj,
});
const groqSays = (content, status = 200) => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    if (status === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (status !== 200) return reply({ error: { message: 'Rate limit reached' } }, status);
    return reply({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 700, completion_tokens: 220 } });
  };
  return { fetchImpl, bodies };
};
const GOOD = [
  'Thank you for invoice SCP-7731 dated 18 Sep 2026 for purchase order PO-2042. We received 10 of the 12 Standard timber pallets ordered on 17 Sep 2026, but the invoice is for 12.',
  'The 2 not received come to 2 × AUD 38.50 = AUD 77.00 ex GST, or AUD 84.70 with GST of AUD 7.70.',
  'Could you please issue a credit note for AUD 84.70, or let us know if the remaining 2 × Standard timber pallet 1200 x 1000 are still to be delivered?',
];
const draftWith = async (content, status) => {
  resetModelPause();
  const f = await factsFor('quantity-variance');
  const g = groqSays(content, status);
  return { r: await draftDispute(f, { apiKey: 'k', model: 'openai/gpt-oss-120b', fetchImpl: g.fetchImpl }), bodies: g.bodies, facts: f };
};

test('grounded, courteous paragraphs are used as written ("AI-drafted"), inside the structure code owns; the model saw the facts only', async () => {
  const { r, bodies, facts } = await draftWith({ body: GOOD.join('\n\n') });
  assert.deepEqual([r.aiDrafted, r.fallbackReason], [true, null]);
  // The model's own request is dropped; code's closing request, from the stored outcomes, ends the body.
  assert.equal(r.body, [GOOD[0], GOOD[1], requestSentence(facts)].join('\n\n'));
  assert.equal(r.call.requestsDropped, 1);
  assert.equal(r.subject, templateDraft(facts).subject, 'the subject is code’s');
  assert.equal(r.greeting, 'Dear Southern Cross Pallets Pty Ltd accounts team,');
  assert.deepEqual([r.call.promptTokens, r.call.completionTokens, r.call.outcome], [700, 220, 'ok']);
  const sent = bodies[0];
  assert.equal(sent.messages[0].content, DISPUTE_SYSTEM);
  const input = JSON.parse(sent.messages[1].content);
  assert.deepEqual(Object.keys(input), ['task', 'facts']);
  assert.deepEqual(
    input.facts.requests.map((x) => x.id),
    ['credit_note', 'remaining_delivery'],
  );
  assert.ok(!sent.messages[1].content.includes(RAW_MARKER), 'never the invoice text');
  assert.equal(sent.reasoning_effort, 'low');
  assert.equal(sent.max_completion_tokens, DISPUTE_DRAFT.maxTokens);
  assert.match(DISPUTE_SYSTEM, /Never use our internal terms: "check", "checked", "variance", "credit calculation", "match score"/);
});

test('rejected, the template instead: an invented number, bank details, payment, an accusation, a comparison, an internal term, another outcome, its own greeting or sign-off', async () => {
  const swap = (from, to) => GOOD.map((p) => p.replace(from, to));
  const cases = [
    ['ungrounded_number', swap('AUD 84.70 with', 'AUD 90.00 with')],
    ['bank_details', [...GOOD, 'Please use our bank account details on file.']],
    ['payment', [...GOOD, 'We will pay the rest once the credit note arrives.']],
    ['accusation', [...GOOD, 'This looks like a deliberate overcharge.']],
    ['unsupported_comparison', [...GOOD, 'This is the largest discrepancy we have seen.']],
    ['internal_term', swap('Thank you for invoice', 'Our check of invoice')],
    ['internal_term', [...GOOD, 'The variance is shown in our credit calculation.']],
    ['internal_term', swap('but the invoice is for 12.', 'so the match score was low.')],
    ['unsupported_outcome', [...GOOD.slice(0, 2), 'A refund of AUD 84.70 would also be acceptable.']],
    ['unsupported_outcome', [...GOOD, 'Alternatively, a discount on the next order would be fine.']],
    ['structure', ['Dear Southern Cross Pallets Pty Ltd,', ...GOOD]],
    ['structure', [...GOOD, 'Kind regards, Accounts Payable']],
    ['unknown_reference', swap('PO-2042', 'DN-7731')],
    ['unknown_email', [...GOOD, 'Reply to ap@meridian.example.']],
  ];
  for (const [reason, paragraphs] of cases) {
    const { r, facts } = await draftWith({ body: paragraphs.join('\n\n') });
    assert.equal(r.aiDrafted, false, reason);
    assert.equal(r.fallbackReason, reason, paragraphs.join(' | '));
    assert.deepEqual({ subject: r.subject, greeting: r.greeting, body: r.body }, templateDraft(facts), 'the template');
  }
});

test('a rate limit, a timeout or an answer that is not the right JSON: the template, with the reason', async () => {
  for (const [status, content, reason] of [
    [429, null, 'rate_limit'],
    ['timeout', null, 'timeout'],
    [200, 'Dear supplier, here is my email.', 'bad_output'],
    [200, { paragraphs: ['An array, not the body string.'] }, 'bad_output'],
    [200, { body: '   ' }, 'bad_output'],
  ]) {
    const { r, facts } = await draftWith(content, status);
    assert.deepEqual([r.aiDrafted, r.fallbackReason], [false, reason], String(status));
    assert.equal(r.body, templateDraft(facts).body);
  }
  resetModelPause();
  const none = await draftDispute(await factsFor('gst-error'), {});
  assert.deepEqual([none.aiDrafted, none.fallbackReason], [false, 'not_configured']);
});

test('code writes the closing request from the stored outcomes; the model is told not to ask for anything', async () => {
  const q = await factsFor('quantity-variance');
  assert.equal(
    requestSentence(q),
    'Could you please issue a credit note for AUD 84.70, or let us know if the remaining 2 × Standard timber pallet 1200 x 1000 are still to be delivered?',
  );
  assert.equal(
    requestSentence(await factsFor('price-variance')),
    'Could you please issue a credit note for AUD 129.36, or, if a revised price was agreed, send the confirmation so we can update our purchase order?',
  );
  assert.equal(requestSentence(await factsFor('gst-error')), 'Could you please send a corrected tax invoice showing GST of AUD 77.00?');
  assert.match(DISPUTE_SYSTEM, /Do not ask for anything and do not write a question: the closing request \(outcomeText\) is added after your paragraphs\./);
  // The template ends with the same sentence, then the offer to correct us.
  assert.ok(templateDraft(q).body.endsWith(`${requestSentence(q)}\n\nIf we have misread anything, please reply to this email with the details.`));
});

test('request sentences in the model’s text are dropped; with nothing meaningful left, the template (request_in_body)', async () => {
  const asks = [
    'Thank you for invoice SCP-7731 dated 18 Sep 2026. Could you please send a corrected invoice? We received 10 of the 12 pallets on 17 Sep 2026.',
    'Please issue a credit note at your earliest convenience. Kindly confirm the delivery date. The 2 not received come to 2 × AUD 38.50 = AUD 77.00 ex GST.',
    'We would appreciate a prompt reply.',
  ];
  const kept = dropRequests(asks);
  assert.equal(kept.dropped, 4);
  assert.deepEqual(kept.paragraphs, [
    'Thank you for invoice SCP-7731 dated 18 Sep 2026. We received 10 of the 12 pallets on 17 Sep 2026.',
    'The 2 not received come to 2 × AUD 38.50 = AUD 77.00 ex GST.',
  ]);
  const { r, facts } = await draftWith({ body: asks.join('\n\n') });
  assert.deepEqual([r.aiDrafted, r.fallbackReason, r.call.requestsDropped], [true, null, 4]);
  assert.equal(r.body, [...kept.paragraphs, requestSentence(facts)].join('\n\n'));
  // Only requests: the template, with the reason.
  const only = await draftWith({ body: 'Could you please issue a credit note for AUD 84.70?\n\nKindly let us know.' });
  assert.deepEqual([only.r.aiDrafted, only.r.fallbackReason], [false, 'request_in_body']);
  assert.equal(only.r.body, templateDraft(only.facts).body);
});
