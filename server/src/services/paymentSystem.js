// The payment system as the app uses it: the simulated bank, the adapter in
// front of it, supplier payment notices with safe delivery, and the executor
// behind the cron tick. Built once from config.

import { config } from '../config.js';
import { createSimBank } from '../bank/simBank.js';
import { createSimBankAdapter } from '../bank/adapter.js';
import { createMailer } from './mailer.js';
import { createEmailDelivery } from './emailDelivery.js';
import { createPaymentNotices } from './paymentNotices.js';
import { createSupplierDisputes, apReplyTo } from './supplierDisputes.js';
import { createPaymentExecutor } from './paymentExecution.js';
import { paymentCalendar } from './invoices.js';
import { sampleLedger } from '../integrations/sampleLedger.js';

export const simBank = createSimBank(config.simBank);

export const bankAdapter = createSimBankAdapter({ simBank, timeoutMs: config.payments.bankTimeoutMs });

export const emailDelivery = createEmailDelivery({
  appEnv: config.appEnv,
  mode: config.supplierEmail.mode,
  testRecipient: config.supplierEmail.testRecipient,
  mailer: createMailer({ ...config.alerts, from: config.supplierEmail.from }),
});

export const paymentNotices = createPaymentNotices({ delivery: emailDelivery, companyName: config.companyName, timeZone: config.timeZone });

export const paymentExecutor = createPaymentExecutor({
  store: sampleLedger,
  adapter: bankAdapter,
  calendar: paymentCalendar,
  notices: paymentNotices,
  tickMaxJobs: config.payments.tickMaxJobs,
  tickBudgetSeconds: config.payments.tickBudgetSeconds,
  leaseSeconds: config.payments.leaseSeconds,
  maxAttempts: config.payments.maxAttempts,
});

// Queries to suppliers about an invoice's variance: drafted by the model (or the
// template), sent by a person through the same delivery as payment notices.
let disputeModel = null;
/** For tests and scripts: the model settings the drafting call uses ({ apiKey, model, fetchImpl }). */
export function configureDisputeModel(over) {
  disputeModel = over;
}
export const supplierDisputes = createSupplierDisputes({
  delivery: emailDelivery,
  buyer: config.companyName,
  policy: config.policy,
  llm: () => disputeModel || { apiKey: config.groqApiKey, model: config.groqModel },
  // Replies go to accounts payable: AP_REPLY_TO, or the connected invoice mailbox.
  replyTo: () => apReplyTo(config.supplierEmail.replyTo),
});
