// The agents' view of the accounting system, the mailbox and the bank,
// backed by the sample data in MongoDB.
//
// To connect real systems (Xero or MYOB, a shared mailbox, a bank feed), write
// another file that exports the same functions and pass it to the agents
// instead. Nothing in the agents or the rules needs to change.

import { Vendor, PurchaseOrder, GoodsReceipt, Invoice, Payment, OutboxMessage, VendorQuery, BankStatement, SupplierHint } from '../models/index.js';
import { hintsForText } from '../agent/finance/supplierHints.js';
import { skuKey } from '../agent/finance/matching.js';
import { sharedSignals } from '../agent/finance/duplicates.js';

const invoiceSummary = (d) => ({
  id: String(d._id),
  invoiceNumber: d.extracted?.invoiceNumber ?? null,
  abn: d.extracted?.abn ?? null,
  vendorName: d.extracted?.vendorName ?? null,
  total: d.extracted?.total ?? null,
  dueDate: d.extracted?.dueDate ?? null,
  status: d.status,
  createdAt: d.createdAt,
  humanDecision: d.approval?.decision ?? null,
  approvedAmount: d.approval?.amount ?? (d.approval ? (d.extracted?.total ?? null) : null),
  agentOutcome: d.decision?.outcome ?? null,
  currency: d.extracted?.currency || 'AUD',
  failedChecks: (d.checks || []).filter((c) => c.status === 'fail').map((c) => ({ id: c.id, label: c.label })),
  // Earlier, live invoices this one may be a copy of, while its duplicate check is failing.
  duplicateOf: (d.checks || []).some((c) => c.id === 'duplicate' && c.status === 'fail') ? (d.match?.duplicates || []).map((c) => String(c.id)) : [],
});

const INACTIVE = ['rejected', 'cancelled', 'failed'];

const paymentSummary = (p) => ({
  id: String(p._id),
  invoiceId: String(p.invoiceId),
  invoiceNumber: p.invoiceNumber ?? null,
  vendorName: p.vendorName ?? null,
  vendorAbn: p.vendorAbn ?? null,
  amount: p.amount,
  dueDate: p.dueDate ?? null,
  status: p.status,
  paidOn: p.paidOn ?? null,
  bank: p.bank ?? null,
});

const inRange = ({ start, end } = {}) => (start && end ? { createdAt: { $gte: start, $lt: end } } : {});

const revertInvoice = (invoiceId) =>
  Invoice.updateOne(
    { _id: invoiceId, status: 'payment_completed' },
    {
      $set: { status: 'payment_pending' },
      $push: {
        events: {
          at: new Date().toISOString(),
          actor: 'Bank reconciliation',
          action: 'payment_unmatched',
          from: 'payment_completed',
          to: 'payment_pending',
          reason: 'The bank match was undone.',
        },
      },
    },
  );

export const sampleLedger = {
  // ----- suppliers, purchase orders, deliveries -----
  listVendors: () => Vendor.find().lean(),

  findVendorByAbn: (abn) => Vendor.findOne({ abn }).lean(),

  findPurchaseOrder: (poNumber) => PurchaseOrder.findOne({ poNumber: String(poNumber).toUpperCase() }).lean(),

  listPurchaseOrders: () => PurchaseOrder.find().lean(),

  // Total received per item code across every delivery against the PO, or
  // null when no goods receipt has been recorded for it at all.
  async receivedQuantities(poNumber) {
    const receipts = await GoodsReceipt.find({ poNumber }).lean();
    if (!receipts.length) return null;
    const totals = {};
    for (const receipt of receipts) {
      for (const line of receipt.lines) {
        const key = skuKey(line.sku);
        totals[key] = (totals[key] || 0) + line.qty;
      }
    }
    return totals;
  },

  // What earlier, still-live invoices have already billed against the PO, per item code.
  // `skip`: earlier copies of this same invoice (suspected duplicates), which
  // must not use up the purchase order a second time.
  async invoicedQuantities({ poNumber, excludeId, before, skip = [] }) {
    const docs = await Invoice.find({ matchedPo: poNumber, _id: { $nin: [excludeId, ...skip] }, createdAt: { $lt: before }, status: { $nin: INACTIVE } })
      .select('lineMatches approval')
      .lean();
    const totals = {};
    for (const d of docs) {
      for (const l of d.lineMatches || []) {
        if (!l.onPo || typeof l.qtyInvoiced !== 'number') continue;
        const qty = d.approval?.decision === 'approve_received' ? (l.qtyPayable ?? l.qtyInvoiced) : l.qtyInvoiced;
        totals[skuKey(l.sku)] = (totals[skuKey(l.sku)] || 0) + qty;
      }
    }
    return totals;
  },

  // Earlier invoices that share a duplicate fingerprint.
  async findDuplicateCandidates({ fingerprints, excludeId, before }) {
    const or = Object.entries(fingerprints || {})
      .filter(([, v]) => v)
      .map(([k, v]) => ({ [`fingerprints.${k}`]: v }));
    if (!or.length) return [];
    const docs = await Invoice.find({ $or: or, _id: { $ne: excludeId }, createdAt: { $lt: before } })
      .select('status createdAt extracted.invoiceNumber extracted.total fingerprints')
      .sort({ createdAt: 1 })
      .lean();
    return docs.map((d) => ({
      id: String(d._id),
      invoiceNumber: d.extracted?.invoiceNumber ?? null,
      total: d.extracted?.total ?? null,
      status: d.status,
      createdAt: d.createdAt,
      signals: sharedSignals(fingerprints, d.fingerprints),
    }));
  },

  // ----- invoices -----

  async listInvoices(range) {
    const docs = await Invoice.find(inRange(range)).select('-rawText -lineMatches').sort({ createdAt: 1 }).lean();
    return docs.map(invoiceSummary);
  },

  // Every invoice with this number, with its payment (if any) attached.
  async findInvoicesByNumber(number) {
    const wanted = String(number).trim();
    const docs = await Invoice.find({ 'extracted.invoiceNumber': { $in: [...new Set([wanted, wanted.toUpperCase()])] } })
      .select('-rawText -lineMatches')
      .sort({ createdAt: 1 })
      .lean();
    const payments = await Payment.find({ invoiceId: { $in: docs.map((d) => d._id) } }).lean();
    return docs.map((d) => {
      const p = payments.find((x) => String(x.invoiceId) === String(d._id));
      return { ...invoiceSummary(d), payment: p ? { status: p.status, amount: p.amount, paidOn: p.paidOn ?? null } : null };
    });
  },

  // ----- the lifecycle store (see services/invoiceActions.js) -----
  // Every status change compares the current status in the same database
  // operation, so two people (or two clicks) cannot both make the same change.

  async getInvoice(id) {
    const d = await Invoice.findById(id).lean();
    return d ? { ...d, id: String(d._id) } : null;
  },

  async claimInvoice(id, from, set, event) {
    const update = { $set: set };
    if (event) update.$push = { events: { at: new Date().toISOString(), ...event } };
    const d = await Invoice.findOneAndUpdate({ _id: id, status: from }, update, { new: true }).lean();
    return d ? { ...d, id: String(d._id) } : null;
  },

  async updateInvoice(id, set, event) {
    const update = { $set: set };
    if (event) update.$push = { events: { at: new Date().toISOString(), ...event } };
    const d = await Invoice.findByIdAndUpdate(id, update, { new: true }).lean();
    return d ? { ...d, id: String(d._id) } : null;
  },

  async getPayment(invoiceId) {
    const p = await Payment.findOne({ invoiceId }).lean();
    return p ? { ...p, id: String(p._id), invoiceId: String(p.invoiceId) } : null;
  },

  // The unique index on invoiceId refuses a second payment for the same invoice.
  async createPayment(payment) {
    const p = (await Payment.create({ ...payment, history: [{ at: new Date().toISOString(), event: 'scheduled', by: payment.scheduledBy }] })).toObject();
    return { ...p, id: String(p._id), invoiceId: String(p.invoiceId) };
  },

  async updatePayment(id, from, set, history) {
    const update = { $set: set };
    if (history) update.$push = { history: { at: new Date().toISOString(), ...history } };
    const p = await Payment.findOneAndUpdate({ _id: id, status: { $in: from } }, update, { new: true }).lean();
    return p ? { ...p, id: String(p._id), invoiceId: String(p.invoiceId) } : null;
  },

  // Live payments on other invoices that look like the same invoice
  // (same supplier and number, same supplier/amount/date, or identical document).
  async duplicatePayments(invoice) {
    const fp = invoice.fingerprints || {};
    // Same supplier + invoice number, or the identical document, always blocks a
    // second payment. Same supplier + total + date blocks it too, unless a person
    // has confirmed the invoices are different (two identical orders on one day).
    const keys = invoice.duplicateCleared ? ['numberKey', 'contentHash'] : ['numberKey', 'amountKey', 'contentHash'];
    const or = keys.filter((k) => fp[k]).map((k) => ({ [`fingerprints.${k}`]: fp[k] }));
    if (!or.length) return [];
    const others = await Invoice.find({ $or: or, _id: { $ne: invoice.id } })
      .select('_id')
      .lean();
    if (!others.length) return [];
    return Payment.find({ invoiceId: { $in: others.map((o) => o._id) }, status: { $in: ['queued', 'paid'] } }).lean();
  },

  // ----- what reviewers' corrections taught the reader, per supplier -----

  // One hint per supplier and field; a newer correction replaces the older hint.
  async saveSupplierHints(hints) {
    for (const h of hints) {
      await SupplierHint.updateOne({ vendorAbn: h.vendorAbn, field: h.field }, { $set: h }, { upsert: true });
    }
  },

  async supplierHintsFor(text) {
    return hintsForText(await SupplierHint.find().select('-_id -__v').lean(), text);
  },

  // ----- payment queue -----

  // Safe to call twice: the unique index on invoiceId allows one entry per invoice.
  async queuePayment(payment) {
    try {
      return (await Payment.create({ ...payment, status: 'queued' })).toObject();
    } catch (err) {
      if (err?.code !== 11000) throw err;
      return Payment.findOneAndUpdate(
        { invoiceId: payment.invoiceId, status: { $ne: 'paid' } },
        { $set: { status: 'queued', approvedBy: payment.approvedBy, amount: payment.amount } },
        { new: true },
      ).lean();
    }
  },

  findPayments: (invoiceId) => Payment.find({ invoiceId }).lean(),

  // Only payments that have not gone out can be put on hold.
  holdPayments: (invoiceId) => Payment.updateMany({ invoiceId, status: 'queued' }, { $set: { status: 'on_hold' } }),

  async listPayments() {
    return (await Payment.find().sort({ createdAt: 1 }).lean()).map(paymentSummary);
  },

  // Mark a queued payment as paid because a bank line shows it leaving the
  // account. Returns null if the payment is no longer queued.
  // The invoice moves from Payment Pending to Payment Completed with it.
  async markPaid(paymentId, bank) {
    const doc = await Payment.findOneAndUpdate(
      { _id: paymentId, status: 'queued' },
      {
        $set: { status: 'paid', paidOn: bank.date ?? null, bank, recordedBy: 'Bank reconciliation' },
        $push: { history: { at: new Date().toISOString(), event: 'paid', by: 'Bank reconciliation', detail: `Bank line ${bank.line}: ${bank.description}` } },
      },
      { new: true },
    ).lean();
    if (!doc) return null;
    await Invoice.updateOne(
      { _id: doc.invoiceId, status: 'payment_pending' },
      {
        $set: { status: 'payment_completed' },
        $push: {
          events: {
            at: new Date().toISOString(),
            actor: 'Bank reconciliation',
            action: 'payment_matched',
            from: 'payment_pending',
            to: 'payment_completed',
            reason: `Bank line ${bank.line} (${bank.description}) matches the payment.`,
          },
        },
      },
    );
    return paymentSummary(doc);
  },

  async unmarkPaid(paymentId, statementId) {
    const doc = await Payment.findOneAndUpdate(
      { _id: paymentId, status: 'paid', 'bank.statementId': statementId },
      { $set: { status: 'queued', paidOn: null, bank: null, recordedBy: null } },
      { new: true },
    ).lean();
    if (doc) await revertInvoice(doc.invoiceId);
  },

  // Undo everything one statement marked as paid.
  async revertStatement(statementId) {
    const docs = await Payment.find({ status: 'paid', 'bank.statementId': statementId }).select('invoiceId').lean();
    if (!docs.length) return;
    await Payment.updateMany({ status: 'paid', 'bank.statementId': statementId }, { $set: { status: 'queued', paidOn: null, bank: null, recordedBy: null } });
    for (const d of docs) await revertInvoice(d.invoiceId);
  },

  // ----- outbox (replies to suppliers). Sample only: nothing is emailed. -----

  async queueMessage(message) {
    try {
      return (await OutboxMessage.create({ ...message, status: 'queued' })).toObject();
    } catch (err) {
      if (err?.code !== 11000) throw err;
      return OutboxMessage.findOneAndUpdate({ queryId: message.queryId, status: { $ne: 'sent' } }, { $set: { ...message, status: 'queued' } }, { new: true }).lean();
    }
  },

  findMessages: (queryId) => OutboxMessage.find({ queryId }).lean(),

  releaseMessage: (queryId) => OutboxMessage.updateMany({ queryId, status: 'queued' }, { $set: { status: 'sent', sentAt: new Date() } }),

  holdMessages: (queryId) => OutboxMessage.updateMany({ queryId, status: 'queued' }, { $set: { status: 'held' } }),

  // ----- for the month-end report -----

  async listQueries(range) {
    const docs = await VendorQuery.find(inRange(range)).select('status decision').lean();
    return docs.map((q) => ({ id: String(q._id), status: q.status, auto: q.decision?.outcome === 'auto_answered' }));
  },

  async listStatements(range) {
    const docs = await BankStatement.find(inRange(range)).select('status lines source createdAt').sort({ createdAt: 1 }).lean();
    return docs.map((s) => ({ id: String(s._id), status: s.status, filename: s.source?.filename ?? null, createdAt: s.createdAt, lines: s.lines || [] }));
  },
};
