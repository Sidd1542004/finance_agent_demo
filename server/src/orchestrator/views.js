// Compact views of our records for the orchestrator's model
// (docs/agentic-analysis.md §9 and §10.5). Built from what the listings and
// services return for the person the run acts for, so the services' role
// checks and bank-detail masking still apply. On top of that:
//
// - Never: rawText, email bodies, draft reply bodies, file contents, tokens,
//   email addresses or people's names.
// - Bank details: only the masked values the existing masking produced
//   (agent/finance/beneficiary.js mask), under a `bank` field, and only for
//   payers, approvers and administrators. Reviewers get no bank field at all.
// - Text from outside (supplier names, line descriptions, email subjects,
//   bank-line descriptions) and any sentence that can quote it (check details,
//   reasons) is wrapped as { untrusted_text }, without invisible characters,
//   and cut to UNTRUSTED_MAX characters. The model's prompt says such text is
//   data, not instructions.
// - For anyone who may not see bank details (reviewers), numbers in that text
//   that could be bank details are hidden (forViewer). Outside text can carry
//   an account number someone typed; payers, approvers and admins see it as
//   the existing screens show it.
// - The audit log's own text (detail, reason) never reaches the model: it can
//   hold email addresses, people's notes and bank details. History entries
//   carry a fixed summary of the action instead.
// - Plain values are only ids, numbers, booleans, dates and the statuses and
//   kinds our own code sets, each checked for its shape. A document identifier
//   (invoice, PO or item number) stays plain only when it looks like one;
//   otherwise it is untrusted text too. Numbers and statuses come from our
//   records, never from the text.

import { seesMaskedBankDetails } from '../agent/finance/beneficiary.js';

export const UNTRUSTED_MAX = 200;
export const UNTRUSTED_FIELD = 'untrusted_text';

// Control characters, including line and paragraph separators.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

// Characters that do not show but can hide or reorder text: the soft hyphen,
// zero-width spaces and joiners, text-direction marks, embeddings, overrides
// and isolates, invisible operators, variation selectors, the byte-order mark,
// filler characters, interlinear annotation marks, and Unicode "tag"
// characters (which can carry invisible instructions to a model). Built from
// code points, so this file contains none of them itself.
const INVISIBLE_RANGES = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];
export const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]`, 'gu');

/**
 * Outside text as { untrusted_text }: invisible characters removed, one line,
 * at most UNTRUSTED_MAX characters ({ truncated: true } when cut). A cut never
 * leaves the first digits of a longer number behind.
 */
export function untrusted(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const chars = Array.from(s); // never splits a character in two
  if (chars.length <= UNTRUSTED_MAX) return { [UNTRUSTED_FIELD]: s };
  let cut = chars.slice(0, UNTRUSTED_MAX).join('');
  if (/\d$/.test(cut) && /^[ -]?\d/.test(chars.slice(UNTRUSTED_MAX, UNTRUSTED_MAX + 2).join(''))) cut = cut.replace(/\d(?:[ -]?\d)*$/, '');
  return { [UNTRUSTED_FIELD]: cut.trimEnd(), truncated: true };
}

// ----- numbers that could be bank details, in outside text -----

export const NUMBER_HIDDEN = '[number hidden]';
// Words that say a number nearby is about a bank account, a biller or a card.
const BANK_WORDS = /\b(?:bsb|bpay|biller|crn|acct|a\/c|account|bank|banking|card|iban|swift|routing|sort\s*code|remit)/i;
// A run of digits, optionally grouped by single spaces or hyphens, that is not
// part of a code (HOS-10482, SIMTXN-2026...), an amount ($1,402.50, 727.10) or a date (01/11/2026).
const digitRun = (min) => new RegExp(`(?<![A-Za-z0-9.,/-])\\d(?:[ -]?\\d){${min - 1},}(?![0-9A-Za-z]|[.,]\\d)`, 'g');
const LONG_RUN = digitRun(6); // BSBs, account numbers, CRNs, card numbers
const SHORT_RUN = digitRun(4); // also biller codes, when the text talks about banking
const CARD_TOKEN = /\bSIMCARD-[A-Za-z0-9]+/gi;
const digitCount = (s) => s.replace(/\D/g, '').length;

/**
 * Hide every number in `text` that could be a bank detail: a BSB, account
 * number, biller code, CRN or card. Kept: ISO dates, years (when looking for
 * short numbers) and an 11-digit ABN that says it is one ("ABN 57 600 410 275").
 */
export function hideBankNumbers(text) {
  const s = String(text).replace(CARD_TOKEN, NUMBER_HIDDEN);
  const bankish = BANK_WORDS.test(s);
  return s.replace(bankish ? SHORT_RUN : LONG_RUN, (m, offset) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(m)) return m;
    if (bankish && /^(?:19|20)\d{2}$/.test(m)) return m;
    if (digitCount(m) === 11 && /\bABN[\s:#]{0,3}$/i.test(s.slice(Math.max(0, offset - 8), offset))) return m;
    return NUMBER_HIDDEN;
  });
}

function hideInText(value) {
  if (Array.isArray(value)) return value.map(hideInText);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === UNTRUSTED_FIELD && typeof v === 'string' ? hideBankNumbers(v) : hideInText(v);
    return out;
  }
  return value;
}

/**
 * A view as this person may see it. Payers, approvers and administrators: as
 * built. Anyone else (reviewers): numbers that could be bank details are
 * hidden in every untrusted text. Applied by tools.js to every tool's result.
 */
export const forViewer = (view, viewer) => (seesMaskedBankDetails(viewer) ? view : hideInText(view));

const CODE = /^[A-Za-z0-9][A-Za-z0-9._/#-]{0,39}$/;
/** A document identifier: plain when it looks like one, otherwise untrusted text. */
export function code(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  return CODE.test(s) ? s : untrusted(s);
}

const word = (v) => (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(v) ? v : null); // statuses, kinds, outcomes
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const month = (v) => (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v) ? v : null);
const hhmm = (v) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null);
const currency = (v) => (typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : null);
const abn = (v) => {
  const s = String(v ?? '').replace(/\s/g, '');
  return /^\d{11}$/.test(s) ? s : null;
};
const oid = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[a-f0-9]{24}$/i.test(s) ? s : null;
};
const subjectId = (v) => (typeof v === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(v) ? v : null);
const when = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const list = (arr, fn, max) => (Array.isArray(arr) ? arr.slice(0, max).map(fn) : []);
const texts = (arr, max = 10) => list(arr, untrusted, max).filter(Boolean);
const words = (arr, max = 30) => list(arr, word, max).filter(Boolean);

/** Numbers (and nested objects of numbers) only: counts, totals, KPIs. */
function numbersOnly(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 3) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (num(v) !== null) out[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = numbersOnly(v, depth + 1);
      if (inner) out[k] = inner;
    }
  }
  return out;
}

// ----- bank details: masked, and never for reviewers -----

const MASKED_FIELDS = ['bsb', 'accountNumber', 'billerCode', 'crn', 'cardToken'];

// The masked values only; a value without the mask character is dropped.
function maskedBank(masked, method = null) {
  if (!masked || typeof masked !== 'object') return null;
  const out = { method: word(method) };
  for (const k of MASKED_FIELDS) if (typeof masked[k] === 'string' && masked[k].includes('•')) out[k] = masked[k];
  out.methods = words(masked.methods, 5);
  return out;
}

// { bank } for payers, approvers and administrators; nothing at all for anyone else.
const withBank = (viewer, value) => (value && seesMaskedBankDetails(viewer) ? { bank: value } : {});

// ----- invoices -----

const dueView = (due) => (due ? { date: day(due.date), source: word(due.source), daysUntil: num(due.daysUntil), state: word(due.state) } : null);
const checkView = (c) => ({ id: word(c?.id), status: word(c?.status), severity: word(c?.severity), detail: untrusted(c?.detail) });
const lineView = (l) => ({ sku: code(l?.sku), description: untrusted(l?.description), qty: num(l?.qty), unitPrice: num(l?.unitPrice), amount: num(l?.amount) });

export const invoiceListItem = (d) => ({
  id: oid(d._id),
  status: word(d.status),
  source: word(d.source?.kind),
  supplier: untrusted(d.extracted?.vendorName),
  invoiceNumber: code(d.extracted?.invoiceNumber),
  total: num(d.extracted?.total),
  currency: currency(d.extracted?.currency),
  due: dueView(d.due),
  score: num(d.match?.score?.total),
  failedChecks: words((d.checks || []).filter((c) => c?.status === 'fail').map((c) => c.id)),
  outcome: word(d.decision?.outcome),
  approval: word(d.approval?.decision),
  recovery: word(d.recovery?.status),
  createdAt: when(d.createdAt),
});

export const invoiceList = (page) => ({ items: page.items.map(invoiceListItem), nextCursor: when(page.nextCursor), counts: numbersOnly(page.counts) });

// A list item plus the ABN of the supplier the agent matched it to (null when not matched).
const withSupplierAbn = (d) => ({ ...invoiceListItem(d), supplierAbn: abn(d.supplier?.abn) });

/** listings.findInvoicesByNumber: the invoices with that number. */
export const foundInvoices = (r) => ({ items: r.items.map(withSupplierAbn) });

/** listings.listOpenInvoices: unpaid invoices, at most 100, and how many there are in all. */
export const openInvoiceList = (r) => ({ items: r.items.map(withSupplierAbn), total: num(r.total), more: num(r.total) !== null && r.total > r.items.length });

const poView = (p) => ({
  poNumber: code(p.poNumber),
  supplierAbn: abn(p.vendorAbn),
  supplier: untrusted(p.vendorName),
  raisedOn: day(p.raisedOn),
  lines: list(p.lines, (l) => ({ sku: code(l?.sku), description: untrusted(l?.description), qty: num(l?.qty), unitPrice: num(l?.unitPrice) }), 50),
});

const actionView = (a) => ({
  id: word(a?.id),
  enabled: bool(a?.enabled),
  permitted: bool(a?.permitted),
  role: word(a?.role),
  noteRequired: bool(a?.noteRequired),
  reason: untrusted(a?.reason),
});

/** getInvoiceDetail(id, actor) as the model sees it. */
export function invoiceDetail(d, viewer) {
  const inv = d.invoice;
  const e = inv.extracted || {};
  const score = inv.match?.score;
  return {
    ...invoiceListItem(inv),
    supplierAbn: abn(e.abn),
    matchedSupplier: inv.supplier ? { name: untrusted(inv.supplier.name), abn: abn(inv.supplier.abn), by: word(inv.supplier.by) } : null,
    invoiceDate: day(e.invoiceDate),
    dueDate: day(e.dueDate),
    poNumber: code(e.poNumber),
    subtotal: num(e.subtotal),
    gst: num(e.gst),
    lines: list(e.lines, lineView, 50),
    lineCount: Array.isArray(e.lines) ? e.lines.length : 0,
    reading: inv.extraction ? { method: word(inv.extraction.method), confidence: num(inv.extraction.confidence) } : null,
    checks: list(inv.checks, checkView, 40),
    score: score ? { total: num(score.total), threshold: num(score.threshold), eligible: bool(score.eligible) } : null,
    reasons: texts(inv.decision?.reasons),
    matchedPo: code(inv.matchedPo),
    po: d.po ? poView(d.po) : null,
    poSuggestions: list(
      inv.match?.suggestions,
      (s) => ({ poNumber: code(s?.poNumber), supplier: untrusted(s?.vendorName), score: num(s?.score), supplierOwnership: word(s?.supplierOwnership) }),
      5,
    ),
    duplicates: list(inv.match?.duplicates, (c) => ({ id: oid(c?.id), invoiceNumber: code(c?.invoiceNumber), status: word(c?.status), signals: words(c?.signals, 10) }), 10),
    receivedOnly: d.receivedOnly
      ? { subtotal: num(d.receivedOnly.subtotal), gst: num(d.receivedOnly.gst), total: num(d.receivedOnly.total), invoiceTotal: num(d.receivedOnly.invoiceTotal) }
      : null,
    approval: inv.approval ? { decision: word(inv.approval.decision), at: when(inv.approval.decidedAt), amount: num(inv.approval.amount) } : null,
    payment: d.payment ? paymentView(d.payment, viewer) : null,
    paymentJobs: list(d.jobs, jobView, 10),
    bankTransaction: transactionView(d.bankTransaction),
    notices: list(d.notices, noticeView, 10),
    actions: list(d.actions, actionView, 40),
    linkablePos: list(d.linkablePos, (p) => ({ poNumber: code(p?.poNumber), supplier: untrusted(p?.vendorName) }), 20),
    documents: list(d.documents, (doc) => ({ kind: word(doc?.kind), available: bool(doc?.available) }), 5),
  };
}

/** getPayables(): overdue and due-soon invoices and the cash needed. */
export function payables(r) {
  const row = (x) => ({
    id: oid(x.id),
    invoiceNumber: code(x.invoiceNumber),
    supplier: untrusted(x.vendorName),
    amount: num(x.amount),
    currency: currency(x.currency),
    status: word(x.status),
    dueDate: day(x.dueDate),
    dueSource: word(x.dueSource),
    daysUntil: num(x.daysUntil),
    state: word(x.state),
  });
  return { today: day(r.today), overdue: list(r.overdue, row, 100), dueSoon: list(r.dueSoon, row, 100), noDueDate: num(r.noDueDate), cash: numbersOnly(r.cash) };
}

// ----- payments -----

const jobView = (j) => ({ status: word(j?.status), attempts: num(j?.attempts), runAt: when(j?.runAt), result: untrusted(j?.result), lastError: untrusted(j?.lastError) });
const noticeView = (n) => ({ id: oid(n?._id), kind: word(n?.kind), status: word(n?.status) }); // status only: never the text
const transactionView = (t) => (t ? { ref: code(t.ref), status: word(t.status), amount: num(t.amount), settledAt: when(t.settledAt), failureCode: word(t.failureCode) } : null);

/** A payment (list item, or one already masked for the viewer by bankViews.paymentFor). */
export function paymentView(p, viewer) {
  const b = p.beneficiary;
  return {
    id: oid(p._id),
    invoiceId: oid(p.invoiceId),
    invoiceNumber: code(p.invoiceNumber),
    supplier: untrusted(p.vendorName),
    amount: num(p.amount),
    paidAmount: num(p.paidAmount),
    currency: currency(p.currency),
    method: word(p.method),
    route: word(p.route || 'manual'),
    status: word(p.status),
    scheduledFor: day(p.scheduledFor),
    txnRef: code(p.txnRef ?? p.confirmation?.txnRef ?? p.submission?.txnRef),
    completesAt: when(p.completesAt ?? p.submission?.completesAt),
    confirmedAt: when(p.confirmedAt ?? p.confirmation?.confirmedAt),
    failure: p.failure ? { code: word(p.failure.code), reason: untrusted(p.failure.reason) } : null,
    simulated: true,
    ...withBank(viewer, b && !b.hidden ? maskedBank(b.masked, b.method) : null),
  };
}

export const paymentList = (r, viewer) => ({ items: r.items.map((p) => paymentView(p, viewer)), counts: numbersOnly(r.counts) });

/** getPayment(actor, id). Jobs without their history, notices by status only. */
export const paymentDetail = (r, viewer) => ({
  payment: paymentView(r.payment, viewer),
  jobs: list(r.jobs, jobView, 20),
  transaction: transactionView(r.transaction),
  notices: list(r.notices, noticeView, 20),
});

/** paymentCalendar.validateSlot({ date, time }). */
export const slot = (r) =>
  r.ok
    ? { ok: true, date: day(r.date), time: hhmm(r.time), runAt: when(r.runAt) }
    : { ok: false, problem: untrusted(r.problem), suggestion: r.suggestion ? { date: day(r.suggestion.date), time: hhmm(r.suggestion.time) } : null };

// ----- supplier emails -----

export const queryList = (page) => ({
  items: page.items.map((q) => ({
    id: oid(q._id),
    status: word(q.status),
    supplier: untrusted(q.supplier?.name),
    subject: untrusted(q.subject),
    outcome: word(q.decision?.outcome),
    createdAt: when(q.createdAt),
  })),
  nextCursor: when(page.nextCursor),
});

/** getQueryDetail(id). Never the email's body or the draft reply's body. */
export function queryDetail(r) {
  const q = r.query;
  return {
    id: oid(q._id),
    status: word(q.status),
    supplier: q.supplier ? { name: untrusted(q.supplier.name), abn: abn(q.supplier.abn) } : null,
    subject: untrusted(q.subject),
    intent: word(q.understood?.intent),
    invoiceNumbers: list(q.understood?.invoiceNumbers, code, 10).filter(Boolean),
    reading: q.reading ? { method: word(q.reading.method), confidence: num(q.reading.confidence) } : null,
    matchedInvoices: list(
      q.matchedInvoices,
      (m) => ({
        invoiceNumber: code(m?.invoiceNumber),
        onFile: bool(m?.onFile),
        belongsToSender: bool(m?.belongsToSender),
        status: word(m?.status),
        total: num(m?.total),
        dueDate: day(m?.dueDate),
        paymentStatus: word(m?.paymentStatus),
        paidOn: day(m?.paidOn),
      }),
      10,
    ),
    checks: list(q.checks, checkView, 20),
    outcome: word(q.decision?.outcome),
    reasons: texts(q.decision?.reasons),
    draft: q.draft ? { subject: untrusted(q.draft.subject), hasText: Boolean(q.draft.body) } : null,
    reply: r.message ? { id: oid(r.message._id), kind: word(r.message.kind), status: word(r.message.status), sentAt: when(r.message.sentAt) } : null,
    resolution: q.resolution ? { action: word(q.resolution.action) } : null,
    createdAt: when(q.createdAt),
  };
}

// ----- bank statements -----

export const statementList = (page) => ({
  items: page.items.map((s) => ({
    id: oid(s._id),
    status: word(s.status),
    source: word(s.source?.kind),
    lineCount: num(s.lineCount),
    openCount: num(s.openCount),
    createdAt: when(s.createdAt),
  })),
  nextCursor: when(page.nextCursor),
});

/** getStatementDetail(id). Never the statement's raw text; descriptions are untrusted. */
export function statementDetail(r) {
  const s = r.statement;
  const id = oid(s._id);
  return {
    id,
    status: word(s.status),
    lines: list(
      s.lines,
      (l) => ({
        lineId: id && num(l?.n) !== null ? `${id}:${l.n}` : null, // the bank line's id in the audit log
        n: num(l?.n),
        date: day(l?.date),
        amount: num(l?.amount),
        status: word(l?.status),
        kind: word(l?.kind),
        method: word(l?.method),
        description: untrusted(l?.description),
        paymentId: oid(l?.paymentId),
        invoiceNumber: code(l?.invoiceNumber),
        supplier: untrusted(l?.vendorName),
        candidate: l?.candidate
          ? { paymentId: oid(l.candidate.paymentId), invoiceNumber: code(l.candidate.invoiceNumber), supplier: untrusted(l.candidate.vendorName), amount: num(l.candidate.amount) }
          : null,
        reason: untrusted(l?.reason),
        aiNote: untrusted(l?.aiNote),
        resolution: l?.resolution ? { action: word(l.resolution.action) } : null,
      }),
      200,
    ),
    lineCount: Array.isArray(s.lines) ? s.lines.length : 0,
    unpaidCount: Array.isArray(s.unpaid) ? s.unpaid.length : 0,
    outcome: word(s.decision?.outcome),
    reasons: texts(s.decision?.reasons, 20),
    createdAt: when(s.createdAt),
  };
}

// ----- month-end reports -----

export const reportList = (page) => ({
  items: page.items.map((x) => ({ id: oid(x._id), month: month(x.month), status: word(x.status), createdAt: when(x.createdAt) })),
  nextCursor: when(page.nextCursor),
});

/** getReportDetail(id): the figures, the open items and the commentary. */
export function reportDetail(r) {
  const x = r.report;
  const f = x.figures || {};
  return {
    id: oid(x._id),
    month: month(x.month),
    status: word(x.status),
    figures: {
      invoices: numbersOnly(f.invoices),
      payments: numbersOnly(f.payments),
      queries: numbersOnly(f.queries),
      reconciliation: numbersOnly(f.bank), // statement lines matched, open, dismissed: counts, not bank details
      outstandingBySupplier: list(
        f.outstandingBySupplier,
        (s) => ({ supplier: untrusted(s?.vendorName), count: num(s?.count), value: num(s?.value), earliestDue: day(s?.earliestDue) }),
        20,
      ),
      heldReasons: list(f.heldReasons, (h) => ({ reason: untrusted(h?.label), count: num(h?.count) }), 20),
      openItems: texts(f.openItems, 30),
    },
    commentary: untrusted(x.commentary?.text),
    commentaryMethod: word(x.commentary?.method),
    outcome: word(x.decision?.outcome),
    reasons: texts(x.decision?.reasons),
    createdAt: when(x.createdAt),
  };
}

// ----- suppliers and reference data -----

/** listSuppliers(actor): already masked (or hidden from reviewers) by the service. */
export const supplierList = (items, viewer) => ({
  items: items.map((s) => ({
    abn: abn(s.abn),
    name: untrusted(s.name),
    state: word(s.state),
    ...withBank(viewer, s.beneficiary && !s.beneficiary.hidden ? { ...maskedBank(s.beneficiary), status: word(s.beneficiary.status), version: num(s.beneficiary.version) } : null),
    pendingChange: s.pending
      ? {
          id: oid(s.pending.id),
          status: word(s.pending.status),
          proposedAt: when(s.pending.proposedAt),
          ...withBank(viewer, s.pending.details?.hidden ? null : maskedBank(s.pending.details)),
        }
      : null,
  })),
});

/** getReference(actor), narrowed to one supplier (abn) or one purchase order. Never bank details. */
export function reference(r, { abn: wantAbn, poNumber } = {}) {
  let pos = r.purchaseOrders;
  if (poNumber) pos = pos.filter((p) => p.poNumber === poNumber);
  if (wantAbn) pos = pos.filter((p) => p.vendorAbn === wantAbn);
  const vendors = wantAbn ? r.vendors.filter((v) => v.abn === wantAbn) : poNumber ? r.vendors.filter((v) => pos.some((p) => p.vendorAbn === v.abn)) : r.vendors;
  const poNumbers = new Set(pos.map((p) => p.poNumber));
  return {
    vendors: list(vendors, (v) => ({ abn: abn(v.abn), name: untrusted(v.name), gstRegistered: bool(v.gstRegistered) }), 50),
    purchaseOrders: list(pos, poView, 50),
    goodsReceipts: list(
      r.goodsReceipts.filter((g) => poNumbers.has(g.poNumber)),
      (g) => ({ poNumber: code(g.poNumber), receivedOn: day(g.receivedOn), lines: list(g.lines, (l) => ({ sku: code(l?.sku), qty: num(l?.qty) }), 50) }),
      100,
    ),
  };
}

// ----- the audit log -----

// The audit log's text (detail, reason) is never passed on: it can hold
// supplier email addresses ("intended for accounts@..."), people's names and
// notes, masked bank details and tool-call records. Each entry is given a
// fixed summary of its action instead, from this list or, for any other
// action, built from the action's own name (lower-case words only).
const ACTION_SUMMARIES = Object.freeze({
  received: 'The invoice was received.',
  processed: 'The agent processed it.',
  failed: 'The agent could not finish.',
  approve: 'A person approved it.',
  approve_received: 'A person approved the received quantity only.',
  reject: 'A person rejected it.',
  hold: 'A person put it on hold.',
  cancel: 'A person cancelled it.',
  reopen: 'A person reopened it.',
  link_po: 'A person linked a purchase order.',
  edit_fields: 'A person corrected fields read from the invoice.',
  clear_duplicate: 'A person cleared the possible duplicate.',
  request_correction: 'A person asked the supplier for a corrected invoice.',
  schedule_payment: 'A person scheduled the payment.',
  cancel_payment: 'A person cancelled the scheduled payment.',
  payment_confirmed: 'The simulated bank confirmed the payment.',
  payment_failed: 'The payment failed.',
  payment_matched: 'A bank line was matched to the payment.',
  payment_unmatched: 'A bank line was unmatched from the payment.',
  part_payment: 'A part payment was recorded.',
  reconciled: 'The bank line was reconciled.',
  drafted: 'A notice to the supplier was drafted.',
  approved_and_sent: 'A person approved the notice to the supplier.',
  discarded: 'A person discarded the notice to the supplier.',
  bank_details_proposed: 'New bank details were proposed for the supplier.',
  bank_details_approved: 'The proposed bank details were approved.',
  bank_details_rejected: 'The proposed bank details were rejected.',
  bank_details_revealed: 'The full bank details were shown to an authorised person.',
  user_created: 'An account was created.',
  user_updated: 'An account was changed.',
  password_reset: 'A password was reset.',
  password_changed: 'A password was changed.',
  signed_in: 'Someone signed in.',
  signed_out: 'Someone signed out.',
  locked: 'An account was locked after failed sign-ins.',
  policy_changed: 'The agent policy was changed.',
  demo_loaded: 'The demo data was loaded.',
  tool_called: 'An orchestrator tool was used.',
});

// A status or action name our code wrote: lower-case words only, so never a name or a sentence.
const label = (v) => (typeof v === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(v) ? v : null);

function summaryOf(action, from, to) {
  const base = (action && ACTION_SUMMARIES[action]) || (action ? `Recorded: ${action.replace(/_/g, ' ')}.` : 'Recorded.');
  return from && to && from !== to ? `${base} Status ${from} to ${to}.` : base;
}

/** listAuditEntries(actor, ...): what happened and when, never the entries' own text or who did it. */
export function history(r) {
  return {
    items: r.items.map((e) => {
      const action = label(e.action);
      const from = label(e.from);
      const to = label(e.to);
      return {
        id: oid(e._id),
        at: when(e.at),
        subjectKind: label(e.subjectKind),
        subjectId: subjectId(e.subjectId),
        action,
        from,
        to,
        summary: summaryOf(action, from, to),
        byPerson: Boolean(e.actorId),
        noteRecorded: Boolean(e.reason), // the note itself is on the record's screen
      };
    }),
  };
}

// ----- the simulated bank and mailbox ingestion -----

/** The simulated operating account: the balance only, never the account's own details. */
export const simBankAccount = (a) =>
  a
    ? {
        opened: true,
        currency: currency(a.currency),
        balance: num(a.balance),
        reserved: num(a.reserved),
        available: num(a.balance) !== null && num(a.reserved) !== null ? Math.round((a.balance - a.reserved) * 100) / 100 : null,
        simulated: true,
      }
    : { opened: false, simulated: true }; // no payment has reached the simulated bank yet

/** ingestion().status(): per provider, never the mailbox address, scopes, who connected it or an error's text. */
export const ingestionStatus = (r) => ({
  providers: list(
    r.providers,
    (p) => ({
      provider: word(p?.provider),
      state: word(p?.state),
      enabled: bool(p?.enabled),
      syncing: bool(p?.syncing),
      lastPollAt: when(p?.lastPollAt),
      lastSuccessAt: when(p?.lastSuccessAt),
      // The error's code only: its message can quote the mailbox address.
      lastError: p?.lastError ? { code: word(typeof p.lastError === 'object' ? p.lastError.code : null), at: when(p.lastError?.at) } : null,
      counts: numbersOnly(p?.counts),
    }),
    5,
  ),
  settings: numbersOnly(r.settings),
});
