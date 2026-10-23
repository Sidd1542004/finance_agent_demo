// Invoice status lifecycle: the statuses, which moves are allowed, and which
// actions a person can take in each status. The backend enforces all of it;
// the dashboard only shows what the backend says is allowed.
//
//   received -> processing -> under_review | needs_review | on_hold | failed   (the agent)
//   under_review / needs_review / on_hold -> approved | rejected | cancelled   (a person)
//   approved -> payment_pending -> payment_completed | payment_failed          (payment)
//   payment_pending -> payment_processing -> payment_completed | payment_failed
//     (bank-routed payments: EFT, BPAY, Card. The simulated bank accepted the
//     instruction; only its confirmed SUCCESS completes the invoice. While
//     processing, nothing can cancel, reverse or reopen it.)
//   payment_pending -> approved   ("Cancel payment": the scheduled payment is
//     cancelled before it was submitted; the invoice stays approved)
//   approved / payment_pending -> rejected (approval reversed, payment stopped)
//   payment_failed -> payment_pending (retry) | cancelled
//   payment_completed: final. A recovery can be opened; the payment is kept.
//   approved / payment_pending / payment_failed / rejected / cancelled -> needs_review
//     ("Reopen for review": undoes an accidental decision. Cancels a queued
//     payment first; refused once the payment is actually paid - a recovery
//     must be opened for that instead.)
//
// "under_review" means ELIGIBLE FOR APPROVAL REVIEW: it scored at or above the
// threshold with no exceptions. It is never approved without a person.

import { namesEqual } from './rules.js';

export const STATUS_LABEL = {
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
  failed: 'Could not process',
};

export const STATUSES = Object.keys(STATUS_LABEL);
export const AWAITING_DECISION = ['under_review', 'needs_review', 'on_hold'];
export const APPROVED = ['approved', 'payment_pending', 'payment_processing', 'payment_completed', 'payment_failed'];
export const CLOSED = ['payment_completed', 'rejected', 'cancelled'];

export const TRANSITIONS = {
  received: ['processing'],
  processing: ['under_review', 'needs_review', 'on_hold', 'failed'],
  under_review: ['approved', 'rejected', 'cancelled', 'on_hold', 'processing'],
  needs_review: ['approved', 'rejected', 'cancelled', 'on_hold', 'processing'],
  on_hold: ['approved', 'rejected', 'cancelled', 'processing'],
  failed: ['processing', 'rejected', 'cancelled'],
  approved: ['payment_pending', 'rejected', 'cancelled', 'needs_review'],
  payment_pending: ['payment_completed', 'payment_failed', 'payment_processing', 'approved', 'rejected', 'cancelled', 'needs_review'],
  payment_processing: ['payment_completed', 'payment_failed'],
  payment_failed: ['payment_pending', 'cancelled', 'needs_review'],
  payment_completed: [],
  rejected: ['needs_review'],
  cancelled: ['needs_review'],
};

export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

// Checks that stop a full approval while they fail. A suspected duplicate must
// be cleared first; sums that don't add up need a corrected invoice; goods not
// received can only be approved for the received quantity.
export const APPROVAL_BLOCKERS = {
  duplicate: 'It may be a duplicate. Confirm it is not a duplicate first.',
  arithmetic: "The invoice's amounts don't add up. Request a corrected invoice.",
  quantity_match: 'More is invoiced than can be paid for. Approve the received quantity only, or request a corrected invoice.',
};

// Payments sent through the (simulated) bank are confirmed by the bank only.
export const BANK_ROUTED = 'This payment goes through the simulated bank, which confirms it. It cannot be recorded by hand.';
export const PROCESSING = 'The simulated bank is processing this payment. It cannot be cancelled now: it will complete or fail. If it completes, start a recovery.';

export const failedChecks = (invoice) => (invoice?.checks || []).filter((c) => c.status === 'fail');

export const SUPPLIER_UNIDENTIFIED = 'Approval blocked: supplier could not be identified. Identify and verify the supplier before approving this invoice.';

// No supplier name was read from the invoice, or the only name read is the
// customer's. Nothing else stands in for it: not the customer's name, a
// similar or suggested supplier, a VAT number, a purchase order, or an ABN
// match. A missing ABN on its own is a separate check and does not apply here.
export function supplierIdentityBlock(invoice) {
  const e = invoice?.extracted || {};
  const name = String(e.vendorName ?? '').trim();
  if (!name || (e.customerName && namesEqual(name, e.customerName))) return SUPPLIER_UNIDENTIFIED;
  return null;
}

// A purchase order is linked but the PO check fails: the PO was raised with a
// different supplier, or the invoice's supplier is not confirmed. Paying
// against someone else's PO is never approved, with or without a note.
export function poOwnershipBlock(invoice) {
  const po = invoice?.match?.po;
  if (!po || !failedChecks(invoice).some((c) => c.id === 'po_found')) return null;
  return `The linked purchase order ${po.poNumber} was raised with ${po.vendorName}, and this invoice's supplier is not confirmed as ${po.vendorName}. Verify supplier ownership first: correct the supplier, or reject the invoice and ask for one against the right purchase order.`;
}

// Where the agent leaves an invoice, from its checks.
export function statusFromChecks(checks) {
  const failed = checks.filter((c) => c.status === 'fail');
  if (failed.some((c) => c.severity === 'review')) return 'needs_review';
  if (failed.length) return 'on_hold';
  return 'under_review';
}

/**
 * Actions a person can take.
 *   from   statuses the action is allowed in
 *   to     resulting status (null = unchanged, or decided by re-running the agent)
 *   note   'required' | 'optional' | 'if_exceptions' (required when checks failed)
 *   role   'reviewer' | 'approver' | 'payer' (see config.roles)
 */
export const ACTIONS = {
  approve: { label: 'Approve', from: AWAITING_DECISION, to: 'approved', note: 'if_exceptions', role: 'approver', confirm: true },
  approve_received: { label: 'Approve received quantity only', from: AWAITING_DECISION, to: 'approved', note: 'optional', role: 'approver', confirm: true },
  reject: { label: 'Reject', from: [...AWAITING_DECISION, 'failed'], to: 'rejected', note: 'required', role: 'approver', confirm: true },
  hold: { label: 'Place on hold', from: ['under_review', 'needs_review'], to: 'on_hold', note: 'required', role: 'reviewer' },
  request_correction: { label: 'Request corrected invoice', from: AWAITING_DECISION, to: 'on_hold', note: 'required', role: 'reviewer' },
  link_po: { label: 'Link purchase order', from: AWAITING_DECISION, to: null, note: 'optional', role: 'reviewer' },
  clear_duplicate: { label: 'Not a duplicate', from: AWAITING_DECISION, to: null, note: 'required', role: 'approver', confirm: true },
  rerun: { label: 'Process again', from: [...AWAITING_DECISION, 'failed'], to: null, note: 'optional', role: 'reviewer' },
  // Correct fields the reader got wrong. The agent then checks the invoice
  // again on the corrected values; nothing is approved by correcting it.
  edit_fields: { label: 'Edit fields', from: [...AWAITING_DECISION, 'failed'], to: null, note: 'required', role: 'reviewer' },
  schedule_payment: { label: 'Schedule payment', from: ['approved', 'payment_failed'], to: 'payment_pending', note: 'optional', role: 'payer', confirm: true },
  // Change the date, time or method of a payment that has not been submitted yet.
  reschedule_payment: { label: 'Reschedule payment', from: ['payment_pending'], to: null, note: 'optional', role: 'payer', confirm: true },
  // Stop a scheduled payment before it is submitted; the invoice stays approved.
  cancel_payment: { label: 'Cancel payment', from: ['payment_pending'], to: 'approved', note: 'required', role: 'payer', confirm: true },
  record_payment: { label: 'Record payment', from: ['payment_pending'], to: 'payment_completed', note: 'optional', role: 'payer', confirm: true },
  payment_failed: { label: 'Mark payment failed', from: ['payment_pending'], to: 'payment_failed', note: 'required', role: 'payer' },
  reverse_approval: { label: 'Reverse approval', from: ['approved', 'payment_pending'], to: 'rejected', note: 'required', role: 'approver', confirm: true },
  cancel: { label: 'Cancel invoice', from: [...AWAITING_DECISION, 'failed', 'approved', 'payment_failed'], to: 'cancelled', note: 'required', role: 'approver', confirm: true },
  // Undo an accidental decision: puts the invoice back in front of a person,
  // instead of leaving it approved, rejected or cancelled by mistake. Refused
  // once the payment has actually gone out (see blockedReason) - that needs
  // the separate, explicit recovery workflow instead.
  reopen: {
    label: 'Reopen for review',
    from: ['approved', 'payment_pending', 'payment_failed', 'rejected', 'cancelled'],
    to: 'needs_review',
    note: 'required',
    role: 'approver',
    confirm: true,
  },
  start_recovery: { label: 'Start recovery', from: ['payment_completed'], to: null, note: 'required', role: 'approver', confirm: true },
  close_recovery: { label: 'Close recovery', from: ['payment_completed'], to: null, note: 'required', role: 'approver' },
};

export class ActionError extends Error {
  // `extra`: more for the client, for example { suggestion: { date, time } }.
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const inRole = (name, list) => !list || !list.length || list.some((n) => n.toLowerCase() === String(name).trim().toLowerCase());

/**
 * Why an action cannot be taken right now, or null if it can.
 * `ctx` = { payment, receivedOnly, roles, decidedBy, policy }
 */
export function blockedReason(invoice, actionId, ctx = {}) {
  const a = ACTIONS[actionId];
  if (!a) return 'Unknown action.';
  const status = invoice.status;
  if (!a.from.includes(status)) return `Not allowed while the invoice is ${STATUS_LABEL[status] || status}.`;
  const failedIds = failedChecks(invoice).map((c) => c.id);
  const recovery = invoice.recovery;

  switch (actionId) {
    case 'approve': {
      // Who is being paid comes first, then whose purchase order it is.
      if (supplierIdentityBlock(invoice)) return supplierIdentityBlock(invoice);
      if (poOwnershipBlock(invoice)) return poOwnershipBlock(invoice);
      const b = failedIds.find((id) => APPROVAL_BLOCKERS[id]);
      if (b) return APPROVAL_BLOCKERS[b];
      if (typeof invoice.extracted?.total !== 'number') return 'The invoice has no total to approve.';
      return null;
    }
    case 'approve_received': {
      if (supplierIdentityBlock(invoice)) return supplierIdentityBlock(invoice);
      if (poOwnershipBlock(invoice)) return poOwnershipBlock(invoice);
      if (!failedIds.includes('quantity_match')) return 'Only for invoices that bill more than was received.';
      if (!ctx.receivedOnly) return 'There is nothing that can be paid for at the received quantity.';
      const other = failedIds.find((id) => id !== 'quantity_match' && APPROVAL_BLOCKERS[id]);
      return other ? APPROVAL_BLOCKERS[other] : null;
    }
    case 'clear_duplicate':
      return failedIds.includes('duplicate') ? null : 'The invoice is not flagged as a possible duplicate.';
    case 'start_recovery':
      return recovery?.status === 'open' ? 'A recovery is already open.' : null;
    case 'close_recovery':
      return recovery?.status === 'open' ? null : 'There is no open recovery.';
    case 'record_payment':
      if (ctx.payment?.route === 'bank') return BANK_ROUTED;
      return ctx.payment?.status === 'queued' ? null : 'There is no pending payment to record.';
    case 'payment_failed':
      return ctx.payment?.route === 'bank' ? 'The simulated bank reports failures itself. To stop this payment before it is submitted, cancel the payment.' : null;
    case 'reschedule_payment':
    case 'cancel_payment':
      if (ctx.payment?.status === 'processing') return PROCESSING;
      return ['queued', 'on_hold'].includes(ctx.payment?.status) ? null : 'There is no scheduled payment to change.';
    case 'reverse_approval':
      return ctx.payment?.status === 'processing' ? PROCESSING : null;
    case 'reopen':
      if (ctx.payment?.status === 'processing') return PROCESSING;
      // Money that has actually gone out (or been recorded as paid) is never
      // undone by this action: a recovery must be opened instead, so nobody
      // can claim an external payment was reversed when it was not.
      return ctx.payment?.status === 'paid' ? 'This invoice has already been paid. Start a recovery instead; reopening never claims a payment was reversed.' : null;
    default:
      return null;
  }
}

// Everything the dashboard needs to draw the action buttons for one invoice.
export function allowedActions(invoice, ctx = {}) {
  const exceptions = failedChecks(invoice).length > 0;
  return Object.entries(ACTIONS)
    .filter(([, a]) => a.from.includes(invoice.status))
    .map(([id, a]) => {
      const reason = blockedReason(invoice, id, ctx);
      return {
        id,
        label: id === 'approve' && exceptions ? 'Approve with exceptions' : a.label,
        enabled: !reason,
        reason,
        noteRequired: a.note === 'required' || (a.note === 'if_exceptions' && exceptions),
        confirm: Boolean(a.confirm),
        role: a.role,
        // Whether the signed-in person holds the role (always true without one).
        permitted: ctx.actor ? (ctx.actor.roles || []).includes(a.role) : true,
      };
    })
    .filter((x) => x.enabled || ['approve', 'approve_received', 'clear_duplicate', 'reopen', 'reverse_approval', 'cancel_payment', 'reschedule_payment'].includes(x.id));
}

/**
 * Check a person may take an action, before anything is changed.
 * Throws ActionError with a message that can be shown to the user.
 *
 * ctx.actor = { id, name, roles }: the signed-in user. Every API call passes
 * one, and then only the user's roles count. Without an actor (internal
 * callers and the tests) the typed name is checked against ctx.roles lists.
 */
export function assertAction(invoice, actionId, input, ctx = {}) {
  const a = ACTIONS[actionId];
  if (!a) throw new ActionError(400, 'Unknown action.');
  let who;
  let actorId = null;
  if (ctx.actor) {
    who = String(ctx.actor.name || '').trim();
    actorId = ctx.actor.id ? String(ctx.actor.id) : null;
    if (!who || !actorId) throw new ActionError(401, 'Sign in to continue.');
    if (!(ctx.actor.roles || []).includes(a.role)) throw new ActionError(403, `You need the ${a.role} role to ${a.label.toLowerCase()}.`);
  } else {
    who = String(input.decidedBy || '').trim();
    if (!who) throw new ActionError(400, 'Enter your name so the decision is on record.');
    const roles = ctx.roles || {};
    const list = a.role === 'approver' ? roles.approvers : a.role === 'payer' ? roles.payers : roles.reviewers;
    if (!inRole(who, list)) throw new ActionError(403, `${who} is not allowed to ${a.label.toLowerCase()}. Allowed: ${list.join(', ')}.`);
  }
  if (ctx.policy?.segregateDuties && a.role === 'payer' && invoice.approval?.decidedBy) {
    // Compared by account when both are known; by name for older, typed approvals.
    const same = actorId && invoice.approval.decidedById ? invoice.approval.decidedById === actorId : invoice.approval.decidedBy.toLowerCase() === who.toLowerCase();
    if (same) throw new ActionError(403, 'The person who approved an invoice cannot also schedule or record its payment.');
  }
  const reason = blockedReason(invoice, actionId, ctx);
  if (reason) throw new ActionError(409, reason);
  const note = String(input.note || '').trim();
  const exceptions = failedChecks(invoice).length > 0;
  if (!note && (a.note === 'required' || (a.note === 'if_exceptions' && exceptions))) {
    throw new ActionError(400, exceptions && a.note === 'if_exceptions' ? 'Add a note explaining why you are approving despite the exceptions.' : 'Add a note with the reason.');
  }
  if (a.to && !canTransition(invoice.status, a.to)) throw new ActionError(409, `An invoice cannot move from ${STATUS_LABEL[invoice.status]} to ${STATUS_LABEL[a.to]}.`);
  return { who: who.slice(0, 120), actorId, note: note.slice(0, 1000), action: a };
}
