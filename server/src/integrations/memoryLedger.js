// In-memory version of the ledger, used by the tests so they need no database.
// Same functions as sampleLedger.js, with the same "compare status, then
// change" behaviour, so the lifecycle rules can be tested without MongoDB.
//
// `invoices` holds invoice records in the shape the invoice agent works on
// ({ id, createdAt, status, extracted, checks, approval, fingerprints, events }).

import { skuKey } from '../agent/finance/matching.js';
import { sharedSignals } from '../agent/finance/duplicates.js';

const INACTIVE = ['rejected', 'cancelled', 'failed'];

const summary = (d) => ({
  id: d.id,
  invoiceNumber: d.extracted?.invoiceNumber ?? null,
  abn: d.extracted?.abn ?? null,
  vendorName: d.extracted?.vendorName ?? null,
  total: d.extracted?.total ?? null,
  dueDate: d.extracted?.dueDate ?? null,
  status: d.status,
  createdAt: d.createdAt,
  humanDecision: d.approval?.decision ?? null,
  approvedAmount: d.approval?.amount ?? (d.approval ? d.extracted?.total ?? null : null),
  agentOutcome: d.decision?.outcome ?? null,
  currency: d.extracted?.currency || 'AUD',
  failedChecks: (d.checks || []).filter((c) => c.status === 'fail').map((c) => ({ id: c.id, label: c.label })),
  // Earlier, live invoices this one may be a copy of, while its duplicate check is failing.
  duplicateOf: (d.checks || []).some((c) => c.id === 'duplicate' && c.status === 'fail') ? (d.match?.duplicates || []).map((c) => String(c.id)) : [],
});

const between = (list, { start, end } = {}) => list.filter((x) => (!start || x.createdAt >= start) && (!end || x.createdAt < end));
const event = (e) => ({ at: new Date().toISOString(), ...e });

export function createMemoryLedger({ vendors = [], purchaseOrders = [], goodsReceipts = [], invoices = [], queries = [], statements = [] } = {}) {
  const payments = [];
  const messages = [];
  let nextId = 1;
  const inv = (id) => invoices.find((i) => i.id === id) || null;
  const moveInvoice = (invoiceId, from, to, e) => {
    const i = inv(invoiceId);
    if (!i || i.status !== from) return;
    i.status = to;
    (i.events ||= []).push(event({ from, to, ...e }));
  };

  return {
    payments,
    invoices,
    messages,

    // ----- suppliers, purchase orders, deliveries -----
    async listVendors() {
      return vendors;
    },
    async findVendorByAbn(abn) {
      return vendors.find((v) => v.abn === abn) || null;
    },
    async findPurchaseOrder(poNumber) {
      return purchaseOrders.find((p) => p.poNumber === String(poNumber).toUpperCase()) || null;
    },
    async listPurchaseOrders() {
      return purchaseOrders;
    },
    async receivedQuantities(poNumber) {
      const receipts = goodsReceipts.filter((r) => r.poNumber === poNumber);
      if (!receipts.length) return null;
      const totals = {};
      for (const receipt of receipts) {
        for (const line of receipt.lines) totals[skuKey(line.sku)] = (totals[skuKey(line.sku)] || 0) + line.qty;
      }
      return totals;
    },
    async invoicedQuantities({ poNumber, excludeId, before, skip = [] }) {
      const totals = {};
      for (const d of invoices.filter((i) => i.matchedPo === poNumber && i.id !== excludeId && !skip.includes(i.id) && i.createdAt < before && !INACTIVE.includes(i.status))) {
        for (const l of d.lineMatches || []) {
          if (!l.onPo || typeof l.qtyInvoiced !== 'number') continue;
          const qty = d.approval?.decision === 'approve_received' ? l.qtyPayable ?? l.qtyInvoiced : l.qtyInvoiced;
          totals[skuKey(l.sku)] = (totals[skuKey(l.sku)] || 0) + qty;
        }
      }
      return totals;
    },

    // ----- invoices -----
    async findDuplicateCandidates({ fingerprints, excludeId, before }) {
      return invoices
        .filter((i) => i.id !== excludeId && i.createdAt < before && sharedSignals(fingerprints, i.fingerprints).length)
        .map((i) => ({ id: i.id, invoiceNumber: i.extracted?.invoiceNumber ?? null, total: i.extracted?.total ?? null, status: i.status, createdAt: i.createdAt, signals: sharedSignals(fingerprints, i.fingerprints) }));
    },
    async listInvoices(range) {
      return between(invoices, range).map(summary);
    },
    async findInvoicesByNumber(number) {
      const wanted = String(number).toUpperCase();
      return invoices
        .filter((i) => String(i.extracted?.invoiceNumber ?? '').toUpperCase() === wanted)
        .map((i) => {
          const p = payments.find((x) => x.invoiceId === i.id);
          return { ...summary(i), payment: p ? { status: p.status, amount: p.amount, paidOn: p.paidOn ?? null } : null };
        });
    },

    // ----- the lifecycle store (see services/invoiceActions.js) -----
    async getInvoice(id) {
      return inv(id);
    },
    // Change the invoice only if it is still in status `from`. Returns null if it was not.
    async claimInvoice(id, from, set, e) {
      const i = inv(id);
      if (!i || i.status !== from) return null;
      Object.assign(i, set);
      if (e) (i.events ||= []).push(event(e));
      return i;
    },
    async updateInvoice(id, set, e) {
      const i = inv(id);
      if (!i) return null;
      Object.assign(i, set);
      if (e) (i.events ||= []).push(event(e));
      return i;
    },
    async getPayment(invoiceId) {
      return payments.find((p) => p.invoiceId === invoiceId) || null;
    },
    async createPayment(payment) {
      if (payments.some((p) => p.invoiceId === payment.invoiceId)) {
        const err = new Error('duplicate key');
        err.code = 11000;
        throw err;
      }
      const created = { id: `pay-${nextId++}`, status: 'queued', paidOn: null, bank: null, history: [], attempts: 1, simulated: true, ...payment };
      payments.push(created);
      return created;
    },
    // Change the payment only if its status is one of `from`. Returns null if not.
    async updatePayment(id, from, set, history) {
      const p = payments.find((x) => x.id === id);
      if (!p || !from.includes(p.status)) return null;
      Object.assign(p, set);
      if (history) (p.history ||= []).push(event(history));
      return p;
    },
    // Live payments on other invoices that look like the same invoice.
    async duplicatePayments(invoice) {
      const blocking = invoice.duplicateCleared ? ['same supplier and invoice number', 'identical document'] : ['same supplier and invoice number', 'same supplier, total and invoice date', 'identical document'];
      const others = invoices.filter((i) => i.id !== invoice.id && sharedSignals(invoice.fingerprints, i.fingerprints).some((s) => blocking.includes(s)));
      return payments.filter((p) => others.some((o) => o.id === p.invoiceId) && ['queued', 'paid'].includes(p.status));
    },

    // ----- payment queue (used by tests and the bank reconciliation agent) -----
    async queuePayment(payment) {
      const existing = payments.find((p) => p.invoiceId === payment.invoiceId);
      if (existing) {
        Object.assign(existing, { status: 'queued', approvedBy: payment.approvedBy, amount: payment.amount, invoiceTotal: payment.invoiceTotal ?? null });
        return existing;
      }
      const created = { id: `pay-${nextId++}`, ...payment, status: 'queued', paidOn: null, bank: null, history: [] };
      payments.push(created);
      return created;
    },
    async findPayments(invoiceId) {
      return payments.filter((p) => p.invoiceId === invoiceId);
    },
    async holdPayments(invoiceId) {
      for (const p of payments.filter((x) => x.invoiceId === invoiceId && x.status === 'queued')) p.status = 'on_hold';
    },
    async listPayments() {
      return payments.map((p) => ({ ...p }));
    },
    async markPaid(paymentId, bank) {
      const p = payments.find((x) => x.id === paymentId && x.status === 'queued');
      if (!p) return null;
      Object.assign(p, { status: 'paid', paidOn: bank.date, bank, recordedBy: 'Bank reconciliation' });
      moveInvoice(p.invoiceId, 'payment_pending', 'payment_completed', { actor: 'Bank reconciliation', action: 'payment_matched', reason: `Bank line ${bank.line} matches the payment.` });
      return { ...p };
    },
    async unmarkPaid(paymentId, statementId) {
      const p = payments.find((x) => x.id === paymentId && x.status === 'paid' && x.bank?.statementId === statementId);
      if (!p) return;
      Object.assign(p, { status: 'queued', paidOn: null, bank: null, recordedBy: null });
      moveInvoice(p.invoiceId, 'payment_completed', 'payment_pending', { actor: 'Bank reconciliation', action: 'payment_unmatched', reason: 'The bank match was undone.' });
    },
    async revertStatement(statementId) {
      for (const p of payments.filter((x) => x.status === 'paid' && x.bank?.statementId === statementId)) {
        Object.assign(p, { status: 'queued', paidOn: null, bank: null, recordedBy: null });
        moveInvoice(p.invoiceId, 'payment_completed', 'payment_pending', { actor: 'Bank reconciliation', action: 'payment_unmatched', reason: 'The bank match was undone.' });
      }
    },

    // ----- outbox -----
    async queueMessage(message) {
      const existing = messages.find((m) => m.queryId === message.queryId);
      if (existing) return Object.assign(existing, message, { status: 'queued' });
      const created = { ...message, status: 'queued' };
      messages.push(created);
      return created;
    },
    async findMessages(queryId) {
      return messages.filter((m) => m.queryId === queryId);
    },
    async releaseMessage(queryId) {
      for (const m of messages.filter((x) => x.queryId === queryId && x.status === 'queued')) m.status = 'sent';
    },
    async holdMessages(queryId) {
      for (const m of messages.filter((x) => x.queryId === queryId && x.status === 'queued')) m.status = 'held';
    },

    // ----- for the month-end report -----
    async listQueries(range) {
      return between(queries, range).map((q) => ({ id: q.id, status: q.status, auto: q.decision?.outcome === 'auto_answered' }));
    },
    async listStatements(range) {
      return between(statements, range).map((s) => ({ id: s.id, status: s.status, filename: s.source?.filename ?? null, createdAt: s.createdAt, lines: s.lines || [] }));
    },
  };
}
