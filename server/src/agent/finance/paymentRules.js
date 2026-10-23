// Payment rules: how much may be paid, how a payment's status may move, and
// the idempotency key that makes resubmitting to the bank safe. Plain functions.
//
// Payment statuses (lowercase, as before):
//   queued      scheduled, waiting for its time            (Payment Pending)
//   on_hold     put on hold by the agent (invoice not approved)
//   processing  the bank accepted it; not confirmed yet     (Payment Processing)
//   paid        confirmed: recorded by a person (Cheque/Other), matched to a
//               bank line, or (bank-routed) the bank's confirmed SUCCESS
//   failed      the bank failed or rejected it, or a person marked it failed
//   cancelled   stopped before it was submitted
// A scheduled payment is not a completed payment: only `paid` is.

import { cents, isNum } from './rules.js';

export const PAYMENT_TRANSITIONS = {
  queued: ['processing', 'paid', 'failed', 'cancelled', 'on_hold', 'queued'], // queued -> queued: rescheduled
  on_hold: ['queued', 'cancelled'],
  processing: ['paid', 'failed'], // only the bank decides; nothing cancels it
  failed: ['queued', 'cancelled'], // retry, or give up
  cancelled: ['queued'], // scheduled again after a new decision
  paid: [], // final: a recovery can be opened, the record is kept
};
export const canMovePayment = (from, to) => (PAYMENT_TRANSITIONS[from] || []).includes(to);

/** The amount a person approved (the received quantity only, or the invoice total). */
export const approvedAmount = (invoice) => (isNum(invoice?.approval?.amount) ? invoice.approval.amount : invoice?.extracted?.total);

/** Approved amount minus confirmed payments already made. Never negative. */
export function remainingToPay(invoice, payment) {
  const approved = approvedAmount(invoice);
  if (!isNum(approved)) return 0;
  const paid = isNum(payment?.paidAmount) ? payment.paidAmount : 0;
  return Math.max(0, (cents(approved) - cents(paid)) / 100);
}

/**
 * Why a bank payment of `requested` is not allowed, or null. It may never be
 * more than what is left to pay, and the bank pays the whole remainder (part
 * payments are recorded by Cheque or Other).
 */
export function bankAmountProblem(requested, remaining, fmt = (n) => n.toFixed(2)) {
  if (!isNum(requested) || requested <= 0) return 'Enter the amount to pay.';
  if (!(remaining > 0)) return 'Nothing is left to pay on this invoice.';
  if (cents(requested) > cents(remaining)) return `That is more than the ${fmt(remaining)} still to pay (the approved amount minus payments already confirmed).`;
  if (cents(requested) < cents(remaining)) return `Bank payments pay the full ${fmt(remaining)} still to pay. Record a part payment by Cheque or Other instead.`;
  return null;
}

/** The same payment and schedule version always uses the same key, so a retry can never pay twice. */
export const idempotencyKey = (paymentId, scheduleVersion) => `foa:${paymentId}:v${scheduleVersion || 1}`;
