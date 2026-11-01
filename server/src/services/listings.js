// The record lists, shared by the routes and (later) the orchestrator's
// read-only tools, so both apply the same filters and the same role-based
// masking. Each takes the actor first: an authenticated actor with at least
// one role (the routes already require that; this checks it again).
//
//   listInvoices(actor, { filter, before, limit })   GET /api/invoices
//   listPayments(actor, { status })                  GET /api/payments
//   getPayment(actor, id)                            GET /api/payments/:id
//   listQueries(actor, { before, limit })            GET /api/queries
//   listStatements(actor, { before, limit })         GET /api/statements
//   listReports(actor, { before, limit })            GET /api/reports
//   getReference(actor)                              GET /api/reference
//   listAuditEntries(actor, { subjectId, limit })    GET /api/audit
//
// The query arguments take the same values as the routes' query strings.
// Bank details: reviewers see none, payers, approvers and administrators see
// them masked (services/bankViews.js). Suppliers are listed by
// services/beneficiaries.js listSuppliers.

import mongoose from 'mongoose';

import { ROLES, Invoice, Vendor, PurchaseOrder, GoodsReceipt, Payment, PaymentJob, VendorQuery, BankStatement, Report } from '../models/index.js';
import { AWAITING_DECISION } from '../agent/finance/lifecycle.js';
import { sampleLedger } from '../integrations/sampleLedger.js';
import { referenceVendor, paymentFor, transactionFor, noticeFor, auditEntryFor } from './bankViews.js';
import { simBank, paymentNotices } from './paymentSystem.js';
import { requireActor } from './actor.js';
import { HttpError } from './runs.js';
import { pageOf, pageParams } from './paging.js';

const anyRole = (actor) => requireActor(actor, ...ROLES);

// ----- invoices -----

export const INVOICE_FILTERS = {
  waiting: { status: { $in: [...AWAITING_DECISION, 'failed'] } },
  pay: { status: { $in: ['approved', 'payment_pending', 'payment_processing', 'payment_failed'] } },
};

const INVOICE_LIST_FIELDS =
  'status source createdAt extracted.vendorName extracted.invoiceNumber extracted.total extracted.currency decision checks.id checks.status approval.decision due match.score.total recovery.status';

async function invoiceCounts() {
  const [all, waiting, toPay, inQueue, matchedByAgent, exceptions] = await Promise.all([
    Invoice.countDocuments(),
    Invoice.countDocuments(INVOICE_FILTERS.waiting),
    Invoice.countDocuments(INVOICE_FILTERS.pay),
    Invoice.countDocuments({ status: { $nin: ['payment_completed', 'rejected', 'cancelled'] } }),
    Invoice.countDocuments({ 'decision.outcome': 'under_review', status: { $ne: 'cancelled' } }),
    Invoice.countDocuments({ status: { $in: ['needs_review', 'on_hold', 'failed', 'payment_failed'] } }),
  ]);
  return { all, waiting, toPay, kpis: { inQueue, matchedByAgent, exceptions, awaitingPayment: toPay } };
}

/** filter: waiting (needs a person) | pay (approved, to pay) | anything else: all. Plus before and limit (paging.js). */
export async function listInvoices(actor, { filter, ...paging } = {}) {
  anyRole(actor);
  const where = INVOICE_FILTERS[filter] || {};
  const page = await pageOf(Invoice, where, pageParams(paging), { select: INVOICE_LIST_FIELDS });
  // The tab counts and the KPIs cover every invoice, not just the ones loaded.
  return { ...page, counts: await invoiceCounts() };
}

// ----- payments -----

export const PAYMENT_STATUSES = ['queued', 'processing', 'paid', 'failed', 'cancelled', 'on_hold'];

// No bank details in a list item.
const paymentListItem = (p) => ({
  _id: p._id,
  invoiceId: p.invoiceId,
  invoiceNumber: p.invoiceNumber,
  vendorName: p.vendorName,
  amount: p.amount,
  paidAmount: p.paidAmount,
  currency: p.currency || 'AUD',
  method: p.method,
  route: p.route || 'manual',
  status: p.status,
  scheduledFor: p.scheduledFor,
  scheduledAt: p.scheduledAt,
  scheduledBy: p.scheduledBy,
  txnRef: p.confirmation?.txnRef || p.submission?.txnRef || null,
  completesAt: p.submission?.completesAt || null,
  confirmedAt: p.confirmation?.confirmedAt || null,
  failure: p.failure ? { reason: p.failure.reason, code: p.failure.code } : null,
  updatedAt: p.updatedAt,
  simulated: true,
});

/** status: one of PAYMENT_STATUSES, or several comma-separated; unknown values are ignored. The latest 200. */
export async function listPayments(actor, { status } = {}) {
  anyRole(actor);
  const wanted = String(status || '')
    .split(',')
    .filter((s) => PAYMENT_STATUSES.includes(s));
  const docs = await Payment.find(wanted.length ? { status: { $in: wanted } } : {})
    .sort({ updatedAt: -1 })
    .limit(200)
    .lean();
  const counts = Object.fromEntries(await Promise.all(PAYMENT_STATUSES.map(async (s) => [s, await Payment.countDocuments({ status: s })])));
  return { items: docs.map(paymentListItem), counts };
}

/** One payment with its jobs, its simulated bank transaction and its notices. 404 if there is none. */
export async function getPayment(actor, id) {
  anyRole(actor);
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'That payment does not exist.');
  const p = await Payment.findById(id).lean();
  if (!p) throw new HttpError(404, 'That payment does not exist.');
  const ref = p.confirmation?.txnRef || p.submission?.txnRef;
  const [jobs, transaction, notices] = await Promise.all([
    PaymentJob.find({ paymentId: p._id }).sort({ createdAt: 1 }).lean(),
    ref ? simBank.getTransaction(ref) : null,
    paymentNotices.list({ paymentId: p._id }),
  ]);
  // Bank details masked, or hidden from reviewers.
  return { payment: paymentFor(p, actor), jobs, transaction: transactionFor(transaction, actor), notices: notices.map((n) => noticeFor(n, actor)) };
}

// ----- supplier emails, bank statements, month-end reports -----

export async function listQueries(actor, paging = {}) {
  anyRole(actor);
  return pageOf(VendorQuery, {}, pageParams(paging), { select: 'status from subject createdAt supplier.name decision.outcome' });
}

const OPEN_LINE = ['suggested', 'exception', 'unmatched'];

export async function listStatements(actor, paging = {}) {
  anyRole(actor);
  return pageOf(BankStatement, {}, pageParams(paging), {
    select: 'status source createdAt lines.status lines.amount',
    map: (s) => ({
      _id: s._id,
      status: s.status,
      source: s.source,
      createdAt: s.createdAt,
      lineCount: s.lines.length,
      openCount: s.lines.filter((l) => OPEN_LINE.includes(l.status)).length,
    }),
  });
}

export async function listReports(actor, paging = {}) {
  anyRole(actor);
  return pageOf(Report, {}, pageParams(paging), { select: 'month status createdAt figures.label' });
}

// ----- reference data and the audit log -----

/** Suppliers, purchase orders and deliveries the agent checks against. Never the suppliers' bank details. */
export async function getReference(actor) {
  anyRole(actor);
  const [vendors, purchaseOrders, goodsReceipts] = await Promise.all([
    Vendor.find().sort({ name: 1 }).lean(),
    PurchaseOrder.find().sort({ poNumber: 1 }).lean(),
    GoodsReceipt.find().sort({ poNumber: 1 }).lean(),
  ]);
  return { vendors: vendors.map(referenceVendor), purchaseOrders, goodsReceipts };
}

/**
 * subjectId: one record's history, oldest first (a bank line's id is
 * "<statement id>:<line number>"); without it, the latest entries, newest
 * first. limit: 1 to 500, default 200. Bank-detail entries are masked, or
 * hidden from reviewers.
 */
export async function listAuditEntries(actor, { subjectId, limit } = {}) {
  anyRole(actor);
  const subject = typeof subjectId === 'string' ? subjectId.trim().slice(0, 100) : '';
  const n = Math.min(500, Math.max(1, Math.floor(Number(limit)) || 200));
  const items = await sampleLedger.listAudit({ subjectId: subject || null, limit: n });
  return { items: items.map((e) => auditEntryFor(e, actor)) };
}
