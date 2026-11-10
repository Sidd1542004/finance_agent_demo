// POST /api/orchestrator/ask and the thread routes, end to end through the
// real app (docs/phase2-design.md §4, §6, §11, §12). Groq is a stand-in fetch
// that answers the classify and compose calls and records what it was sent.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import mongoose from 'mongoose';
import { startApp, PEOPLE, PASSWORD } from '../test-support/app.js';

const t = await startApp({ BUSINESS_DAYS: 'Mon-Sun', PAYMENT_CUTOFF: '23:59', PAYMENT_DEFAULT_TIME: '00:00', BANK_HOLIDAYS: '2000-01-01', SIM_BANK_DELAY_SECONDS: '0' });
test.after(t.stop);

const { configureAsk } = await import('../src/orchestrator/ask.js');
const { CLASSIFY_SYSTEM } = await import('../src/orchestrator/classify.js');
const { COMPOSE_SYSTEM } = await import('../src/orchestrator/compose.js');
const { resetModelPause } = await import('../src/orchestrator/model.js');
const { route } = await import('../src/orchestrator/router.js');
const { AuditEvent, OrchestratorThread, Vendor, BeneficiaryChange } = await import('../src/models/index.js');
const { createUser } = await import('../src/services/users.js');
const { TEST_SETUP } = await import('../test-support/actors.js');

const FIXTURES = JSON.parse(fs.readFileSync(new URL('./fixtures/orchestrator-questions.json', import.meta.url), 'utf8')).questions;
const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.data));
  return res.data;
};

// ----- the scenario -----
const signed = {};
for (const key of ['reviewer', 'approver', 'payer', 'admin', 'approverPayer']) signed[key] = await t.signIn(key);
const { reviewer, approver, payer } = signed;
const add = async (sampleId) => String(ok(await reviewer.post('/api/invoices', { sampleId }), 201).invoice._id);
const paid = await add('clean'); // HOS-10482
const held = await add('price-variance'); // HOS-10517
await add('unknown-supplier'); // CPS-0388
await add('quantity-variance'); // SCP-7731
ok(await approver.post(`/api/invoices/${paid}/actions/approve`, { note: 'Checked.' }));
const { nextSlot } = ok(await payer.get('/api/payment-calendar'));
ok(await payer.post(`/api/invoices/${paid}/actions/schedule_payment`, { method: 'EFT', scheduledFor: nextSlot.date, scheduledTime: nextSlot.time }));
await t.client().get('/api/cron/tick', { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
ok(await reviewer.post(`/api/invoices/${held}/actions/hold`, { note: 'Waiting for the supplier.' }));
ok(await payer.post('/api/statements', { sampleId: 'october' }), 201);
ok(await payer.post('/api/suppliers/57600410275/beneficiary-changes', { accountName: 'Harbour (SIMULATED)', bsb: '999-004', accountNumber: '44556677', reason: 'Letter.' }), 201);
await createUser({ email: 'norole@test.example', name: 'No Role', password: PASSWORD, roles: [] }, TEST_SETUP);
const noRole = t.client();
ok(await noRole.post('/api/auth/login', { email: 'norole@test.example', password: PASSWORD }));

const FULL = new Set();
for (const v of await Vendor.find().lean()) for (const k of ['bsb', 'accountNumber', 'crn', 'billerCode']) if (v.beneficiary?.[k]) FULL.add(v.beneficiary[k]);
for (const c of await BeneficiaryChange.find().lean()) for (const k of ['bsb', 'accountNumber']) if (c.details?.[k]) FULL.add(c.details[k]);
const whole = (v) => new RegExp(`(?<![0-9A-Za-z])${v.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![0-9A-Za-z])`);

// ----- the Groq stand-in -----
// classify: answers with the fixture's expected intent for that question (or as `classifyAs` says);
// compose: a short explanation with no numbers.
const sent = [];
let classifyAs = null;
let composeWith = () => ({ summary: 'Here is what the records show.' });
const reply = (obj) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 500, completion_tokens: 60 } }),
});
const fetchImpl = async (url, init) => {
  const body = JSON.parse(init.body);
  sent.push(body);
  const user = JSON.parse(body.messages[1].content);
  if (body.messages[0].content === CLASSIFY_SYSTEM) {
    const fixture = FIXTURES.find((f) => f.question === user.question);
    const out =
      classifyAs?.(user) ??
      (fixture?.expect.clarify
        ? { intent: 'supplier_summary', args: {}, clarity: 'unclear', alternatives: ['list_unpaid_invoices'] }
        : { ...(fixture?.expect || { intent: 'unknown', args: {} }), clarity: 'clear' });
    return out instanceof Response || out?.status ? out : reply(out);
  }
  if (body.messages[0].content === COMPOSE_SYSTEM) return reply(composeWith(user));
  throw new Error('unexpected Groq call');
};
configureAsk({ apiKey: 'test-key', model: 'test-model', fetchImpl });
test.beforeEach(() => {
  resetModelPause();
  classifyAs = null;
  composeWith = () => ({ summary: 'Here is what the records show.' });
});

const ask = (c, body, opts) => c.post('/api/orchestrator/ask', body, opts);
const entriesOf = (requestId) => AuditEvent.find({ subjectKind: 'orchestrator', subjectId: requestId }).sort({ at: 1, _id: 1 }).lean();

test('signed out 401, no role 403, a request without the CSRF header 403, bad bodies 400', async () => {
  assert.equal((await ask(t.client(), { question: 'List all unpaid invoices' })).status, 401);
  assert.equal((await ask(noRole, { question: 'List all unpaid invoices' })).status, 403);
  assert.equal((await ask(reviewer, { question: 'List all unpaid invoices' }, { csrf: false })).status, 403);
  for (const body of [
    {},
    { question: '' },
    { question: '   ' },
    { question: 'x'.repeat(501) },
    { question: 42 },
    { question: 'a', choice: 'o_aaaaaaaaaaaaaaaaaaaaaa', threadId: 't_aaaaaaaaaaaaaaaaaaaaaa' },
    { choice: 'o_aaaaaaaaaaaaaaaaaaaaaa' },
    { question: 'a', extra: 1 },
    { question: 'a', threadId: 'bad id!' },
  ]) {
    const r = await ask(reviewer, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.data.error, 'string');
  }
});

test('forged actor fields in the body are ignored: the person is the session', async () => {
  const forged = {
    question: 'List all unpaid invoices',
    actor: { id: 'x', name: 'Ada Admin', roles: ['admin'] },
    actorId: String(t.users.admin.id),
    userId: 'x',
    roles: ['admin'],
    decidedBy: 'Mallory',
  };
  const r = ok(await ask(reviewer, forged));
  assert.equal(r.status, 'answered');
  const entries = await entriesOf(r.requestId);
  assert.ok(entries.length >= 3);
  assert.ok(entries.every((e) => e.actor === PEOPLE.reviewer.name && e.actorId === String(t.users.reviewer.id)));
  // A role in the body grants nothing.
  const ing = ok(await ask(reviewer, { question: 'Is the mailbox import working?', roles: ['admin'] }));
  assert.equal(ing.status, 'not_permitted');
  assert.deepEqual(ing.trace.toolCalls, []);
});

test('a confident router: no model call; a list intent: no model call either', async () => {
  const before = sent.length;
  const r = ok(await ask(approver, { question: 'Show me all invoices waiting for approval.' }));
  assert.equal(r.status, 'answered');
  assert.equal(r.intent, 'list_pending_invoices');
  assert.equal(r.trace.classifiedBy, 'rules');
  assert.deepEqual(r.trace.modelCalls, []);
  assert.equal(sent.length, before);
  assert.equal(r.explanation.label, 'From records');
  assert.equal(r.explanation.fallback, null);
});

test('the model path: classify sees the question; compose sees neither the question nor ids nor bank fields', async () => {
  // A question the router leaves to the model.
  classifyAs = (u) => (u.question === 'tell me about cps-0388 please' ? { intent: 'explain_invoice_status', args: { invoiceRef: 'cps-0388' }, clarity: 'clear' } : null);
  assert.equal(route('tell me about cps-0388 please').confident, false);
  const before = sent.length;
  const r = ok(await ask(reviewer, { question: 'tell me about cps-0388 please' }));
  assert.equal(r.status, 'answered');
  assert.equal(r.trace.classifiedBy, 'model');
  assert.deepEqual(
    r.trace.modelCalls.map((c) => c.purpose),
    ['classify', 'compose'],
  );
  const [cls, cmp] = sent.slice(before);
  assert.deepEqual(JSON.parse(cls.messages[1].content), { question: 'tell me about cps-0388 please' });
  const composed = cmp.messages[1].content;
  assert.ok(!composed.includes('tell me about'), 'compose never sees the question');
  assert.ok(!/[a-f0-9]{24}/.test(composed) && !/"bank"|bsb|•/i.test(composed));
  assert.equal(r.explanation.label, 'AI explanation');
  assert.equal(r.explanation.summary, 'Here is what the records show.');
  assert.equal(r.facts[0].invoiceNumber, 'CPS-0388');
});

test('reviewer masking reaches the model input: no bank details in any request body for any role', async () => {
  for (const key of ['reviewer', 'approver', 'payer', 'admin']) {
    for (const question of ['Has HOS-10482 been paid yet?', "What's blocking the payment run?", 'Show me suppliers with unpaid invoices.', 'Why is HOS-10517 on hold?']) {
      const before = sent.length;
      const r = ok(await ask(signed[key], { question }));
      assert.ok(['answered', 'partial'].includes(r.status), `${key} ${question}: ${r.status}`);
      const bodies = sent
        .slice(before)
        .map((b) => b.messages[1].content)
        .join('\n');
      for (const v of FULL) assert.doesNotMatch(bodies, whole(v), `${key} ${question}: a full bank value`);
      assert.ok(!/"bank"|bsb|accountNumber|•/i.test(bodies), `${key} ${question}: a bank field`);
      if (key === 'reviewer') assert.ok(!JSON.stringify(r).includes('•') && !/"bank"/.test(JSON.stringify(r)), 'the reviewer response has no bank field');
    }
  }
});

test('a follow-up in a thread resolves "this invoice"; without a thread it asks back', async () => {
  const first = ok(await ask(reviewer, { question: 'Find invoice HOS-10517' }));
  assert.equal(first.status, 'answered');
  assert.match(first.threadId, /^t_/);
  const follow = ok(await ask(reviewer, { question: 'Why is this invoice on hold?', threadId: first.threadId }));
  assert.equal(follow.status, 'answered');
  assert.equal(follow.intent, 'explain_invoice_status');
  assert.equal(follow.facts[0].id, held);
  assert.equal(follow.threadId, first.threadId);

  const alone = ok(await ask(reviewer, { question: 'Why is this invoice on hold?' }));
  assert.equal(alone.status, 'needs_clarification');
  assert.match(alone.clarification.question, /Which invoice/);
  assert.ok(alone.clarification.options.length >= 1, 'the invoices on hold are offered');
  assert.ok(alone.clarification.options.every((o) => /^o_/.test(o.optionId) && o.label));
  const chosen = ok(await ask(reviewer, { threadId: alone.threadId, choice: alone.clarification.options[0].optionId }));
  assert.equal(chosen.status, 'answered');
  assert.equal(chosen.trace.classifiedBy, 'choice');
  assert.equal(chosen.facts[0].id, held);
  assert.equal((await ask(reviewer, { threadId: alone.threadId, choice: alone.clarification.options[0].optionId })).status, 404, 'an option is used once');
});

test('ambiguous or unknown questions ask back; nothing runs until the person chooses', async () => {
  const before = await AuditEvent.countDocuments({ action: 'tool_called' });
  const acme = ok(await ask(approver, { question: "what's wrong with the Acme stuff?" }));
  assert.equal(acme.status, 'needs_clarification');
  assert.ok(acme.clarification.options.length >= 1);
  const weather = ok(await ask(approver, { question: "What's the weather in Sydney?" }));
  assert.equal(weather.status, 'needs_clarification');
  assert.match(weather.clarification.question, /cannot change anything/);
  const approve = ok(await ask(approver, { question: 'Approve all invoices from Bluegum now' }));
  assert.equal(approve.status, 'needs_clarification', 'a request to act is never carried out');
  assert.ok((await AuditEvent.countDocuments({ action: 'tool_called' })) - before <= 3, 'at most a lookup for the options');
  // Classification unavailable: the menu, with the reason.
  classifyAs = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '5' }), json: async () => ({}) });
  const limited = ok(await ask(approver, { question: 'something the router cannot place' }));
  assert.equal(limited.status, 'needs_clarification');
  assert.equal(limited.fallback, 'rate_limit');
  assert.ok(limited.clarification.options.length >= 5);
  const menu = ok(await ask(approver, { threadId: limited.threadId, choice: limited.clarification.options[1].optionId }));
  assert.equal(menu.status, 'answered');
  assert.equal(menu.intent, 'list_unpaid_invoices');
});

test('threads are owner only (administrators included) and end after 24 h', async () => {
  const mine = ok(await ask(reviewer, { question: 'Find invoice HOS-10517' }));
  for (const other of [approver, signed.admin]) {
    assert.equal((await ask(other, { question: 'Why is this invoice on hold?', threadId: mine.threadId })).status, 404);
    assert.equal((await other.get(`/api/orchestrator/threads/${mine.threadId}`)).status, 404);
    assert.equal((await other.call('DELETE', `/api/orchestrator/threads/${mine.threadId}`)).status, 404);
  }
  const view = ok(await reviewer.get(`/api/orchestrator/threads/${mine.threadId}`));
  assert.deepEqual(view.turns.at(-1), { at: view.turns.at(-1).at, intent: 'find_invoice', records: [{ kind: 'invoice', id: held }] });
  assert.ok(!JSON.stringify(view).includes('HOS-10517'), 'ids only');
  await OrchestratorThread.updateOne({ _id: mine.threadId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await ask(reviewer, { question: 'Why is this invoice on hold?', threadId: mine.threadId })).status, 404, 'expired');
  const fresh = ok(await ask(reviewer, { question: 'Find invoice HOS-10517' }));
  assert.equal((await reviewer.call('DELETE', `/api/orchestrator/threads/${fresh.threadId}`)).status, 204);
  assert.equal((await reviewer.get(`/api/orchestrator/threads/${fresh.threadId}`)).status, 404);
});

test('each question is audited under one request id: received, tool calls, model calls, answered; never the question', async () => {
  classifyAs = (u) => (u.question === 'what is the story with hos-10517' ? { intent: 'explain_invoice_status', args: { invoiceRef: 'hos-10517' }, clarity: 'clear' } : null);
  assert.equal(route('what is the story with hos-10517').confident, false);
  const r = ok(await ask(approver, { question: 'what is the story with hos-10517' }));
  const entries = await entriesOf(r.requestId);
  const actions = entries.map((e) => e.action);
  assert.equal(actions[0], 'question_received');
  assert.equal(actions.at(-1), 'question_answered');
  assert.equal(actions.filter((a) => a === 'model_called').length, 2);
  assert.equal(actions.filter((a) => a === 'tool_called').length, r.trace.toolCalls.length);
  const answered = JSON.parse(entries.at(-1).detail);
  assert.deepEqual([answered.intent, answered.classifiedBy, answered.status, answered.answerSource], ['explain_invoice_status', 'model', 'answered', 'model']);
  for (const e of entries) for (const leak of ['story with', 'Harbour', '2,890', '2890', 'Here is what']) assert.ok(!String(e.detail).includes(leak), `${e.action}: ${leak}`);
});

test('every fixture question, as every role: at most 8 tool calls and 2 model calls, and no record changes', async () => {
  const snapshot = async () => {
    const out = {};
    for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
      if (['auditevents', 'orchestratorthreads', 'sessions'].includes(name)) continue;
      out[name] = JSON.stringify(await mongoose.connection.db.collection(name).find().sort({ _id: 1 }).toArray());
    }
    return out;
  };
  const before = await snapshot();
  const threadOf = {};
  for (const key of ['reviewer', 'approver', 'payer', 'admin', 'approverPayer']) {
    // A thread with one invoice, for the follow-up questions.
    threadOf[key] = ok(await ask(signed[key], { question: 'Find invoice HOS-10517' })).threadId;
    for (const f of FIXTURES) {
      const r = ok(await ask(signed[key], { question: f.question, ...(f.thread ? { threadId: threadOf[key] } : {}) }));
      assert.ok(r.trace.toolCalls.length <= 8, `${key} ${f.id}: ${r.trace.toolCalls.length} tool calls`);
      assert.ok(r.trace.modelCalls.length <= 2, `${key} ${f.id}`);
      if (r.trace.classifiedBy === 'rules') assert.ok(r.trace.modelCalls.length <= 1);
      if (f.expect.intent && !f.expect.clarify && f.expect.intent !== 'unknown') assert.equal(r.intent, f.expect.intent, `${key} ${f.id}`);
      if (f.expect.intent === 'unknown' || f.expect.clarify) assert.ok(['needs_clarification', 'not_found'].includes(r.status), `${key} ${f.id}: ${r.status}`);
    }
  }
  assert.deepEqual(await snapshot(), before, 'only the audit log and the threads changed');
});
