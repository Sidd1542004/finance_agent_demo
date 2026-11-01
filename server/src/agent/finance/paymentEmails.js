// Payment notices to suppliers: fixed templates filled from verified records
// (the invoice, the payment and the simulated bank's confirmation). As with
// replies to supplier emails, no AI model writes to a supplier.
//
//   payment_success     only after the bank confirmed SUCCESS
//   payment_processing  the bank accepted it; says clearly it is not confirmed
//   payment_failed      the payment did not go through; no amount is promised
//
// Every notice says it is simulated: no money moved.

import { fmtMoney } from './validation.js';
import { isoDateIn } from './timeZone.js';

export const NOTICE_KINDS = ['payment_success', 'payment_processing', 'payment_failed'];

/** Why a notice of this kind cannot be written for this payment now, or null. */
export function noticeBlock(kind, payment) {
  if (!NOTICE_KINDS.includes(kind)) return 'Unknown notice.';
  if (!payment) return 'There is no payment.';
  if (payment.route !== 'bank') return 'Notices are only written for payments made through the simulated bank.';
  if (kind === 'payment_success' && !(payment.status === 'paid' && payment.confirmation?.txnRef))
    return 'A payment confirmation can only be written once the bank has confirmed the payment.';
  if (kind === 'payment_processing' && !(payment.status === 'processing' && payment.submission?.txnRef)) return 'The bank is not processing this payment.';
  if (kind === 'payment_failed' && payment.status !== 'failed') return 'This payment has not failed.';
  return null;
}

/** The transaction a notice is about: one notice per payment, kind and transaction. */
export const noticeRef = (kind, payment) =>
  (kind === 'payment_success' ? payment.confirmation?.txnRef : kind === 'payment_processing' ? payment.submission?.txnRef : payment.failure?.txnRef) ||
  `v${payment.scheduleVersion || 1}`;

export function composePaymentNotice({ kind, payment, invoice, companyName, timeZone }) {
  const cur = payment.currency || invoice?.extracted?.currency || 'AUD';
  const number = payment.invoiceNumber || invoice?.extracted?.invoiceNumber || '(no number)';
  const masked = payment.beneficiary?.masked;
  const account = masked?.bsb
    ? `BSB ${masked.bsb}, account ${masked.accountNumber}`
    : masked?.billerCode
      ? `BPAY biller ${masked.billerCode}, reference ${masked.crn}`
      : masked?.cardToken
        ? `card ${masked.cardToken}`
        : 'your account on file';
  const sim = 'This notice comes from a test system using a SIMULATED bank. No money has moved.';
  const sign = `Regards,\nAccounts Payable\n${companyName}`;

  if (kind === 'payment_success') {
    const c = payment.confirmation;
    const amount = fmtMoney(c.amount ?? payment.amount, cur);
    const date = isoDateIn(c.confirmedAt, timeZone);
    return {
      subject: `Payment made: invoice ${number}`,
      body: [
        `Hello ${payment.vendorName || ''},`.trim(),
        '',
        `We have paid invoice ${number}.`,
        '',
        `Amount: ${amount}`,
        `Paid to: ${account} (${payment.method})`,
        `Bank transaction reference: ${c.txnRef}`,
        `Confirmed by the bank on: ${date}`,
        '',
        sim,
        '',
        sign,
      ].join('\n'),
    };
  }
  if (kind === 'payment_processing') {
    return {
      subject: `Payment in progress: invoice ${number}`,
      body: [
        `Hello ${payment.vendorName || ''},`.trim(),
        '',
        `Payment of invoice ${number} has been sent to our bank and is being processed. It is not confirmed yet; we will let you know once it is.`,
        '',
        `Amount: ${fmtMoney(payment.submission?.amount ?? payment.amount, cur)}`,
        `Bank transaction reference: ${payment.submission.txnRef}`,
        '',
        sim,
        '',
        sign,
      ].join('\n'),
    };
  }
  return {
    subject: `Payment not completed: invoice ${number}`,
    body: [
      `Hello ${payment.vendorName || ''},`.trim(),
      '',
      `Our payment of invoice ${number} did not go through. Nothing has been paid for it yet. We are looking into it and will be in touch.`,
      '',
      sim,
      '',
      sign,
    ].join('\n'),
  };
}
