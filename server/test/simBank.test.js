// The simulated bank on a real MongoDB: deterministic scenarios, delayed
// completion, the balance (with atomic reservations), idempotency and
// duplicate submissions. No real bank is contacted.

import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startTestDatabase, buildIndexes } from '../test-support/mongo.js';
import { createSimBank } from '../src/bank/simBank.js';
import { createSimBankAdapter, withTimeout, BankUnavailable, BankError } from '../src/bank/adapter.js';
import { SimBankTransaction, SimBankAccount, SimBankScenario, SimBankAttempt } from '../src/models/index.js';

const db = await startTestDatabase();
await mongoose.connect(db.uri);
await buildIndexes();
test.after(() => db.stop());

const bank = createSimBank({ delaySeconds: 20, delayedSeconds: 600, openingBalance: 1000, bsbPrefix: '999', temporaryFailures: 1 });
const T0 = new Date('2026-10-22T23:00:00Z');
const at = (s) => new Date(T0.getTime() + s * 1000);
const EFT = { accountName: 'Harbour (SIM)', bsb: '999-001', accountNumber: '10482001' };
let n = 0;
const pay = (over = {}) => ({
  idempotencyKey: `k-${(n += 1)}`,
  amount: 100,
  currency: 'AUD',
  method: 'EFT',
  beneficiary: EFT,
  reference: 'INV-1',
  payee: { abn: '57600410275', name: 'Harbour' },
  ...over,
});

async function reset(balance = 1000) {
  await Promise.all([SimBankTransaction.deleteMany({}), SimBankScenario.deleteMany({}), SimBankAttempt.deleteMany({}), SimBankAccount.deleteMany({})]);
  await bank.accountView();
  await bank.setBalance(balance);
}

test('success: accepted as PROCESSING, completes only when due, and the balance falls by the amount', async () => {
  await reset();
  const t = await bank.submitPayment(pay({ amount: 250.5 }), { now: T0 });
  assert.equal(t.status, 'PROCESSING');
  assert.equal(t.simulated, true);
  assert.match(t.ref, /^SIMTXN-20261022-[0-9A-F]{10}$/);
  assert.equal(t.completesAt.toISOString(), at(20).toISOString());
  assert.equal(t.beneficiary.accountNumber, '•••001', 'stored masked');
  assert.deepEqual(await bank.accountView().then((a) => [a.balance, a.reserved, a.available]), [1000, 250.5, 749.5]);

  assert.equal(await bank.settle({ now: at(19) }), 0, 'not yet');
  assert.equal((await bank.getTransaction(t.ref)).status, 'PROCESSING');
  assert.equal(await bank.settle({ now: at(20) }), 1);
  const done = await bank.getTransaction(t.ref);
  assert.equal(done.status, 'SUCCESS');
  assert.equal(done.settledAt.toISOString(), at(20).toISOString());
  assert.deepEqual(await bank.accountView().then((a) => [a.balance, a.reserved]), [749.5, 0]);
});

test('settling is safe to run twice at once: each transaction completes once', async () => {
  await reset();
  for (let i = 0; i < 5; i += 1) await bank.submitPayment(pay({ amount: 10 }), { now: T0 });
  const counts = await Promise.all([bank.settle({ now: at(30) }), bank.settle({ now: at(30) }), bank.settle({ now: at(30) })]);
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    5,
  );
  assert.deepEqual(await bank.accountView().then((a) => [a.balance, a.reserved]), [950, 0]);
});

test('duplicate submissions: the same key returns the same transaction; a different payment under it is refused', async () => {
  await reset();
  const first = await bank.submitPayment(pay({ idempotencyKey: 'dup-1' }), { now: T0 });
  const again = await bank.submitPayment(pay({ idempotencyKey: 'dup-1' }), { now: at(5) });
  assert.equal(again.ref, first.ref);
  assert.equal(again.duplicate, true);
  await assert.rejects(bank.submitPayment(pay({ idempotencyKey: 'dup-1', amount: 101 }), { now: T0 }), (err) => err.code === 'idempotency_conflict' && err.status === 409);
  // Five at once with one key: one transaction, one reservation.
  const many = await Promise.all(Array.from({ length: 5 }, () => bank.submitPayment(pay({ idempotencyKey: 'dup-2' }), { now: T0 })));
  assert.equal(new Set(many.map((t) => t.ref)).size, 1);
  assert.equal(many.filter((t) => !t.duplicate).length, 1);
  assert.equal(await SimBankTransaction.countDocuments({ idempotencyKey: 'dup-2' }), 1);
  assert.equal((await bank.accountView()).reserved, 200, 'dup-1 and dup-2 reserved once each');
});

test('insufficient funds: more than the available balance is rejected; reservations are atomic', async () => {
  await reset(100);
  const big = await bank.submitPayment(pay({ amount: 150 }), { now: T0 });
  assert.equal(big.status, 'REJECTED');
  assert.equal(big.failureCode, 'insufficient_funds');
  const pair = await Promise.all([bank.submitPayment(pay({ amount: 60 }), { now: T0 }), bank.submitPayment(pay({ amount: 60 }), { now: T0 })]);
  assert.deepEqual(pair.map((t) => t.status).sort(), ['PROCESSING', 'REJECTED'], 'never overdrawn by two at once');
  const a = await bank.accountView();
  assert.equal(a.reserved, 60);
  assert.ok(a.available >= 0);
});

test('scenarios, chosen per supplier: rejection, invalid beneficiary, unsupported method, delayed, failure at settlement', async () => {
  await reset();
  const abn = '37600518342';
  const as = (scenario) => bank.setScenario(abn, scenario, { name: 'Ada Admin', id: 'u-admin' });
  const p = (over) => pay({ payee: { abn, name: 'Pallets' }, ...over });

  await as('rejection');
  assert.equal((await bank.submitPayment(p(), { now: T0 })).failureCode, 'rejected_by_bank');
  await as('invalid_beneficiary');
  assert.equal((await bank.submitPayment(p(), { now: T0 })).failureCode, 'invalid_beneficiary');
  await as('unsupported_method');
  assert.equal((await bank.submitPayment(p(), { now: T0 })).failureCode, 'unsupported_method');
  assert.equal((await bank.accountView()).reserved, 0, 'rejections reserve nothing');

  await as('delayed');
  const slow = await bank.submitPayment(p(), { now: T0 });
  assert.equal(slow.completesAt.toISOString(), at(600).toISOString());
  await bank.settle({ now: at(300) });
  assert.equal((await bank.getTransaction(slow.ref)).status, 'PROCESSING', 'still processing after 5 minutes');
  await bank.settle({ now: at(600) });
  assert.equal((await bank.getTransaction(slow.ref)).status, 'SUCCESS');

  await as('settle_failure');
  const fails = await bank.submitPayment(p({ amount: 40 }), { now: T0 });
  assert.equal(fails.status, 'PROCESSING', 'accepted first');
  const before = await bank.accountView();
  await bank.settle({ now: at(20) });
  const failed = await bank.getTransaction(fails.ref);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failureCode, 'settlement_failed');
  const after = await bank.accountView();
  assert.equal(after.balance, before.balance, 'a failed payment does not reduce the balance');
  assert.equal(after.reserved, before.reserved - 40, 'its reservation is released');

  // Other suppliers are unaffected.
  assert.equal((await bank.submitPayment(pay(), { now: T0 })).status, 'PROCESSING');
  await assert.rejects(as('random'), /Choose one of/);
});

test('temporary failure: the first attempt is refused (nothing stored); a retry with the same key is accepted', async () => {
  await reset();
  const abn = '36600733916';
  await bank.setScenario(abn, 'temporary_failure', null);
  const instruction = pay({ idempotencyKey: 'tmp-1', payee: { abn, name: 'Bluegum' } });
  await assert.rejects(bank.submitPayment(instruction, { now: T0 }), (err) => err.retryable === true && err.status === 503);
  assert.equal(await SimBankTransaction.countDocuments({ idempotencyKey: 'tmp-1' }), 0);
  const ok = await bank.submitPayment(instruction, { now: at(60) });
  assert.equal(ok.status, 'PROCESSING');
});

test('only simulated details: a real-looking BSB, a method the details lack, or another currency is rejected', async () => {
  await reset();
  assert.equal((await bank.submitPayment(pay({ beneficiary: { ...EFT, bsb: '062-000' } }), { now: T0 })).failureCode, 'invalid_beneficiary');
  assert.equal((await bank.submitPayment(pay({ method: 'BPAY' }), { now: T0 })).failureCode, 'invalid_beneficiary');
  assert.equal((await bank.submitPayment(pay({ method: 'Cheque' }), { now: T0 })).failureCode, 'unsupported_method');
  assert.equal((await bank.submitPayment(pay({ currency: 'USD' }), { now: T0 })).failureCode, 'unsupported_currency');
  await assert.rejects(bank.submitPayment(pay({ idempotencyKey: '' }), { now: T0 }), /Idempotency-Key/);
  await assert.rejects(bank.submitPayment(pay({ amount: 10.001 }), { now: T0 }), /dollars and cents/);
});

test('the statement export lists settled payments with their reference, money out negative', async () => {
  await reset();
  const t = await bank.submitPayment(pay({ amount: 12.34, reference: 'HOS-10482' }), { now: T0 });
  await bank.settle({ now: at(20) });
  const csv = await bank.statementCsv();
  const [header, line] = csv.split('\n');
  assert.equal(header, 'Date,Description,Amount');
  assert.match(line, new RegExp(`^2026-10-22,"SIM BANK ${t.ref} Harbour HOS-10482",-12.34$`));
});

test('the adapter: accepted, rejected, duplicate, retryable and not retryable', async () => {
  await reset();
  const adapter = createSimBankAdapter({ simBank: bank, timeoutMs: 2000 });
  const ok = await adapter.submitPayment(pay({ idempotencyKey: 'ad-1' }), { now: T0 });
  assert.equal(ok.outcome, 'accepted');
  assert.equal((await adapter.submitPayment(pay({ idempotencyKey: 'ad-1' }), { now: T0 })).duplicate, true);
  assert.equal((await adapter.getPayment({ idempotencyKey: 'ad-1' })).ref, ok.ref);
  assert.deepEqual(await adapter.getPayment({ ref: 'SIMTXN-NOPE' }), { found: false });
  const no = await adapter.submitPayment(pay({ amount: 5000 }), { now: T0 });
  assert.equal(no.outcome, 'rejected');
  assert.equal(no.code, 'insufficient_funds');
  await assert.rejects(adapter.submitPayment(pay({ idempotencyKey: 'ad-1', amount: 1 }), { now: T0 }), (err) => err instanceof BankError && !err.retryable);
  await bank.setScenario('57600410275', 'temporary_failure', null);
  await assert.rejects(adapter.submitPayment(pay({ idempotencyKey: 'ad-2' }), { now: T0 }), (err) => err instanceof BankUnavailable && err.retryable);
  // A bank that does not answer in time: "unknown", retryable, never success.
  await assert.rejects(withTimeout(new Promise(() => {}), 50), (err) => err instanceof BankUnavailable && err.timeout);
});
