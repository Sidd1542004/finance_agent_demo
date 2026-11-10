// Conversation threads (src/orchestrator/threads.js; docs/phase2-design.md
// §10): owner only (administrators included), 24 h, intents and ids only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PEOPLE } from '../test-support/app.js';
import { person } from '../test-support/actors.js';

const t = await startApp();
test.after(t.stop);

const threads = await import('../src/orchestrator/threads.js');
const { OrchestratorThread } = await import('../src/models/index.js');
const { DEMO_DATA_MODELS } = await import('../src/seed/seed.js');
const { systemActor } = await import('../src/auth/roles.js');

const A = person(PEOPLE.reviewer.name, PEOPLE.reviewer.roles);
const B = person(PEOPLE.payer.name, PEOPLE.payer.roles);
const ADMIN = person(PEOPLE.admin.name, PEOPLE.admin.roles);
const INVOICE = { kind: 'invoice', id: '6ae72014e574214a187cd9e8' };

test("a thread is only its owner's: anyone else, administrators included, finds nothing", async () => {
  const id = await threads.saveTurn(A, null, { intent: 'find_invoice', records: [INVOICE] });
  assert.match(id, threads.THREAD_ID);
  assert.equal((await threads.loadThread(A, id))._id, id);
  for (const other of [B, ADMIN]) {
    assert.equal(await threads.loadThread(other, id), null);
    assert.equal(await threads.deleteThread(other, id), false);
  }
  // Someone else's turn cannot be added to it either.
  await threads.saveTurn(B, { _id: id }, { intent: 'list_unpaid_invoices', records: [] });
  assert.deepEqual(
    (await threads.loadThread(A, id)).turns.map((x) => x.intent),
    ['find_invoice'],
  );
  assert.deepEqual(threads.previousTurn(await threads.loadThread(A, id)), { intent: 'find_invoice', records: [INVOICE] });
  assert.equal(await threads.deleteThread(A, id), true);
  assert.equal(await threads.loadThread(A, id), null);
});

test('threads end 24 h after they start, exactly, before the TTL monitor deletes them', async () => {
  const start = new Date('2026-11-01T00:00:00Z');
  const id = await threads.saveTurn(A, null, { intent: 'find_invoice', records: [INVOICE] }, start);
  const doc = await OrchestratorThread.findById(id).lean();
  assert.equal(doc.expiresAt.getTime() - start.getTime(), threads.THREAD_TTL_MS);
  assert.ok(await threads.loadThread(A, id, new Date(start.getTime() + threads.THREAD_TTL_MS - 1000)));
  assert.equal(await threads.loadThread(A, id, new Date(start.getTime() + threads.THREAD_TTL_MS)), null, 'expired');
  // A later turn does not extend it.
  const live = await threads.loadThread(A, id, new Date(start.getTime() + 3600000));
  await threads.saveTurn(A, live, { intent: 'record_history', records: [] }, new Date(start.getTime() + 3600000));
  assert.equal((await OrchestratorThread.findById(id).lean()).expiresAt.getTime(), doc.expiresAt.getTime());
  // The TTL index that deletes expired threads.
  await OrchestratorThread.init();
  const ttl = (await OrchestratorThread.collection.indexes()).find((i) => i.key.expiresAt === 1);
  assert.equal(ttl.expireAfterSeconds, 0);
});

test('a thread holds intents, record ids and options only: never text, names or amounts', async () => {
  const { stored, shown } = threads.makeOptions([
    { intent: 'explain_invoice_status', args: { invoiceRef: 'SCP-7731', thisRecord: true }, records: [INVOICE], label: 'SCP-7731, Southern Cross Pallets Pty Ltd' },
    { intent: 'list_pending_invoices', args: { stage: 'on_hold' }, records: [], label: 'Invoices on hold' },
  ]);
  assert.deepEqual(
    shown.map((o) => o.label),
    ['SCP-7731, Southern Cross Pallets Pty Ltd', 'Invoices on hold'],
  );
  const id = await threads.saveTurn(A, null, {
    intent: 'supplier_summary',
    records: [{ kind: 'supplier', id: '57600410275' }, { kind: 'note', id: 'x' }, INVOICE],
    options: stored,
  });
  const doc = await OrchestratorThread.findById(id).lean();
  assert.deepEqual(Object.keys(doc).sort(), ['__v', '_id', 'createdAt', 'expiresAt', 'options', 'ownerId', 'turns', 'updatedAt']);
  assert.deepEqual(Object.keys(doc.turns[0]).sort(), ['at', 'intent', 'records']);
  assert.deepEqual(doc.turns[0].records, [{ kind: 'supplier', id: '57600410275' }, INVOICE], 'only record kinds are kept');
  assert.deepEqual(doc.options[0], { optionId: shown[0].optionId, intent: 'explain_invoice_status', args: { thisRecord: true }, records: [INVOICE] }, 'no typed words, no label');
  const json = JSON.stringify(doc);
  for (const leak of ['SCP-7731', 'Southern Cross', 'Pallets', 'Invoices on hold']) assert.ok(!json.includes(leak), leak);

  // Ten turns at most.
  let thread = await threads.loadThread(A, id);
  for (let i = 0; i < 12; i += 1) {
    await threads.saveTurn(A, thread, { intent: 'list_unpaid_invoices', records: [] });
    thread = await threads.loadThread(A, id);
  }
  assert.equal(thread.turns.length, threads.MAX_TURNS);
});

test('an option is taken once, by its owner, from a live thread', async () => {
  const { stored, shown } = threads.makeOptions([{ intent: 'find_invoice', args: {}, records: [INVOICE], label: 'X' }]);
  const id = await threads.saveTurn(A, null, { intent: 'find_invoice', records: [], options: stored });
  assert.equal(await threads.takeOption(B, id, shown[0].optionId), null, 'not theirs');
  assert.equal(await threads.takeOption(A, id, 'o_madeupmadeupmadeupmade'), null);
  assert.deepEqual(await threads.takeOption(A, id, shown[0].optionId), { intent: 'find_invoice', args: {}, records: [INVOICE] });
  assert.equal(await threads.takeOption(A, id, shown[0].optionId), null, 'already used');
});

test('malformed ids and system actors get nothing', async () => {
  for (const bad of ['', 'x', '{"$gt":""}', 't_short', null, 42]) assert.equal(await threads.loadThread(A, bad), null, String(bad));
  const script = systemActor({ id: 'script:x', name: 'A script', roles: ['admin'] });
  assert.equal(await threads.saveTurn(script, null, { intent: 'find_invoice', records: [] }), null);
  assert.equal(await threads.loadThread(script, 't_aaaaaaaaaaaaaaaaaaaaaa'), null);
  assert.ok(DEMO_DATA_MODELS.includes(OrchestratorThread), 'Reset clears threads');
});
