// The bank adapter: the only way the payment workflow talks to a bank.
// It is written against the simulated bank; a real bank would need its own
// adapter with the same functions (and is out of scope: none exists here).
//
//   submitPayment(instruction) -> { outcome: 'accepted' | 'rejected', ref, status, completesAt, code, message, duplicate }
//                                 throws BankUnavailable (retryable) or BankError (not retryable)
//   getPayment({ ref, idempotencyKey }) -> { found, ref, status: PROCESSING | SUCCESS | FAILED | REJECTED, settledAt, code, message }
//   advance({ now })            -> the simulated bank settles what is due (simulation only)
//
// Calls have a timeout. A timeout means "unknown": the caller must ask the
// bank by idempotency key before trying again, never assume success.

import { SimBankError } from './simBank.js';

export class BankUnavailable extends Error {
  constructor(message, { timeout = false } = {}) {
    super(message);
    this.retryable = true;
    this.timeout = timeout;
  }
}
export class BankError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.retryable = false;
  }
}

export function withTimeout(promise, ms, what = 'The bank') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BankUnavailable(`${what} did not answer within ${Math.round(ms / 1000)} s.`, { timeout: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createSimBankAdapter({ simBank, timeoutMs = 10000 }) {
  const call = (p) => withTimeout(p, timeoutMs, 'The simulated bank');
  return {
    name: 'simulated',
    simulated: true,
    methods: ['EFT', 'BPAY', 'Card'],
    currencies: ['AUD'],

    async submitPayment(instruction, { now = new Date() } = {}) {
      let t;
      try {
        t = await call(simBank.submitPayment(instruction, { now }));
      } catch (err) {
        if (err instanceof SimBankError) {
          if (err.retryable) throw new BankUnavailable(err.message);
          throw new BankError(err.code, err.message);
        }
        throw err;
      }
      return {
        outcome: t.status === 'REJECTED' ? 'rejected' : 'accepted',
        ref: t.ref,
        status: t.status,
        completesAt: t.completesAt,
        code: t.failureCode,
        message: t.failureMessage,
        duplicate: Boolean(t.duplicate),
      };
    },

    async getPayment({ ref, idempotencyKey }) {
      const t = await call(ref ? simBank.getTransaction(ref) : simBank.findByIdempotencyKey(idempotencyKey));
      if (!t) return { found: false };
      return { found: true, ref: t.ref, status: t.status, settledAt: t.settledAt, completesAt: t.completesAt, code: t.failureCode, message: t.failureMessage, amount: t.amount };
    },

    advance: ({ now = new Date(), limit = 50 } = {}) => simBank.settle({ now, limit }),
  };
}
