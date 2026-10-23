// Harness for the payment execution tests: a real MongoDB, the real ledger,
// invoice actions in bank mode, the simulated bank and the executor, all on
// an injected clock (so business days and delays are deterministic).

import mongoose from 'mongoose';
import { startTestDatabase, buildIndexes, testEnv } from './mongo.js';

export const HARBOUR = { abn: '57600410275', name: 'Harbour Office Supplies Pty Ltd' };
export const PALLETS = { abn: '37600518342', name: 'Southern Cross Pallets Pty Ltd' };
export const BLUEGUM = { abn: '36600733916', name: 'Bluegum IT Services Pty Ltd' };

export const payer = { id: 'u-pay', name: 'Sam Payer', roles: ['payer'] };
export const approver = { id: 'u-app', name: 'Priya Approver', roles: ['approver'] };

export async function startPayments({ delaySeconds = 20, delayedSeconds = 600, openingBalance = 100000, env = {} } = {}) {
  const db = await startTestDatabase();
  testEnv(db.uri, env);
  await mongoose.connect(db.uri);
  await buildIndexes();
  const models = await import('../src/models/index.js');
  const { seedReferenceData } = await import('../src/seed/seed.js');
  await seedReferenceData();
  const { sampleLedger } = await import('../src/integrations/sampleLedger.js');
  const { createInvoiceActions } = await import('../src/services/invoiceActions.js');
  const { createCalendar } = await import('../src/agent/finance/businessDays.js');
  const { createSimBank } = await import('../src/bank/simBank.js');
  const { createSimBankAdapter } = await import('../src/bank/adapter.js');
  const { createPaymentExecutor } = await import('../src/services/paymentExecution.js');
  const { createPaymentNotices } = await import('../src/services/paymentNotices.js');
  const { createEmailDelivery } = await import('../src/services/emailDelivery.js');

  const calendar = createCalendar({ timeZone: 'Australia/Sydney', holidays: [], cutoff: '15:00', defaultTime: '09:00' });
  const clock = { t: calendar.instant('2026-10-22', '10:00').getTime() }; // Thursday 10:00 Sydney
  const now = () => new Date(clock.t);
  const setClock = (date, time) => {
    clock.t = calendar.instant(date, time).getTime();
  };
  const advance = (seconds) => {
    clock.t += seconds * 1000;
  };

  const simBank = createSimBank({ delaySeconds, delayedSeconds, openingBalance, bsbPrefix: '999', temporaryFailures: 1 });
  const adapter = createSimBankAdapter({ simBank, timeoutMs: 5000 });
  const policy = { matchThreshold: 85, missingAbn: 'review', segregateDuties: false, priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };
  const actions = createInvoiceActions({ store: sampleLedger, policy, rerun: async () => {}, now, bank: { calendar, methods: ['EFT', 'BPAY', 'Card'], currencies: ['AUD'] } });
  const delivery = createEmailDelivery({ appEnv: 'development', mode: 'outbox' });
  const notices = createPaymentNotices({ delivery, companyName: 'Meridian Logistics Pty Ltd', timeZone: 'Australia/Sydney' });
  const executor = (over = {}) => createPaymentExecutor({ store: sampleLedger, adapter, calendar, notices, now, leaseSeconds: 120, log: { error() {} }, ...over });

  let n = 0;
  /** An approved invoice, ready to schedule (created directly, not through the reader). */
  async function approvedInvoice({ supplier = HARBOUR, total = 100, currency = 'AUD' } = {}) {
    n += 1;
    const doc = await models.Invoice.create({
      source: { kind: 'paste' },
      rawText: `test invoice ${n}`,
      status: 'approved',
      extracted: { vendorName: supplier.name, invoiceNumber: `T-${1000 + n}`, total, currency, abn: supplier.abn },
      supplier: { name: supplier.name, abn: supplier.abn },
      approval: { decision: 'approve', decidedBy: approver.name, decidedById: approver.id, decidedAt: now().toISOString(), amount: total },
      fingerprints: { numberKey: `nk-${n}` },
      checks: [],
    });
    return String(doc._id);
  }

  async function scheduled({ supplier, total, method = 'EFT', date = '2026-10-22', time = '10:00' } = {}) {
    const id = await approvedInvoice({ supplier, total });
    await actions.perform(id, 'schedule_payment', { method, scheduledFor: date, scheduledTime: time }, payer);
    const payment = await models.Payment.findOne({ invoiceId: id }).lean();
    return { invoiceId: id, paymentId: String(payment._id) };
  }

  const invoice = (id) => models.Invoice.findById(id).lean();
  const payment = (id) => models.Payment.findById(id).lean();
  const txns = (paymentId) => models.SimBankTransaction.find({ idempotencyKey: new RegExp(`^foa:${paymentId}:`) }).lean();

  return {
    models,
    ledger: sampleLedger,
    actions,
    calendar,
    clock,
    now,
    setClock,
    advance,
    simBank,
    adapter,
    notices,
    delivery,
    executor,
    approvedInvoice,
    scheduled,
    invoice,
    payment,
    txns,
    stop: () => db.stop(),
  };
}
