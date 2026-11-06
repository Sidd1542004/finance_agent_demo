// Why an invoice is where it is, worked out by code from its records (rules
// only, no model). The explanation model is given this and told to explain
// it, not to infer state itself; ground.js then rejects text that contradicts
// it. Built from the Phase 1 views of one invoice (and its payment and history
// when the plan read them), for the person asking.
//
//   status / statusLabel        the invoice's status now
//   events                      the decisive steps from its history, dated (never names)
//   openChecks                  failed checks that still need a person's decision
//   overriddenChecks            failed checks a person decided past (approved anyway)
//   payment                     none | scheduled | queued | executing | completed | failed | on_hold | cancelled
//   overdueCause                why it is overdue, when it is
//   blockers                    what stops the next step
//   recommendedNextSteps        a short rule-based list for this state and this person's roles;
//                               never reverse_approval or reopen (no rule recommends them)
//   premiseCorrection           when the question assumed a status the record does not have

import { AWAITING_DECISION } from '../agent/finance/lifecycle.js';
import { todayIso } from '../agent/finance/due.js';
import { hasRole } from '../auth/roles.js';

export const STATUS_LABEL = Object.freeze({
  received: 'Received',
  processing: 'Processing',
  under_review: 'Under Review',
  needs_review: 'Needs Review',
  on_hold: 'On Hold',
  approved: 'Approved',
  payment_pending: 'Payment Pending',
  payment_processing: 'Payment Processing',
  payment_completed: 'Payment Completed',
  payment_failed: 'Payment Failed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  failed: 'Could not be processed',
});

const text = (v) => (v && typeof v === 'object' ? (v.untrusted_text ?? null) : (v ?? null));
const day = (v) => (typeof v === 'string' ? v.slice(0, 10) : null);
export const money = (n, currency = 'AUD') =>
  typeof n === 'number' && Number.isFinite(n)
    ? `${/^[A-Z]{3}$/.test(currency || '') ? currency : 'AUD'} ${n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;

// History actions that decide where an invoice goes, in plain words.
const DECISIVE = {
  approve: 'approved it',
  approve_received: 'approved the received quantity only',
  reject: 'rejected it',
  hold: 'put it on hold',
  request_correction: 'asked the supplier for a corrected invoice',
  cancel: 'cancelled it',
  reopen: 'reopened it for review',
  reverse_approval: 'reversed the approval',
  clear_duplicate: 'cleared it as not a duplicate',
  link_po: 'linked a purchase order',
  schedule_payment: 'scheduled the payment',
  reschedule_payment: 'rescheduled the payment',
  cancel_payment: 'cancelled the scheduled payment',
  record_payment: 'recorded the payment',
  payment_failed: 'marked the payment failed',
  payment_confirmed: 'the bank confirmed the payment',
};
const APPROVALS = ['approve', 'approve_received'];

/** The payment's state, from the payment view (detail or the invoice's own), on `today`. */
export function paymentState(p, today) {
  if (!p) return { state: 'none' };
  // manual: recorded by hand (a cheque, or any payment not sent through the simulated bank).
  const base = {
    method: p.method || null,
    date: day(p.scheduledFor),
    amount: money(p.amount, p.currency),
    manual: p.route === 'manual' || ['Cheque', 'Cash', 'Other'].includes(p.method),
  };
  switch (p.status) {
    case 'queued':
      return { ...base, state: base.date && base.date > today ? 'scheduled' : 'queued' };
    case 'processing':
      return { ...base, state: 'executing' };
    case 'paid':
      return { ...base, state: 'completed' };
    case 'failed':
      return { ...base, state: 'failed', failure: p.failure?.code || null };
    case 'on_hold':
      return { ...base, state: 'on_hold' };
    case 'cancelled':
      return { ...base, state: 'cancelled' };
    default:
      return { ...base, state: 'none' };
  }
}

const manual = (pay) => Boolean(pay.manual);

/**
 * Statuses a question presupposes ("why is X on hold?", "explain why X is paid"):
 * on_hold, paid, approved, rejected, cancelled, overdue, needs_review. A question
 * that asks whether ("has X been paid?") presupposes nothing. Words only: the
 * question itself goes no further.
 */
export function premisesIn(question) {
  const q = String(question || '').toLowerCase();
  const why = q.match(/\bwhy\b(?:\s+\w+){0,6}?\s+(?:is|was|has|isn't|are)\b(.*)$/) || q.match(/\bexplain\b.*\bwhy\b(.*)$/);
  if (!why) return [];
  const rest = why[1];
  const out = [];
  if (/\b(?:on hold|held)\b/.test(rest)) out.push('on_hold');
  if (/\b(?:been )?paid\b/.test(rest) && !/\bunpaid\b|\bnot (?:yet )?(?:been )?paid\b/.test(rest)) out.push('paid');
  if (/\bapproved\b/.test(rest) && !/\bnot (?:yet )?approved\b/.test(rest)) out.push('approved');
  if (/\brejected\b/.test(rest)) out.push('rejected');
  if (/\bcancel+ed\b/.test(rest)) out.push('cancelled');
  if (/\boverdue\b|\blate\b/.test(rest)) out.push('overdue');
  if (/\bneeds? review\b|\bin review\b/.test(rest)) out.push('needs_review');
  return out;
}

const PREMISE_WORDS = { on_hold: 'on hold', paid: 'paid', approved: 'approved', rejected: 'rejected', cancelled: 'cancelled', overdue: 'overdue', needs_review: 'in Needs Review' };

function premiseHolds(premise, invoice, pay) {
  switch (premise) {
    case 'on_hold':
      return invoice.status === 'on_hold';
    case 'paid':
      return invoice.status === 'payment_completed' || pay.state === 'completed';
    case 'approved':
      return ['approved', 'payment_pending', 'payment_processing', 'payment_completed', 'payment_failed'].includes(invoice.status);
    case 'rejected':
      return invoice.status === 'rejected';
    case 'cancelled':
      return invoice.status === 'cancelled';
    case 'overdue':
      return invoice.due?.state === 'overdue';
    case 'needs_review':
      return invoice.status === 'needs_review';
    default:
      return true;
  }
}

/**
 * The state explanation for one invoice view (views.js invoiceDetail), with
 * its payment view (paymentDetail.payment, or the invoice's own), its history
 * items (views.js history), the person asking and the question's premises.
 */
export function stateReason(invoice, { payment = null, history = [], viewer = null, premises = [], today = todayIso() } = {}) {
  const status = invoice.status;
  const ref = text(invoice.invoiceNumber) || 'This invoice';
  const pay = paymentState(payment || invoice.payment || null, today);
  const approval = invoice.approval && APPROVALS.includes(invoice.approval.decision) ? invoice.approval : null;
  const approvedOn = day(approval?.at);

  // Decisive events, oldest first: from the history, or from the approval and payment when there is none.
  const events = (history || [])
    .filter((e) => DECISIVE[e.action])
    .map((e) => ({ date: day(e.at), what: `${e.action === 'payment_confirmed' ? '' : e.byPerson ? 'A person ' : 'The system '}${DECISIVE[e.action]}`.trim() }));
  if (!events.length) {
    if (approval) events.push({ date: approvedOn, what: `A person ${DECISIVE[approval.decision]}` });
    if (pay.state !== 'none' && pay.date) events.push({ date: null, what: `A payment by ${pay.method || 'an unknown method'} was scheduled for ${pay.date}` });
  }

  // Failed checks: open while the invoice awaits a decision; overridden once a person approved it.
  const failed = (invoice.checks || []).filter((c) => c.status === 'fail').map((c) => c.id);
  const ids = failed.length ? failed : invoice.failedChecks || [];
  const decided = Boolean(approval) && !AWAITING_DECISION.includes(status);
  const openChecks = decided ? [] : [...ids];
  const overriddenChecks = decided ? ids.map((id) => ({ id, by: 'approver', on: approvedOn })) : [];

  // Why it is overdue.
  let overdueCause = null;
  const due = invoice.due?.date || null;
  if (invoice.due?.state === 'overdue') {
    const passed = `the due date ${due} has passed`;
    if (pay.state === 'queued') {
      const how = pay.method ? `${pay.method} payment` : 'payment';
      const why = manual(pay) ? ' (a cheque stays queued until a payer records the payment or a bank statement line confirms it)' : ' (the payment run has not submitted it yet)';
      overdueCause = `The ${how} scheduled for ${pay.date} is still queued${why}; ${passed}.`;
    } else if (pay.state === 'scheduled') overdueCause = `The payment is scheduled for ${pay.date}, after the due date ${due}.`;
    else if (pay.state === 'executing') overdueCause = `The payment is being processed by the bank; ${passed}.`;
    else if (pay.state === 'failed') overdueCause = `The payment failed; ${passed}.`;
    else if (pay.state === 'on_hold') overdueCause = `The payment is on hold; ${passed}.`;
    else if (approval && ['approved'].includes(status)) overdueCause = `It is approved but no payment is scheduled; ${passed}.`;
    else if (status === 'on_hold') overdueCause = `It is on hold; ${passed}.`;
    else if (AWAITING_DECISION.includes(status)) overdueCause = `It still needs a decision (${STATUS_LABEL[status]}); ${passed}.`;
  }

  // What stops the next step.
  const blockers = [];
  if (AWAITING_DECISION.includes(status)) {
    if (status === 'on_hold') blockers.push('It is on hold until a person releases it.');
    if (openChecks.length) blockers.push(`${openChecks.length} failed check${openChecks.length === 1 ? '' : 's'} need a person's decision: ${openChecks.join(', ')}.`);
  } else if (status === 'approved' && pay.state === 'none') blockers.push('No payment is scheduled.');
  else if (pay.state === 'queued' && manual(pay)) blockers.push('No payer has recorded the cheque payment yet.');
  else if (pay.state === 'queued') blockers.push('The scheduled payment has not been submitted yet.');
  else if (pay.state === 'failed' || status === 'payment_failed') blockers.push('The payment failed.');
  else if (pay.state === 'on_hold') blockers.push('The payment is on hold.');

  // Recommended next steps: rules for this state; each names the role that can do it.
  const steps = [];
  const add = (action, role, words) => steps.push({ action, role, text: words, yours: viewer ? hasRole(viewer, role) : null });
  if (status === 'needs_review' || status === 'under_review') {
    add('decide', 'approver', 'Review the failed checks on the invoice screen, then approve, approve the received quantity only, or reject it.');
    if (status === 'needs_review') add('correct', 'reviewer', 'Correct any fields read wrongly, link the purchase order, or ask the supplier for a corrected invoice.');
  } else if (status === 'on_hold') {
    add('review_hold', 'reviewer', 'Read the hold note on the invoice screen and process it again or ask the supplier for a corrected invoice.');
    add('decide', 'approver', 'Once the reason for the hold is resolved, approve, approve the received quantity only, or reject it.');
  } else if (status === 'approved' && pay.state === 'none') {
    add('schedule_payment', 'payer', 'Schedule the payment on the invoice screen.');
  } else if (status === 'payment_pending' && pay.state === 'queued' && manual(pay)) {
    add(
      'record_payment',
      'payer',
      'If the cheque has been sent, record the payment on the invoice screen, or match it to the bank statement line on the Bank reconciliation screen.',
    );
    add('check_payment', 'payer', 'If the cheque has not been sent, send it or reschedule the payment.');
  } else if (status === 'payment_pending' && pay.state === 'queued') {
    add('check_payment', 'payer', 'Check the payment on the Payments screen: the payment run should submit it on its next run.');
  } else if (status === 'payment_failed' || pay.state === 'failed') {
    add('schedule_payment', 'payer', 'Check why the payment failed on the Payments screen, then schedule it again.');
  }

  // A question that assumed a status the record does not have.
  const wrong = premises.filter((p) => !premiseHolds(p, invoice, pay));
  const premiseCorrection = wrong.length
    ? `${ref} is not ${wrong.map((p) => PREMISE_WORDS[p]).join(' or ')}; it is in ${STATUS_LABEL[status] || status}${pay.state !== 'none' ? `, with its payment ${pay.state}` : ''}.`
    : null;

  return {
    status,
    statusLabel: STATUS_LABEL[status] || status,
    events,
    openChecks,
    overriddenChecks,
    payment: pay,
    overdueCause,
    blockers,
    recommendedNextSteps: steps,
    premiseCorrection,
  };
}
