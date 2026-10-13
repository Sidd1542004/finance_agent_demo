// Month-end report figures. Plain functions, no database, no AI.
//
// Every number in the report is calculated here. The AI model is only asked to
// put the figures into a short paragraph, and that paragraph is checked against
// the figures before it is kept.

import { cents, money, isNum } from './rules.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const isMonth = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value ?? ''));

// The month in the server's local time zone.
export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1), label: `${MONTHS[m - 1]} ${y}` };
}

export function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export const monthOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

// Check labels describe what passing looks like ("Purchase order found"). A
// report needs the opposite: why the invoice was held.
const HELD_REASON = {
  required_fields: 'Details missing from the invoice',
  reader_confidence: 'Invoice could not be read with confidence',
  jurisdiction: 'Tax rules could not be identified',
  supplier_tax_id: 'ABN or GSTIN missing or not valid',
  gst_registration: 'GST charged by a supplier not registered for GST',
  tax_charged: 'GST is wrong',
  supplier_known: 'Supplier is not on the approved list',
  arithmetic: 'Amounts do not add up',
  duplicate: 'Possible duplicate invoice',
  po_found: 'No matching purchase order',
  price_match: 'Item or price differs from the purchase order',
  quantity_match: 'Quantity is more than was ordered or received',
  match_score: 'Match score below the threshold',
};

const total = (list, pick) => list.reduce((sum, item) => sum + cents(pick(item) || 0), 0) / 100;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// One open item per statement that still has undecided lines, naming the file
// and the lines, so a person can find them. Dismissed, confirmed, matched and
// skipped lines are decided and never counted here.
const OPEN_LINE = ['suggested', 'exception', 'unmatched'];
const listNumbers = (ns) => (ns.length === 1 ? String(ns[0]) : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

function openBankItems(statements) {
  const items = [];
  for (const s of statements) {
    const open = (s.lines || []).filter((l) => OPEN_LINE.includes(l.status));
    if (!open.length) continue;
    const name = s.filename || 'a pasted statement';
    const copies = s.filename ? statements.filter((x) => x.filename === s.filename).length : 1;
    items.push(
      `${plural(open.length, 'bank line')} on ${name} ${open.length === 1 ? 'needs' : 'need'} a decision (line${open.length === 1 ? '' : 's'} ${listNumbers(open.map((l) => l.n))}).` +
        (copies > 1 ? ` This file was reconciled ${copies} times this month, and this copy is still open.` : ''),
    );
  }
  return items;
}

/**
 * @param invoices   invoices received in the month (ledger.listInvoices format)
 * @param payments   every payment (ledger.listPayments format)
 * @param queries    supplier emails received in the month
 * @param statements bank statements received in the month
 */
export function buildFigures({ month, invoices, payments, queries, statements }) {
  const { label } = monthRange(month);
  const ids = new Set(invoices.map((i) => i.id));
  const pay = payments.filter((p) => ids.has(p.invoiceId));
  const withStatus = (s) => invoices.filter((i) => i.status === s);

  const inStatus = (list) => invoices.filter((i) => list.includes(i.status));
  const approved = inStatus(['approved', 'payment_pending', 'payment_completed', 'payment_failed']);
  const waiting = inStatus(['under_review', 'needs_review', 'on_hold']);
  const rejected = withStatus('rejected');
  const cancelled = withStatus('cancelled');
  const failed = withStatus('failed');
  const inProgress = invoices.length - approved.length - waiting.length - rejected.length - cancelled.length - failed.length;
  const readable = invoices.length - failed.length;
  // "Cleared by the agent": the agent found no exceptions and scored it at or
  // above the threshold, so it went straight to approval review.
  const cleared = invoices.filter((i) => i.agentOutcome === 'under_review');

  const paid = pay.filter((p) => p.status === 'paid');
  const queued = pay.filter((p) => p.status === 'queued');
  const amountOf = (i) => (isNum(i.approvedAmount) ? i.approvedAmount : i.total);
  const paidFor = (i) => paid.filter((p) => p.invoiceId === i.id).reduce((s, p) => s + (isNum(p.paidAmount) ? p.paidAmount : p.amount), 0);
  const unpaid = approved.filter((i) => i.status !== 'payment_completed');

  const reasons = new Map();
  for (const invoice of invoices) {
    const failedList = invoice.failedChecks || [];
    for (const check of failedList) {
      // A low match score is usually the result of another failure; it is only
      // counted as the reason when nothing else failed.
      if (check.id === 'match_score' && failedList.length > 1) continue;
      const entry = reasons.get(check.id) || { id: check.id, label: HELD_REASON[check.id] || check.label, count: 0 };
      entry.count += 1;
      reasons.set(check.id, entry);
    }
  }

  const suppliers = new Map();
  for (const i of unpaid) {
    const name = i.vendorName || 'Unknown supplier';
    const entry = suppliers.get(name) || { vendorName: name, count: 0, cents: 0, earliestDue: null };
    entry.count += 1;
    entry.cents += cents(amountOf(i)) - cents(paidFor(i));
    if (i.dueDate && (!entry.earliestDue || i.dueDate < entry.earliestDue)) entry.earliestDue = i.dueDate;
    suppliers.set(name, entry);
  }

  const lines = statements.flatMap((s) => s.lines || []);
  const matched = lines.filter((l) => l.status === 'matched' || l.status === 'confirmed');
  const openLines = lines.filter((l) => OPEN_LINE.includes(l.status));
  const queriesWaiting = queries.filter((q) => q.status === 'needs_person' || q.status === 'failed').length;
  const statementsFailed = statements.filter((s) => s.status === 'failed').length;

  const openItems = [
    ...waiting.map((i) => `Invoice ${i.invoiceNumber || '(no number)'} from ${i.vendorName || 'an unknown supplier'} (${money(i.total)}) ${i.status === 'under_review' ? 'is waiting for approval' : i.status === 'on_hold' ? 'is on hold' : 'needs review'}.`),
    ...inStatus(['approved']).map((i) => `Invoice ${i.invoiceNumber || '(no number)'} from ${i.vendorName || 'an unknown supplier'} is approved but its payment is not scheduled.`),
    ...inStatus(['payment_failed']).map((i) => `The payment for invoice ${i.invoiceNumber || '(no number)'} from ${i.vendorName || 'an unknown supplier'} failed.`),
    ...(failed.length ? [`${plural(failed.length, 'invoice')} could not be processed.`] : []),
    ...(queriesWaiting ? [`${plural(queriesWaiting, 'supplier email')} ${queriesWaiting === 1 ? 'is' : 'are'} waiting for a reply.`] : []),
    ...openBankItems(statements),
    ...(statementsFailed ? [`${plural(statementsFailed, 'bank statement')} could not be reconciled.`] : []),
  ];

  return {
    month,
    label,
    invoices: {
      received: invoices.length,
      valueReceived: total(invoices, (i) => i.total),
      clearedByAgent: cleared.length,
      approvedByPerson: approved.length,
      waiting: waiting.length,
      rejected: rejected.length,
      cancelled: cancelled.length,
      failed: failed.length,
      inProgress,
      // Share of readable invoices the agent cleared for approval review with no exceptions.
      clearedPct: readable > 0 ? Math.round((cleared.length / readable) * 100) : null,
    },
    payments: {
      approvedCount: approved.length,
      approvedValue: total(approved, amountOf),
      scheduledValue: total(queued, (p) => p.amount),
      paidCount: paid.length,
      paidValue: total(paid, (p) => (isNum(p.paidAmount) ? p.paidAmount : p.amount)),
      outstandingCount: unpaid.length,
      outstandingValue: Math.round((total(approved, amountOf) - total(paid, (p) => (isNum(p.paidAmount) ? p.paidAmount : p.amount))) * 100) / 100,
    },
    outstandingBySupplier: [...suppliers.values()]
      .map((s) => ({ vendorName: s.vendorName, count: s.count, value: s.cents / 100, earliestDue: s.earliestDue }))
      .sort((a, b) => b.value - a.value),
    heldReasons: [...reasons.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    queries: {
      received: queries.length,
      answeredByAgent: queries.filter((q) => q.status === 'answered' && q.auto).length,
      answeredByPerson: queries.filter((q) => q.status === 'answered' && !q.auto).length,
      closedWithoutReply: queries.filter((q) => q.status === 'closed').length,
      waiting: queriesWaiting,
    },
    bank: {
      statements: statements.length,
      linesMatched: matched.length,
      valueMatched: total(matched, (l) => Math.abs(l.amount)),
      linesOpen: openLines.length,
      linesDismissed: lines.filter((l) => l.status === 'dismissed').length,
    },
    openItems,
    // For the consistency check only.
    scheduledInvoices: inStatus(['payment_pending', 'payment_completed']).length,
    livePayments: invoices.filter((i) => ['payment_pending', 'payment_completed'].includes(i.status) && pay.some((p) => p.invoiceId === i.id && ['queued', 'paid'].includes(p.status))).length,
  };
}

// "Variance information": this month against the month before, for the measures
// a finance manager watches. `change` is this month minus last month.
const COMPARE = [
  ['received', 'Invoices received', (f) => f.invoices.received],
  ['valueReceived', 'Value of invoices received', (f) => f.invoices.valueReceived, true],
  ['clearedByAgent', 'Cleared by the agent for approval', (f) => f.invoices.clearedByAgent],
  ['approvedByPerson', 'Approved by a person', (f) => f.invoices.approvedByPerson],
  ['approvedValue', 'Approved for payment', (f) => f.payments.approvedValue, true],
  ['paidValue', 'Confirmed paid by the bank', (f) => f.payments.paidValue, true],
  ['queries', 'Supplier emails received', (f) => f.queries.received],
];

export function compareMonths(current, previous) {
  return {
    label: previous.label,
    hasData: previous.invoices.received > 0 || previous.queries.received > 0 || previous.bank.statements > 0,
    rows: COMPARE.map(([id, label, pick, isMoney]) => {
      const now = pick(current);
      const before = pick(previous);
      return { id, label, money: Boolean(isMoney), current: now, previous: before, change: Math.round((now - before) * 100) / 100 };
    }),
  };
}

// The figures must agree with each other before a report is published.
export function checkFigures(f) {
  const problems = [];
  const i = f.invoices;
  const p = f.payments;
  if (i.received !== i.approvedByPerson + i.waiting + i.rejected + i.cancelled + i.failed + i.inProgress) problems.push('Invoice counts by status do not add up to the number received.');
  if (cents(p.approvedValue) !== cents(p.paidValue) + cents(p.outstandingValue)) problems.push('Paid plus outstanding does not equal the value approved.');
  if (cents(f.outstandingBySupplier.reduce((s, x) => s + x.value, 0)) !== cents(p.outstandingValue)) problems.push('Outstanding by supplier does not add up to the outstanding total.');
  if (f.scheduledInvoices !== f.livePayments) problems.push(`${f.scheduledInvoices} invoices are Payment Pending or Payment Completed, but ${f.livePayments} have a live payment.`);
  return problems;
}

// Standard wording, used when there is no AI reader or its text fails the check.
export function templateCommentary(f) {
  const i = f.invoices;
  const p = f.payments;
  if (i.received === 0) return `No invoices were received in ${f.label}.`;
  const out = [];
  out.push(`In ${f.label}, ${plural(i.received, 'invoice was', 'invoices were')} received, worth ${money(i.valueReceived)} in total.`);
  out.push(
    `The agent cleared ${i.clearedByAgent} for approval review with no exceptions${i.clearedPct === null ? '' : ` (${i.clearedPct}% of the invoices it could read)`}; people approved ${i.approvedByPerson}, ${i.waiting} ${i.waiting === 1 ? 'is' : 'are'} still waiting for a decision and ${i.rejected} ${i.rejected === 1 ? 'was' : 'were'} rejected.`,
  );
  out.push(`${money(p.approvedValue)} has been approved: ${money(p.paidValue)} is paid and ${money(p.outstandingValue)} is still to pay.`);
  if (f.heldReasons.length) out.push(`The most common reason an invoice needed a person was "${f.heldReasons[0].label}" (${f.heldReasons[0].count}).`);
  if (f.queries.received) out.push(`${plural(f.queries.received, 'supplier email was', 'supplier emails were')} received and the agent answered ${f.queries.answeredByAgent} without a person.`);
  const c = f.comparison;
  if (c?.hasData) {
    const row = (id) => c.rows.find((r) => r.id === id);
    const fmt = (r, v) => (r.money ? money(v) : String(v));
    const parts = ['received', 'valueReceived', 'paidValue'].map((id) => row(id)).map((r) => `${r.label.toLowerCase()} went from ${fmt(r, r.previous)} to ${fmt(r, r.current)}`);
    out.push(`Compared with ${c.label}, ${parts.join(', ')}.`);
  }
  if (f.bank.statements) out.push(`Bank reconciliation matched ${plural(f.bank.linesMatched, 'line')} (${money(f.bank.valueMatched)}); ${f.bank.linesOpen} still ${f.bank.linesOpen === 1 ? 'needs' : 'need'} a decision.`);
  return out.join(' ');
}

// ---------- Checking AI commentary against the figures ----------

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const toNumbers = (text) => (String(text).match(NUMBER) || []).map((t) => Number(t.replace(/,/g, ''))).filter(Number.isFinite);

function collect(value, into) {
  if (typeof value === 'number') into.add(Math.abs(Math.round(value * 100)));
  else if (typeof value === 'string') for (const n of toNumbers(value)) into.add(Math.round(n * 100));
  else if (Array.isArray(value)) for (const v of value) collect(v, into);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collect(v, into);
}

// Numbers in the commentary that are not in the figures. A model that adds up,
// rounds or invents a number is caught here.
export function ungroundedNumbers(text, figures) {
  const allowed = new Set();
  collect(figures, allowed);
  return [...new Set(toNumbers(text).filter((n) => !allowed.has(Math.round(n * 100))))];
}

export function figuresToCsv(f) {
  const rows = [['Section', 'Item', 'Value']];
  const add = (section, item, value) => rows.push([section, item, value ?? '']);
  add('Report', 'Month', f.label);
  add('Invoices', 'Received', f.invoices.received);
  add('Invoices', 'Value received (AUD)', f.invoices.valueReceived.toFixed(2));
  add('Invoices', 'Cleared by the agent for approval review', f.invoices.clearedByAgent);
  add('Invoices', 'Approved by a person', f.invoices.approvedByPerson);
  add('Invoices', 'Waiting for a decision', f.invoices.waiting);
  add('Invoices', 'Rejected', f.invoices.rejected);
  add('Invoices', 'Cancelled', f.invoices.cancelled);
  add('Invoices', 'Could not be processed', f.invoices.failed);
  add('Invoices', 'Cleared by the agent (% of readable)', f.invoices.clearedPct);
  add('Payments', 'Approved (count)', f.payments.approvedCount);
  add('Payments', 'Approved (AUD)', f.payments.approvedValue.toFixed(2));
  add('Payments', 'Scheduled, not yet paid (AUD)', f.payments.scheduledValue.toFixed(2));
  add('Payments', 'Paid (AUD)', f.payments.paidValue.toFixed(2));
  add('Payments', 'Still to pay (AUD)', f.payments.outstandingValue.toFixed(2));
  for (const s of f.outstandingBySupplier) add('Still to pay by supplier (AUD)', s.vendorName, s.value.toFixed(2));
  for (const r of f.heldReasons) add('Why invoices needed a person', r.label, r.count);
  add('Supplier emails', 'Received', f.queries.received);
  add('Supplier emails', 'Answered by the agent', f.queries.answeredByAgent);
  add('Supplier emails', 'Answered by a person', f.queries.answeredByPerson);
  add('Supplier emails', 'Closed without a reply', f.queries.closedWithoutReply);
  add('Supplier emails', 'Waiting', f.queries.waiting);
  add('Bank', 'Statements', f.bank.statements);
  add('Bank', 'Lines matched', f.bank.linesMatched);
  add('Bank', 'Value matched (AUD)', f.bank.valueMatched.toFixed(2));
  add('Bank', 'Lines needing a decision', f.bank.linesOpen);
  if (f.comparison) {
    for (const r of f.comparison.rows) {
      const v = (x) => (r.money ? x.toFixed(2) : x);
      add(`Compared with ${f.comparison.label}`, `${r.label}${r.money ? ' (AUD)' : ''}: this month / last month / change`, `${v(r.current)} / ${v(r.previous)} / ${v(r.change)}`);
    }
  }
  for (const item of f.openItems) add('Open items', item, '');
  const cell = (v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
