// The SIMULATED bank. It never contacts a real bank and never moves money:
// accounts, balances and transactions are records in MongoDB, every one
// labelled simulated.
//
// It behaves like an asynchronous bank on a serverless host: an accepted
// payment is stored as PROCESSING with a `completesAt` time, and settle()
// (called by the cron tick) moves it to SUCCESS or FAILED once that time has
// passed. Nothing waits in memory.
//
// Outcomes are deterministic: an administrator sets a scenario per supplier
// (by ABN). Never random.
//
//   success              accepted, completes after SIM_BANK_DELAY_SECONDS
//   delayed              accepted, completes after SIM_BANK_DELAYED_SECONDS
//   settle_failure       accepted, then FAILED when it completes
//   rejection            refused at submission (REJECTED)
//   invalid_beneficiary  refused at submission: account not recognised
//   unsupported_method   refused at submission
//   temporary_failure    the first N attempts for each instruction get "temporarily
//                        unavailable" (nothing stored); a retry with the same
//                        idempotency key is then accepted
// Insufficient funds is not a scenario: the simulated account has a balance
// (confirmed payments reduce it), and an instruction for more than what is
// available (balance minus accepted, unsettled payments) is REJECTED.
//
// Duplicates: the same idempotency key with the same instruction returns the
// original transaction (duplicate: true); with a different instruction it is
// refused (idempotency_conflict). A key is never processed twice.

import { createHash, randomBytes } from 'node:crypto';
import { SimBankAccount, SimBankTransaction, SimBankScenario, SimBankAttempt } from '../models/index.js';
import { normaliseDetails, mask, methodsOf } from '../agent/finance/beneficiary.js';
import { cents } from '../agent/finance/rules.js';

export const SCENARIOS = ['success', 'delayed', 'settle_failure', 'rejection', 'invalid_beneficiary', 'unsupported_method', 'temporary_failure'];
export const SIM_METHODS = ['EFT', 'BPAY', 'Card'];
export const SIM_CURRENCIES = ['AUD'];
export const ACCOUNT_ID = 'SIM-OPERATING';

/** A refusal before anything is stored. `retryable`: try again later with the same key. */
export class SimBankError extends Error {
  constructor(code, message, { status = 400, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const round2 = (n) => Math.round(n * 100) / 100;
const canonical = (o) =>
  JSON.stringify(
    Object.keys(o)
      .sort()
      .reduce((acc, k) => ({ ...acc, [k]: o[k] }), {}),
  );

const publicTxn = (t, extra = {}) => ({
  ref: t.ref,
  status: t.status,
  amount: t.amount,
  currency: t.currency,
  method: t.method,
  beneficiary: t.beneficiary,
  reference: t.reference,
  payee: t.payee,
  scenario: t.scenario,
  failureCode: t.failureCode,
  failureMessage: t.failureMessage,
  completesAt: t.completesAt,
  settledAt: t.settledAt,
  createdAt: t.createdAt,
  history: t.history,
  simulated: true,
  ...extra,
});

function newRef(now) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `SIMTXN-${d}-${randomBytes(5).toString('hex').toUpperCase()}`;
}

/**
 * @param delaySeconds        normal completion delay
 * @param delayedSeconds      completion delay in the "delayed" scenario
 * @param openingBalance      the simulated account's starting balance (AUD)
 * @param bsbPrefix           simulated BSBs start with this
 * @param temporaryFailures   attempts refused per key in "temporary_failure"
 */
export function createSimBank({ delaySeconds = 20, delayedSeconds = 600, openingBalance = 250000, bsbPrefix = '999', temporaryFailures = 1 } = {}) {
  async function account() {
    return SimBankAccount.findOneAndUpdate(
      { _id: ACCOUNT_ID },
      {
        $setOnInsert: {
          name: 'Operating account (SIMULATED)',
          bsb: `${bsbPrefix}-000`,
          accountNumber: '00000001',
          currency: 'AUD',
          balance: openingBalance,
          reserved: 0,
          simulated: true,
        },
      },
      { upsert: true, new: true },
    ).lean();
  }

  const scenarioFor = async (abn) => (abn ? (await SimBankScenario.findById(String(abn)).lean())?.scenario : null) || 'success';

  /**
   * Submit a payment instruction.
   *   { idempotencyKey, amount, currency, method, beneficiary: {accountName, bsb, accountNumber, billerCode, crn, cardToken},
   *     reference, payee: { abn, name } }
   * Returns the transaction (PROCESSING or REJECTED), with duplicate: true for a repeat.
   * Throws SimBankError for a malformed request, an idempotency conflict, or a
   * temporary failure (retryable).
   */
  async function submitPayment(instruction, { now = new Date() } = {}) {
    const key = String(instruction?.idempotencyKey || '').trim();
    if (!key || key.length > 200) throw new SimBankError('invalid_request', 'An Idempotency-Key is required.');
    const amount = Number(instruction.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9 || Math.abs(amount * 100 - cents(amount)) > 1e-6) {
      throw new SimBankError('invalid_request', 'The amount must be a positive number of dollars and cents.');
    }
    const request = {
      amount: round2(amount),
      currency: String(instruction.currency || '').toUpperCase(),
      method: String(instruction.method || ''),
      beneficiary: canonical(instruction.beneficiary || {}),
      reference: String(instruction.reference || '').slice(0, 80),
      payee: String(instruction.payee?.abn || ''),
    };
    const requestHash = createHash('sha256').update(canonical(request)).digest('hex');

    // A key seen before: the same transaction again, or a conflict. Never a second payment.
    const existing = await SimBankTransaction.findOne({ idempotencyKey: key }).lean();
    if (existing) {
      if (existing.requestHash !== requestHash) throw new SimBankError('idempotency_conflict', 'This Idempotency-Key was already used for a different payment.', { status: 409 });
      return publicTxn(existing, { duplicate: true });
    }

    const scenario = await scenarioFor(instruction.payee?.abn);
    if (scenario === 'temporary_failure') {
      const attempt = await SimBankAttempt.findOneAndUpdate({ _id: key }, { $inc: { count: 1 } }, { upsert: true, new: true }).lean();
      if (attempt.count <= temporaryFailures)
        throw new SimBankError('temporarily_unavailable', 'The simulated bank is temporarily unavailable. Try again later.', { status: 503, retryable: true });
    }

    // Decide the outcome at submission.
    const { details, problems } = normaliseDetails(instruction.beneficiary || {}, { bsbPrefix });
    let rejected = null;
    if (!SIM_METHODS.includes(request.method) || scenario === 'unsupported_method')
      rejected = ['unsupported_method', `The simulated bank does not accept ${request.method || 'this method'} payments.`];
    else if (!SIM_CURRENCIES.includes(request.currency)) rejected = ['unsupported_currency', `The simulated bank only pays ${SIM_CURRENCIES.join(', ')}.`];
    else if (problems.length || !methodsOf(details).includes(request.method) || scenario === 'invalid_beneficiary')
      rejected = ['invalid_beneficiary', 'The beneficiary account is not valid at the simulated bank.'];
    else if (scenario === 'rejection') rejected = ['rejected_by_bank', 'The simulated bank rejected the payment.'];

    await account();
    let reserved = false;
    if (!rejected) {
      // Reserve the money atomically: only if balance - reserved covers it.
      const ok = await SimBankAccount.findOneAndUpdate(
        { _id: ACCOUNT_ID, $expr: { $gte: [{ $subtract: ['$balance', '$reserved'] }, request.amount] } },
        { $inc: { reserved: request.amount } },
        { new: true },
      ).lean();
      if (ok) reserved = true;
      else rejected = ['insufficient_funds', 'Insufficient funds in the simulated account.'];
    }

    const delay = scenario === 'delayed' ? delayedSeconds : delaySeconds;
    const doc = {
      idempotencyKey: key,
      requestHash,
      accountId: ACCOUNT_ID,
      amount: request.amount,
      currency: request.currency,
      method: request.method,
      beneficiary: mask(details),
      reference: request.reference,
      payee: { abn: instruction.payee?.abn || null, name: instruction.payee?.name || null },
      scenario,
      status: rejected ? 'REJECTED' : 'PROCESSING',
      plannedOutcome: rejected ? null : scenario === 'settle_failure' ? 'FAILED' : 'SUCCESS',
      failureCode: rejected?.[0] ?? null,
      failureMessage: rejected?.[1] ?? null,
      completesAt: rejected ? null : new Date(now.getTime() + delay * 1000),
      settledAt: rejected ? now : null,
      history: [{ at: now.toISOString(), status: rejected ? 'REJECTED' : 'PROCESSING', note: rejected ? rejected[1] : 'Accepted.' }],
      simulated: true,
    };
    for (let i = 0; i < 3; i += 1) {
      try {
        const created = await SimBankTransaction.create({ ...doc, ref: newRef(now) });
        return publicTxn(created.toObject(), { duplicate: false });
      } catch (err) {
        if (err?.code !== 11000) {
          if (reserved) await SimBankAccount.updateOne({ _id: ACCOUNT_ID }, { $inc: { reserved: -request.amount } });
          throw err;
        }
        if (err.keyPattern?.idempotencyKey) {
          // The same key arrived twice at once: one transaction only.
          if (reserved) await SimBankAccount.updateOne({ _id: ACCOUNT_ID }, { $inc: { reserved: -request.amount } });
          const winner = await SimBankTransaction.findOne({ idempotencyKey: key }).lean();
          if (winner.requestHash !== requestHash) throw new SimBankError('idempotency_conflict', 'This Idempotency-Key was already used for a different payment.', { status: 409 });
          return publicTxn(winner, { duplicate: true });
        }
        // A reference collision (practically impossible): try a new reference.
      }
    }
    if (reserved) await SimBankAccount.updateOne({ _id: ACCOUNT_ID }, { $inc: { reserved: -request.amount } });
    throw new Error('Could not allocate a simulated transaction reference.');
  }

  /**
   * Complete every PROCESSING transaction whose time has come, at most `limit`.
   * Each one is claimed atomically, so two ticks cannot settle it twice.
   */
  async function settle({ now = new Date(), limit = 50 } = {}) {
    const due = await SimBankTransaction.find({ status: 'PROCESSING', completesAt: { $lte: now } })
      .sort({ completesAt: 1 })
      .limit(limit)
      .select('_id')
      .lean();
    let settled = 0;
    for (const { _id } of due) {
      const before = await SimBankTransaction.findOne({ _id, status: 'PROCESSING' }).lean();
      if (!before) continue;
      const outcome = before.plannedOutcome === 'FAILED' ? 'FAILED' : 'SUCCESS';
      const t = await SimBankTransaction.findOneAndUpdate(
        { _id, status: 'PROCESSING' },
        {
          $set: {
            status: outcome,
            settledAt: now,
            ...(outcome === 'FAILED' ? { failureCode: 'settlement_failed', failureMessage: 'The simulated bank could not complete the payment.' } : {}),
          },
          $push: { history: { at: now.toISOString(), status: outcome, note: outcome === 'SUCCESS' ? 'Completed.' : 'Failed at settlement.' } },
        },
        { new: true },
      ).lean();
      if (!t) continue; // another tick settled it
      await SimBankAccount.updateOne({ _id: t.accountId }, { $inc: outcome === 'SUCCESS' ? { balance: -t.amount, reserved: -t.amount } : { reserved: -t.amount } });
      settled += 1;
    }
    return settled;
  }

  const getTransaction = async (ref) => {
    const t = await SimBankTransaction.findOne({ ref: String(ref) }).lean();
    return t ? publicTxn(t) : null;
  };
  const findByIdempotencyKey = async (key) => {
    const t = await SimBankTransaction.findOne({ idempotencyKey: String(key) }).lean();
    return t ? publicTxn(t) : null;
  };
  const listTransactions = async ({ limit = 100 } = {}) => (await SimBankTransaction.find().sort({ createdAt: -1 }).limit(Math.min(500, limit)).lean()).map((t) => publicTxn(t));

  async function accountView() {
    const a = await account();
    return {
      id: a._id,
      name: a.name,
      bsb: a.bsb,
      accountNumber: a.accountNumber,
      currency: a.currency,
      balance: a.balance,
      reserved: a.reserved,
      available: round2(a.balance - a.reserved),
      simulated: true,
    };
  }

  async function setBalance(balance) {
    const n = Number(balance);
    if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new SimBankError('invalid_request', 'Enter a balance between 0 and 1,000,000,000.');
    await account();
    await SimBankAccount.updateOne({ _id: ACCOUNT_ID }, { $set: { balance: round2(n) } });
    return accountView();
  }

  async function setScenario(abn, scenario, by) {
    if (!SCENARIOS.includes(scenario)) throw new SimBankError('invalid_request', `Choose one of: ${SCENARIOS.join(', ')}.`);
    await SimBankScenario.findOneAndUpdate({ _id: String(abn) }, { $set: { scenario, setBy: by?.name || null, setById: by?.id || null } }, { upsert: true });
    return { abn: String(abn), scenario };
  }
  const listScenarios = async () => (await SimBankScenario.find().lean()).map((s) => ({ abn: s._id, scenario: s.scenario, setBy: s.setBy, updatedAt: s.updatedAt }));

  /** A statement of settled payments, as CSV for bank reconciliation (money out is negative). */
  async function statementCsv() {
    const txns = await SimBankTransaction.find({ status: 'SUCCESS' }).sort({ settledAt: 1 }).lean();
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = txns.map((t) =>
      [t.settledAt.toISOString().slice(0, 10), esc(`SIM BANK ${t.ref} ${t.payee?.name || ''} ${t.reference || ''}`.replace(/\s+/g, ' ').trim()), (-t.amount).toFixed(2)].join(','),
    );
    return ['Date,Description,Amount', ...rows].join('\n');
  }

  return { submitPayment, settle, getTransaction, findByIdempotencyKey, listTransactions, accountView, setBalance, setScenario, listScenarios, statementCsv, scenarioFor };
}
