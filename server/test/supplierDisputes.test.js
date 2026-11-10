// Queries to suppliers about a variance, through the app: who may draft,
// edit, send, discard and resolve; one send per query; delivery as payment
// notices are delivered (outside production, never the supplier); the invoice
// is never changed; the audit log never holds the email body.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../test-support/app.js';

const t = await startApp();
test.after(t.stop);

const { renderInvoiceText, findSample } = await import('../src/seed/data.js');
const { Invoice, SupplierDispute, OutboxMessage, AuditEvent } = await import('../src/models/index.js');
const { configureDisputeModel } = await import('../src/services/paymentSystem.js');
const { createSupplierDisputes } = await import('../src/services/supplierDisputes.js');
const { createEmailDelivery } = await import('../src/services/emailDelivery.js');
const { resetModelPause } = await import('../src/orchestrator/model.js');
const { config } = await import('../src/config.js');

const BODY_MARKER = 'zebra quokka paragraph';
const reviewer = await t.signIn('reviewer');
const approver = await t.signIn('approver');
const payer = await t.signIn('payer');
const admin = await t.signIn('admin');

// The model: grounded body paragraphs that carry a marker, so we can look for the body in the audit log.
const modelCalls = [];
configureDisputeModel({
  apiKey: 'test-key',
  model: 'openai/gpt-oss-120b',
  fetchImpl: async (url, init) => {
    const facts = JSON.parse(JSON.parse(init.body).messages[1].content).facts;
    modelCalls.push(facts.invoiceNumber);
    // Its own request is dropped (code writes the request); the rest is kept.
    const content = JSON.stringify({
      body: `Thank you for invoice ${facts.invoiceNumber} for purchase order ${facts.poNumber}. We found a difference from the purchase order. ${BODY_MARKER}.\n\nCould you please ${facts.outcomeText}?`,
    });
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  },
});
test.beforeEach(() => resetModelPause());

const post = async (id) => {
  const res = await reviewer.post('/api/invoices', { text: renderInvoiceText(findSample(id)) });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.invoice;
};
const pallets = await post('quantity-variance'); // SCP-7731
const chairs = await post('price-variance'); // HOS-10517
const clean = await post('clean'); // HOS-10482
const stateOf = async (inv) => {
  const d = await Invoice.findById(inv._id).lean();
  return { status: d.status, events: d.events.length, approval: d.approval ?? null };
};
const before = { pallets: await stateOf(pallets), chairs: await stateOf(chairs) };

let disputeId;

test('who may draft: not signed out (401), not without the dashboard header (403), not a payer (403); a payer may view', async () => {
  assert.equal((await t.client().post(`/api/invoices/${pallets._id}/disputes`, {})).status, 401);
  assert.equal((await reviewer.post(`/api/invoices/${pallets._id}/disputes`, {}, { csrf: false })).status, 403);
  const refused = await payer.post(`/api/invoices/${pallets._id}/disputes`, {});
  assert.equal(refused.status, 403);
  const view = await payer.get(`/api/invoices/${pallets._id}/disputes`);
  assert.equal(view.status, 200);
  assert.deepEqual([view.data.items, view.data.canDraft, view.data.variances], [[], true, ['quantity_match']]);
  assert.equal(await SupplierDispute.countDocuments(), 0, 'nothing was drafted');
});

test('a reviewer drafts: AI-drafted, from the facts; the actor is the session, never the body; a second ask returns the same draft', async () => {
  const res = await reviewer.post(`/api/invoices/${pallets._id}/disputes`, { actor: { name: 'Mallory', roles: ['admin'] }, createdBy: 'Mallory' });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const d = res.data.dispute;
  disputeId = d.id;
  assert.deepEqual([d.status, d.label, d.draft.aiDrafted, d.createdBy, d.to], ['draft', 'AI-drafted', true, 'Rita Reviewer', 'ar@southerncrosspallets.example']);
  assert.equal(d.facts.credit.totalText, 'AUD 84.70');
  assert.ok(
    d.draft.body.endsWith(
      '\n\nCould you please issue a credit note for AUD 84.70, or let us know if the remaining 2 × Standard timber pallet 1200 x 1000 are still to be delivered?',
    ),
    d.draft.body,
  );
  assert.equal(d.draft.body.split('Could you please').length, 2, 'one request: code’s');
  // Code owns the structure: the subject and greeting are code's; the body is the paragraphs only.
  assert.equal(d.draft.subject, 'Invoice SCP-7731: credit note requested (AUD 84.70)');
  assert.equal(d.draft.greeting, 'Dear Southern Cross Pallets Pty Ltd accounts team,');
  assert.doesNotMatch(d.draft.body, /Dear|regards|Rita/);
  assert.equal(res.data.dispute.draft.signOff, 'Kind regards,');
  assert.equal((await payer.get(`/api/invoices/${pallets._id}/disputes`)).data.company, config.companyName);
  const again = await approver.post(`/api/invoices/${pallets._id}/disputes`, {});
  assert.deepEqual([again.status, again.data.created, again.data.dispute.id], [200, false, disputeId]);
  assert.deepEqual(modelCalls, ['SCP-7731'], 'one model call');
  // Nothing to query on a clean invoice.
  const none = await reviewer.post(`/api/invoices/${clean._id}/disputes`, {});
  assert.equal(none.status, 409);
  assert.match(none.data.error, /nothing to query/);
});

test('edit: from the version seen; a stale version is refused (409); a payer cannot edit', async () => {
  assert.equal((await payer.put(`/api/disputes/${disputeId}`, { subject: 'x', expectedVersion: 1 })).status, 403);
  const edited = await approver.put(`/api/disputes/${disputeId}`, {
    body: `Could you please issue a credit note for AUD 84.70? ${BODY_MARKER} edited.`,
    expectedVersion: 1,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.dispute.version, 2);
  assert.equal(edited.data.dispute.draft.editedBy.name, 'Priya Approver');
  assert.equal((await reviewer.put(`/api/disputes/${disputeId}`, { subject: 'Late', expectedVersion: 1 })).status, 409);
});

test('send: a payer cannot; two clicks at once send one email; outside production it is not emailed to the supplier', async () => {
  assert.equal((await payer.post(`/api/disputes/${disputeId}/send`, {})).status, 403);
  const [a, b] = await Promise.all([reviewer.post(`/api/disputes/${disputeId}/send`, {}), approver.post(`/api/disputes/${disputeId}/send`, {})]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const sent = (a.status === 200 ? a : b).data.dispute;
  assert.equal(sent.status, 'sent');
  assert.ok(sent.sentAt);
  assert.equal(sent.delivery.mode, 'simulated_outbox', 'the test environment has no email service');
  assert.equal(sent.delivery.deliveredTo, null);
  const messages = await OutboxMessage.find({ kind: 'supplier_dispute' }).lean();
  assert.equal(messages.length, 1, 'sent once');
  assert.equal(messages[0].to, 'ar@southerncrosspallets.example');
  // The email as sent: the greeting, the edited body, then the signature of whoever sent it and the company.
  assert.equal(
    messages[0].body,
    `Dear Southern Cross Pallets Pty Ltd accounts team,\n\nCould you please issue a credit note for AUD 84.70? ${BODY_MARKER} edited.\n\nKind regards,\n${sent.sentBy}\n${config.companyName}`,
  );
  assert.deepEqual([sent.sentEmail.text, sent.sentEmail.subject], [messages[0].body, 'Invoice SCP-7731: credit note requested (AUD 84.70)']);
  assert.equal(sent.sentEmail.replyTo, null, 'no AP_REPLY_TO and no connected mailbox: no Reply-To');
  assert.equal(String((await SupplierDispute.findById(disputeId).lean()).outboxMessageId), String(messages[0]._id));
  assert.equal((await reviewer.post(`/api/disputes/${disputeId}/send`, {})).status, 409, 'already sent');
  assert.equal((await reviewer.put(`/api/disputes/${disputeId}`, { subject: 'After', expectedVersion: 2 })).status, 409, 'no edits once sent');
  // The payment-notice routes cannot touch it.
  assert.equal((await admin.post(`/api/payment-notices/${messages[0]._id}/send`, {})).status, 404);
});

test('resolve: only once sent, with a known outcome and a note; a payer cannot', async () => {
  assert.equal((await payer.post(`/api/disputes/${disputeId}/resolve`, { outcome: 'credit_note_received', note: 'CN-1' })).status, 403);
  assert.equal((await reviewer.post(`/api/disputes/${disputeId}/resolve`, { outcome: 'refund', note: 'x' })).status, 400);
  assert.equal((await reviewer.post(`/api/disputes/${disputeId}/resolve`, { outcome: 'credit_note_received' })).status, 400, 'a note is required');
  const done = await reviewer.post(`/api/disputes/${disputeId}/resolve`, { outcome: 'credit_note_received', note: 'Credit note CN-7731 received.' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.deepEqual([done.data.dispute.status, done.data.dispute.resolution.label], ['resolved', 'Credit note received']);
  // A new query can be drafted once the old one is closed.
  const next = await reviewer.post(`/api/invoices/${pallets._id}/disputes`, {});
  assert.equal(next.status, 201);
});

test('discard: a draft only, with a note; a draft cannot be resolved', async () => {
  const d = (await approver.post(`/api/invoices/${chairs._id}/disputes`, {})).data.dispute;
  assert.equal(d.facts.credit.totalText, 'AUD 129.36');
  assert.equal((await reviewer.post(`/api/disputes/${d.id}/resolve`, { outcome: 'corrected_invoice_received', note: 'x' })).status, 409);
  assert.equal((await reviewer.post(`/api/disputes/${d.id}/discard`, {})).status, 400, 'a note is required');
  const gone = await reviewer.post(`/api/disputes/${d.id}/discard`, { note: 'Agreed by phone.' });
  assert.equal(gone.data.dispute.status, 'discarded');
  assert.equal((await reviewer.post(`/api/disputes/${d.id}/send`, {})).status, 409);
});

test('no query action changes the invoice: status, history and approval are as they were', async () => {
  assert.deepEqual(await stateOf(pallets), before.pallets);
  assert.deepEqual(await stateOf(chairs), before.chairs);
});

test('the audit log has every step, who did it, and never the email body', async () => {
  const entries = await AuditEvent.find({ subjectKind: 'supplier_dispute' }).sort({ at: 1, _id: 1 }).lean();
  assert.deepEqual(
    entries.filter((e) => e.subjectId === disputeId).map((e) => [e.action, e.actor]),
    [
      ['dispute_drafted', 'Rita Reviewer'],
      ['dispute_edited', 'Priya Approver'],
      ['dispute_sent', entries.find((e) => e.action === 'dispute_sent').actor],
      ['dispute_resolved', 'Rita Reviewer'],
    ],
  );
  assert.ok(entries.some((e) => e.action === 'dispute_discarded' && e.reason === 'Agreed by phone.'));
  assert.match(entries[0].detail, /AI-drafted/);
  for (const e of entries) assert.ok(!JSON.stringify(e).includes(BODY_MARKER), `${e.action} holds the body`);
});

const { trustActor } = await import('../src/auth/roles.js');
const asActor = (key) => trustActor({ id: String(t.users[key]._id), name: t.users[key].name, roles: t.users[key].roles });

test('outside production, with an email service, the query goes to the test recipient, marked as a test, with Reply-To when configured', async () => {
  const mail = [];
  const delivery = createEmailDelivery({ appEnv: 'development', mode: 'live', testRecipient: 'qa@test.example', mailer: { send: async (m) => (mail.push(m), { id: 'm1' }) } });
  const service = createSupplierDisputes({ delivery, buyer: 'Meridian Logistics Pty Ltd', policy: config.policy, llm: () => ({}), replyTo: async () => 'ap@meridian.example' });
  const gst = await post('gst-error');
  const { dispute } = await service.draftDispute(gst._id, asActor('approver'));
  assert.deepEqual([dispute.draft.aiDrafted, dispute.draft.fallbackReason], [false, 'not_configured'], 'no model: the template');
  const sent = await service.sendDispute(dispute._id, asActor('approver'));
  assert.deepEqual(
    [sent.delivery.mode, sent.delivery.deliveredTo, sent.delivery.redirected, sent.delivery.replyTo],
    ['test_recipient', 'qa@test.example', true, 'ap@meridian.example'],
  );
  assert.deepEqual(mail[0].to, ['qa@test.example']);
  assert.equal(mail[0].replyTo, 'ap@meridian.example', 'replies go to accounts payable');
  assert.equal(mail[0].subject, '[TEST, for ar@southerncrosspallets.example] Invoice SCP-7790: corrected tax invoice requested');
  assert.match(mail[0].text, /^TEST MESSAGE\. In production this would have gone to ar@southerncrosspallets\.example\./);
  // Without a configured address: no Reply-To at all.
  const bare = [];
  const quiet = createSupplierDisputes({
    delivery: createEmailDelivery({ appEnv: 'development', mode: 'live', testRecipient: 'qa@test.example', mailer: { send: async (m) => (bare.push(m), { id: 'm2' }) } }),
    buyer: 'Meridian Logistics Pty Ltd',
    policy: config.policy,
    llm: () => ({}),
    replyTo: async () => null,
  });
  const again = await quiet.draftDispute((await post('price-variance'))._id, asActor('approver'));
  await quiet.sendDispute(again.dispute._id, asActor('approver'));
  assert.ok(!('replyTo' in bare[0]), 'no Reply-To header');
});

test('Reply-To: AP_REPLY_TO first, otherwise the connected invoice mailbox, otherwise none', async () => {
  const { apReplyTo } = await import('../src/services/supplierDisputes.js');
  const { IngestionSource } = await import('../src/models/index.js');
  assert.equal(await apReplyTo(''), null);
  await IngestionSource.create({ _id: 'outlook', status: 'disconnected', account: 'old-inbox@meridian.example' });
  assert.equal(await apReplyTo(''), null, 'a disconnected mailbox does not count');
  await IngestionSource.create({ _id: 'gmail', status: 'connected', account: 'invoices@meridian.example', connectedAt: new Date() });
  assert.equal(await apReplyTo(''), 'invoices@meridian.example');
  assert.equal(await apReplyTo('ap@meridian.example'), 'ap@meridian.example', 'AP_REPLY_TO wins');
  // Through the app's own service: the connected mailbox is the Reply-To.
  const d = (await reviewer.post(`/api/invoices/${chairs._id}/disputes`, {})).data.dispute;
  const sent = (await approver.post(`/api/disputes/${d.id}/send`, {})).data.dispute;
  assert.equal(sent.sentEmail.replyTo, 'invoices@meridian.example');
  await IngestionSource.deleteMany({});
});

test('the signature is the person who sends it, not the one who drafted it, then the company from COMPANY_NAME', async () => {
  const gst = await post('gst-error');
  const d = (await reviewer.post(`/api/invoices/${gst._id}/disputes`, {})).data.dispute;
  assert.equal(d.createdBy, 'Rita Reviewer');
  const sent = (await admin.post(`/api/disputes/${d.id}/send`, {})).data.dispute;
  assert.equal(sent.sentBy, 'Ada Admin');
  assert.ok(sent.sentEmail.text.startsWith('Dear Southern Cross Pallets Pty Ltd accounts team,\n\n'));
  assert.ok(sent.sentEmail.text.endsWith(`\n\nKind regards,\nAda Admin\n${config.companyName}`), sent.sentEmail.text);
  assert.ok(!sent.sentEmail.text.includes('Rita Reviewer'));
  assert.equal(config.companyName, process.env.COMPANY_NAME || 'Meridian Logistics Pty Ltd');
});

test('the mailer passes Reply-To on: Resend as reply_to, SMTP as replyTo; nothing when there is none', async () => {
  const { createMailer } = await import('../src/services/mailer.js');
  const requests = [];
  const resend = createMailer(
    { resendApiKey: 're_test_key', from: 'AP <ap@meridian.example>' },
    { fetchImpl: async (url, init) => (requests.push(JSON.parse(init.body)), { ok: true, status: 200, json: async () => ({ id: 'r1' }) }) },
  );
  await resend.send({ to: ['s@x.example'], subject: 'S', html: '', text: 't', replyTo: 'ap@meridian.example' });
  await resend.send({ to: ['s@x.example'], subject: 'S', html: '', text: 't' });
  assert.equal(requests[0].reply_to, 'ap@meridian.example');
  assert.ok(!('reply_to' in requests[1]));
  const mails = [];
  const smtp = createMailer(
    { smtp: { host: 'smtp.example', port: 587 }, from: 'ap@meridian.example' },
    { loadNodemailer: async () => ({ default: { createTransport: () => ({ sendMail: async (m) => (mails.push(m), { messageId: 'x' }) }) } }) },
  );
  await smtp.send({ to: ['s@x.example'], subject: 'S', html: '', text: 't', replyTo: 'ap@meridian.example' });
  await smtp.send({ to: ['s@x.example'], subject: 'S', html: '', text: 't' });
  assert.equal(mails[0].replyTo, 'ap@meridian.example');
  assert.ok(!('replyTo' in mails[1]));
});
