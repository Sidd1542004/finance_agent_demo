const formats = {};
const formatter = (currency) => {
  if (!formats[currency]) {
    try {
      formats[currency] = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-AU', { style: 'currency', currency });
    } catch {
      formats[currency] = formatter('AUD');
    }
  }
  return formats[currency];
};

// Amounts are AUD unless the invoice says otherwise (an Indian GST invoice is INR).
export const money = (n, currency = 'AUD') => (typeof n === 'number' && Number.isFinite(n) ? formatter(currency || 'AUD').format(n) : '—');

export const abn = (value) => {
  const d = String(value ?? '').replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : value || '—';
};

export const acn = (value) => {
  const d = String(value ?? '').replace(/\D/g, '');
  return d.length === 9 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : value || '—';
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-10-14" -> "14 Oct 2026". Anything else is shown as it was read.
export const day = (value) => {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : value || '—';
};

export const when = (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');

// The invoice lifecycle. Approval is not payment: an approved invoice still has
// to be scheduled and paid, and the agent never approves anything itself.
export const STATUS = {
  received: { label: 'Received', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'neutral' },
  under_review: { label: 'Under Review', tone: 'wait' },
  needs_review: { label: 'Needs Review', tone: 'wait' },
  on_hold: { label: 'On Hold', tone: 'wait' },
  approved: { label: 'Approved', tone: 'ok' },
  payment_pending: { label: 'Payment Pending', tone: 'ok' },
  payment_processing: { label: 'Payment Processing', tone: 'wait' },
  payment_completed: { label: 'Payment Completed', tone: 'ok' },
  payment_failed: { label: 'Payment Failed', tone: 'err' },
  rejected: { label: 'Rejected', tone: 'err' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  failed: { label: 'Could not process', tone: 'err' },
};

export const AWAITING_DECISION = ['under_review', 'needs_review', 'on_hold'];
export const TO_PAY = ['approved', 'payment_pending', 'payment_processing', 'payment_failed'];

// Payment records. "queued" is a scheduled payment: not paid until confirmed.
export const PAYMENT_STATUS = {
  queued: { label: 'Scheduled', tone: 'wait' },
  on_hold: { label: 'On hold', tone: 'wait' },
  processing: { label: 'Processing at the bank', tone: 'wait' },
  paid: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'err' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const BANK_STATUS = {
  PROCESSING: { label: 'Processing', tone: 'wait' },
  SUCCESS: { label: 'Success', tone: 'ok' },
  FAILED: { label: 'Failed', tone: 'err' },
  REJECTED: { label: 'Rejected', tone: 'err' },
};

export const NOTICE_KIND = { payment_success: 'Payment made', payment_processing: 'Payment in progress', payment_failed: 'Payment not completed' };

export const ROLE_LABEL = { reviewer: 'Reviewer', approver: 'Approver', payer: 'Payer', admin: 'Administrator' };
// An administrator also holds the reviewer, approver and payer roles. Mirrors
// server/src/auth/roles.js, which the server enforces; this only decides what to show.
const IMPLIED_ROLES = { admin: ['reviewer', 'approver', 'payer'] };
export const effectiveRoles = (roles) => [...new Set((roles || []).flatMap((r) => [r, ...(Object.hasOwn(IMPLIED_ROLES, r) ? IMPLIED_ROLES[r] : [])]))];
export const hasRole = (user, ...roles) => {
  if (!user) return false;
  const held = effectiveRoles(user.roles);
  return roles.some((r) => held.includes(r));
};

// A date and time in the business's time zone, e.g. "23 Oct 2026, 09:30 (Australia/Sydney)".
export const zoned = (iso, timeZone) => {
  if (!iso) return '—';
  try {
    return `${new Date(iso).toLocaleString('en-AU', { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}${timeZone ? ` (${timeZone})` : ''}`;
  } catch {
    return new Date(iso).toISOString();
  }
};

export const QUERY_STATUS = {
  received: { label: 'Received', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'neutral' },
  answered: { label: 'Answered', tone: 'ok' },
  needs_person: { label: 'Needs a person', tone: 'wait' },
  closed: { label: 'Closed, no reply', tone: 'neutral' },
  failed: { label: 'Could not process', tone: 'err' },
};

export const STATEMENT_STATUS = {
  received: { label: 'Received', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'neutral' },
  reconciled: { label: 'Reconciled', tone: 'ok' },
  needs_person: { label: 'Needs a person', tone: 'wait' },
  failed: { label: 'Could not reconcile', tone: 'err' },
};

export const REPORT_STATUS = {
  processing: { label: 'Processing', tone: 'neutral' },
  ready: { label: 'Ready to close', tone: 'ok' },
  open_items: { label: 'Items still open', tone: 'wait' },
  failed: { label: 'Could not complete', tone: 'err' },
};

export const LINE_STATUS = {
  matched: { label: 'Matched by the agent', tone: 'ok' },
  confirmed: { label: 'Matched by a person', tone: 'ok' },
  suggested: { label: 'Suggested match', tone: 'wait' },
  exception: { label: 'Needs a decision', tone: 'wait' },
  unmatched: { label: 'No match', tone: 'wait' },
  dismissed: { label: 'Dismissed', tone: 'neutral' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};
