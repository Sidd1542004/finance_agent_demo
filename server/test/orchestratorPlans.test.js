// Resolution, plans and the executor (src/orchestrator/resolve.js, plans.js,
// execute.js; docs/phase2-design.md §3.3 to §3.5), on a test database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PEOPLE } from '../test-support/app.js';
import { person } from '../test-support/actors.js';

const t = await startApp({ BUSINESS_DAYS: 'Mon-Sun', PAYMENT_CUTOFF: '23:59', PAYMENT_DEFAULT_TIME: '00:00', BANK_HOLIDAYS: '2000-01-01', SIM_BANK_DELAY_SECONDS: '0' });
test.after(t.stop);

const { createToolContext } = await import('../src/orchestrator/context.js');
const { createExecutor, LIMITS } = await import('../src/orchestrator/execute.js');
const { resolveInvoice, resolveSupplier, resolveThis, resolveRecord } = await import('../src/orchestrator/resolve.js');
const { PLANS, planFor, planCalls, runPlan } = await import('../src/orchestrator/plans.js');
const { TOOL_NAMES } = await import('../src/orchestrator/tools.js');
const { INTENTS } = await import('../src/orchestrator/intents.js');
const { ingestion } = await import('../src/services/ingestion.js');
const { withDeadline } = await import('../src/llm/deadline.js');
const { AuditEvent, Payment } = await import('../src/models/index.js');

const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.data));
  return res.data;
};
const reviewer = await t.signIn('reviewer');
const approver = await t.signIn('approver');
const payer = await t.signIn('payer');
const add = async (sampleId) => String(ok(await reviewer.post('/api/invoices', { sampleId }), 201).invoice._id);
const paid = await add('clean'); // HOS-10482
const paidAgain = await add('clean'); // the same number again
const priceVariance = await add('price-variance'); // HOS-10517
await add('unknown-supplier');
ok(await approver.post(`/api/invoices/${paid}/actions/approve`, { note: 'Checked.' }));
const { nextSlot } = ok(await payer.get('/api/payment-calendar'));
ok(await payer.post(`/api/invoices/${paid}/actions/schedule_payment`, { method: 'EFT', scheduledFor: nextSlot.date, scheduledTime: nextSlot.time }));
await t.client().get('/api/cron/tick', { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
const paymentId = String((await Payment.findOne({ invoiceId: paid }).lean())._id);
ok(await payer.post('/api/statements', { sampleId: 'october' }), 201);

const HARBOUR = '57600410275';
const actorFor = (key) => person(PEOPLE[key].name, PEOPLE[key].roles);
let n = 0;
const execFor = (key = 'admin', limits) => createExecutor(createToolContext({ actor: actorFor(key), runId: `plan-${++n}` }), limits);
const audited = (exec) => AuditEvent.countDocuments({ subjectKind: 'orchestrator', subjectId: exec.ctx.runId });

test('every plan names registered tools only, and fits under the 8-call cap with its resolution', () => {
  for (const [name, steps] of Object.entries(PLANS)) {
    for (const s of steps) assert.ok(TOOL_NAMES.includes(s.tool), `${name}: ${s.tool}`);
    // At most 2 calls for resolution (a lookup, then a confirming read).
    assert.ok(planCalls(steps) + 2 <= LIMITS.maxCalls, `${name}: ${planCalls(steps)} calls`);
  }
  for (const intent of INTENTS) assert.ok(Array.isArray(planFor(intent, { invoiceId: 'x' })), intent);
  assert.equal(planFor('payment_status', { invoiceId: 'x' }), PLANS.payment_status_invoice);
  assert.equal(planFor('payment_status', {}), PLANS.payment_status_blockers);
  assert.equal(planFor('toString'), PLANS.unknown, 'no dispatch on an arbitrary name');
  assert.equal(planFor('approve_invoice'), PLANS.unknown);
});

test('the executor: no repeats, at most 8 calls, and failures as results', async () => {
  const exec = execFor('reviewer');
  const a = await exec.run('list_suppliers', {});
  const b = await exec.run('list_suppliers', {});
  assert.equal(a, b, 'the same result object');
  const x = await exec.run('list_open_invoices', { stage: 'review', abn: HARBOUR });
  const y = await exec.run('list_open_invoices', { abn: HARBOUR, stage: 'review' });
  assert.equal(x, y, 'argument order does not matter');
  assert.equal(exec.calls, 2);
  assert.equal(await audited(exec), 2, 'one audit entry per call actually made');

  const capped = execFor('reviewer');
  const results = [];
  for (let i = 1; i <= 9; i += 1) results.push(await capped.run('find_invoices', { invoiceNumber: `NONE-${i}` }));
  assert.ok(results.slice(0, 8).every((r) => r.ok));
  assert.deepEqual(results[8], { ok: false, code: 'limit' });
  assert.equal(capped.calls, 8);
  assert.equal(await audited(capped), 8);

  const f = execFor('reviewer');
  assert.deepEqual(await f.run('get_invoice', { invoiceId: '0123456789abcdef01234567' }), { ok: false, code: 'not_found' });
  assert.deepEqual(await f.run('get_invoice', { invoiceId: 'not-an-id' }), { ok: false, code: 'invalid' });
  assert.deepEqual(await f.run('sim_bank_account', {}), { ok: false, code: 'not_permitted' });
  assert.deepEqual(await f.run('no_such_tool', {}), { ok: false, code: 'not_found' });
  assert.deepEqual(
    f.trace().map((c) => [c.tool, c.ok, c.code]),
    [
      ['get_invoice', false, 'not_found'],
      ['get_invoice', false, 'invalid'],
      ['sim_bank_account', false, 'not_permitted'],
      ['no_such_tool', false, 'not_found'],
    ],
  );
});

test('the executor: a slow tool times out; with too little budget left nothing starts', async () => {
  const service = ingestion();
  const original = service.status;
  service.status = () => new Promise((resolve) => setTimeout(() => resolve({ providers: [], settings: {} }), 300));
  try {
    const slow = execFor('admin', { ...LIMITS, stepMs: 50 });
    assert.deepEqual(await slow.run('ingestion_status', {}), { ok: false, code: 'timeout' });
  } finally {
    service.status = original;
  }
  const late = execFor('admin');
  const r = await withDeadline(Date.now() + 3000, () => late.run('list_suppliers', {}));
  assert.deepEqual(r, { ok: false, code: 'timeout' });
  assert.equal(late.calls, 0);
  assert.equal(await audited(late), 0);
});

test('resolution: exactly one record, or the options, or none; never a guess', async () => {
  const one = await resolveInvoice(execFor(), 'hos 10517');
  assert.deepEqual(one, { status: 'one', record: { kind: 'invoice', id: priceVariance }, label: 'HOS-10517, Harbour Office Supplies Pty Ltd' });
  const several = await resolveInvoice(execFor(), 'HOS-10482');
  assert.equal(several.status, 'several');
  assert.deepEqual(several.options.map((o) => o.record.id).sort(), [paid, paidAgain].sort());
  assert.deepEqual(await resolveInvoice(execFor(), 'HOS-99999'), { status: 'none' });

  assert.deepEqual(await resolveSupplier(execFor(), 'Harbour Office Supplies'), {
    status: 'one',
    record: { kind: 'supplier', id: HARBOUR },
    label: 'Harbour Office Supplies Pty Ltd',
  });
  assert.equal((await resolveSupplier(execFor(), 'harbour')).record.id, HARBOUR, 'a name that starts with it');
  assert.equal((await resolveSupplier(execFor(), '57 600 410 275')).record.id, HARBOUR, 'an ABN');
  assert.deepEqual(await resolveSupplier(execFor(), 'Acme'), { status: 'none' });
  assert.deepEqual(await resolveSupplier(execFor(), 'pt'), { status: 'none' }, 'too short to match on');

  assert.equal((await resolveRecord(execFor(), 'HOS-10517')).record.kind, 'invoice');
  assert.equal((await resolveRecord(execFor(), 'Harbour Office')).record.kind, 'supplier');

  const previous = { intent: 'find_invoice', records: [{ kind: 'invoice', id: priceVariance }] };
  assert.equal((await resolveThis(execFor('reviewer'), previous)).record.id, priceVariance);
  assert.deepEqual(await resolveThis(execFor(), null), { status: 'none' });
  assert.deepEqual(await resolveThis(execFor(), { records: [{ kind: 'invoice', id: '0123456789abcdef01234567' }] }), { status: 'none' }, 'deleted since');
  assert.equal(
    (
      await resolveThis(execFor(), {
        records: [
          { kind: 'invoice', id: paid },
          { kind: 'invoice', id: paidAgain },
        ],
      })
    ).status,
    'several_unlabelled',
  );
});

test('each intent runs its plan and nothing else; a resolution read is not repeated', async () => {
  const toolsOf = async (intent, resolved, key = 'admin') => {
    const exec = execFor(key);
    const r = await runPlan(exec, planFor(intent, resolved), actorFor(key), resolved);
    return { r, tools: exec.trace().map((c) => c.tool) };
  };
  assert.deepEqual((await toolsOf('list_pending_invoices', {})).tools, ['list_invoices']);
  assert.deepEqual((await toolsOf('find_invoice', { invoiceId: priceVariance })).tools, ['get_invoice']);
  assert.deepEqual((await toolsOf('explain_invoice_status', { invoiceId: priceVariance })).tools, ['get_invoice', 'get_history']);
  assert.deepEqual((await toolsOf('supplier_summary', { abn: HARBOUR })).tools, ['list_suppliers', 'list_open_invoices']);
  assert.deepEqual((await toolsOf('list_unpaid_invoices', {})).tools, ['list_open_invoices', 'get_payables']);
  const pay = await toolsOf('payment_status', { invoiceId: paid });
  assert.deepEqual(pay.tools, ['get_invoice', 'get_payment']);
  assert.equal(pay.r.state.payment.payment.id, paymentId);
  assert.deepEqual((await toolsOf('payment_status', {})).tools, ['list_invoices', 'list_payments', 'list_suppliers', 'sim_bank_account']);
  const recon = await toolsOf('reconciliation_exceptions', {});
  assert.deepEqual(recon.tools, ['list_statements', 'get_statement']);
  assert.ok(recon.r.state.open[0].lines.length);
  assert.deepEqual((await toolsOf('ingestion_status', {})).tools, ['ingestion_status']);
  assert.deepEqual((await toolsOf('record_history', { subjectId: HARBOUR })).tools, ['get_history']);
  assert.deepEqual((await toolsOf('unknown', {})).tools, []);

  // "This invoice": the confirming get_invoice is the plan's first call, made once.
  const exec = execFor('reviewer');
  const previous = { records: [{ kind: 'invoice', id: priceVariance }] };
  await resolveThis(exec, previous);
  await runPlan(exec, planFor('explain_invoice_status', { invoiceId: priceVariance }), actorFor('reviewer'), { invoiceId: priceVariance });
  assert.deepEqual(
    exec.trace().map((c) => c.tool),
    ['get_invoice', 'get_history'],
  );
});

test('roles: a required step the person cannot run is "not permitted" with no call; an optional one is a note', async () => {
  const exec = execFor('reviewer');
  const r = await runPlan(exec, planFor('ingestion_status', {}), actorFor('reviewer'), {});
  assert.equal(r.status, 'not_permitted');
  assert.deepEqual(r.roles, ['admin']);
  assert.equal(exec.calls, 0);

  const blockers = execFor('reviewer');
  const b = await runPlan(blockers, planFor('payment_status', {}), actorFor('reviewer'), {});
  assert.equal(b.status, 'answered');
  assert.deepEqual(b.notes, [{ step: 'account', code: 'role', roles: ['payer', 'approver', 'admin'] }]);
  assert.ok(!blockers.trace().some((c) => c.tool === 'sim_bank_account'));
});

test('partial answers: a required step failing stops the plan; an optional one is reported and the rest goes on', async () => {
  const gone = execFor();
  const missing = await runPlan(gone, planFor('explain_invoice_status', { invoiceId: '0123456789abcdef01234567' }), actorFor('admin'), { invoiceId: '0123456789abcdef01234567' });
  assert.equal(missing.status, 'partial');
  assert.deepEqual(missing.failures, [{ step: 'invoice', tool: 'get_invoice', code: 'not_found', required: true }]);
  assert.equal(gone.calls, 1, 'get_history is not run after the invoice failed');

  // A stand-in executor: the optional step fails, the required ones work.
  const scripted = {
    run: async (tool) => (tool === 'get_payables' ? { ok: false, code: 'unavailable' } : { ok: true, value: { items: [], total: 0 } }),
  };
  const r = await runPlan(scripted, planFor('list_unpaid_invoices', {}), actorFor('admin'), {});
  assert.equal(r.status, 'answered');
  assert.deepEqual(r.failures, [{ step: 'payables', tool: 'get_payables', code: 'unavailable', required: false }]);
  assert.deepEqual(r.state.open, { items: [], total: 0 });
});
