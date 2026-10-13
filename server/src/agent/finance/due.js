// Due dates, overdue alerts and upcoming cash. Plain functions.

import { isNum } from './rules.js';

export const todayIso = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};
const endOfMonth = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const utc = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);

/**
 * Payment terms as written ("14 days", "Net 30", "30 days EOM", "Due on receipt")
 * -> { days, eom } or null when they cannot be read.
 */
export function parseTerms(terms) {
  const t = String(terms ?? '').toLowerCase();
  if (!t) return null;
  if (/on receipt|immediate|cash on delivery|\bcod\b/.test(t)) return { days: 0, eom: false };
  const m = t.match(/(\d{1,3})\s*(?:days?|d\b)/) || t.match(/net\s*(\d{1,3})/);
  if (!m) return null;
  return { days: Number(m[1]), eom: /\beom\b|end of (the )?month/.test(t) };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// When is the invoice due? The due date shown wins; otherwise invoice date + terms.
export function dueInfo(extracted, today = todayIso()) {
  const e = extracted || {};
  let date = null;
  let source = null;
  if (ISO.test(e.dueDate || '')) {
    date = e.dueDate;
    source = 'invoice';
  } else if (ISO.test(e.invoiceDate || '')) {
    const terms = parseTerms(e.paymentTerms);
    if (terms) {
      date = addDays(terms.eom ? endOfMonth(e.invoiceDate) : e.invoiceDate, terms.days);
      source = 'terms';
    }
  }
  if (!date) return { date: null, source: null, terms: e.paymentTerms || null, daysUntil: null, state: 'unknown' };
  const daysUntil = daysBetween(today, date);
  return { date, source, terms: e.paymentTerms || null, daysUntil, state: daysUntil < 0 ? 'overdue' : daysUntil <= 7 ? 'due_soon' : 'later' };
}

const UNPAID = ['under_review', 'needs_review', 'on_hold', 'approved', 'payment_pending', 'payment_failed'];

/**
 * Overdue and due-soon invoices, and the cash needed.
 * @param invoices [{ id, invoiceNumber, vendorName, total, status, extracted, approval, payment }]
 */
export function payablesSummary(invoices, today = todayIso()) {
  const open = invoices.filter((i) => UNPAID.includes(i.status));
  const rows = open.map((i) => {
    const due = dueInfo(i.extracted, today);
    const amount = isNum(i.payment?.amount) ? i.payment.amount : isNum(i.approval?.amount) ? i.approval.amount : i.extracted?.total;
    return {
      id: i.id,
      invoiceNumber: i.extracted?.invoiceNumber ?? null,
      vendorName: i.extracted?.vendorName ?? null,
      currency: i.extracted?.currency || 'AUD',
      amount: isNum(amount) ? amount : null,
      status: i.status,
      dueDate: due.date,
      dueSource: due.source,
      terms: due.terms,
      daysUntil: due.daysUntil,
      state: due.state,
    };
  });
  const sum = (list) => Math.round(list.reduce((s, r) => s + (r.currency === 'AUD' && isNum(r.amount) ? r.amount : 0), 0) * 100) / 100;
  const approvedish = (r) => ['approved', 'payment_pending', 'payment_failed'].includes(r.status);
  const within = (n) => rows.filter((r) => r.dueDate && r.daysUntil <= n);
  const byDue = (a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999');
  return {
    today,
    overdue: rows.filter((r) => r.state === 'overdue').sort(byDue),
    dueSoon: rows.filter((r) => r.state === 'due_soon').sort(byDue),
    noDueDate: rows.filter((r) => r.state === 'unknown').length,
    cash: {
      // AUD only; other currencies are listed but not added up.
      approvedDue7: sum(within(7).filter(approvedish)),
      approvedDue30: sum(within(30).filter(approvedish)),
      awaitingDecisionDue7: sum(within(7).filter((r) => !approvedish(r))),
      allApprovedUnpaid: sum(rows.filter(approvedish)),
    },
  };
}
