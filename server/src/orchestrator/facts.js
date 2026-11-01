// The facts block of an answer (docs/phase2-design.md §3.7): every reference,
// status, amount and date the person sees is rendered here by code from the
// tool views of this request. The model never writes a fact. Each record gets
// a short handle (I1 for an invoice, P1 a payment, S1 a supplier, L1 a bank
// line) that the explanation refers to.
//
// For grounding (ground.js), the same records carry their document numbers
// and what may truthfully be said about their status.

import { AWAITING_DECISION } from '../agent/finance/lifecycle.js';
import { invoiceClaims, paymentClaims } from './ground.js';

const text = (v) => (v && typeof v === 'object' ? (v.untrusted_text ?? null) : (v ?? null));
const MAX_LISTED = 100;

// ----- one record each -----

function invoiceFact(v, handle) {
  return {
    handle,
    kind: 'invoice',
    id: v.id,
    invoiceNumber: text(v.invoiceNumber),
    supplier: text(v.supplier),
    total: v.total ?? null,
    currency: v.currency || 'AUD',
    status: v.status,
    due: v.due ? { date: v.due.date, state: v.due.state, daysUntil: v.due.daysUntil } : null,
    failedChecks: v.failedChecks || [],
  };
}

function paymentFact(p, handle) {
  return {
    handle,
    kind: 'payment',
    id: p.id,
    invoiceId: p.invoiceId,
    invoiceNumber: text(p.invoiceNumber),
    supplier: text(p.supplier),
    amount: p.amount ?? null,
    currency: p.currency || 'AUD',
    status: p.status,
    method: p.method,
    scheduledFor: p.scheduledFor,
    txnRef: text(p.txnRef),
    failure: p.failure?.code || null,
  };
}

function lineFact(l, handle, statementId) {
  return {
    handle,
    kind: 'bank_line',
    id: l.lineId,
    statementId,
    n: l.n,
    date: l.date,
    amount: l.amount,
    status: l.status,
    lineKind: l.kind,
    description: text(l.description),
    invoiceNumber: text(l.invoiceNumber) ?? text(l.candidate?.invoiceNumber),
    reason: text(l.reason),
  };
}

// ----- per intent -----

const STAGE_STATUSES = {
  approval: ['under_review'],
  review: ['needs_review'],
  on_hold: ['on_hold'],
  any: [...AWAITING_DECISION, 'failed'],
};

/**
 * Facts for an intent from its plan's results (plans.js runPlan state).
 * Returns { records, history, numbers, extra } where
 *   records  the facts block, in display order (each with a handle)
 *   history  dated history summaries (record_history, explain_invoice_status)
 *   extra    figures code computed (counts, totals), allowed in the explanation
 *   grounding { records: [{ handle, refs, claims }], views }
 */
export function buildFacts(intent, args, state) {
  const records = [];
  const grounding = [];
  const views = [];
  const extra = [];
  let history = [];
  const counter = { I: 0, P: 0, S: 0, L: 0 };
  const next = (k) => `${k}${(counter[k] += 1)}`;
  const addInvoice = (v, detail = v) => {
    const f = invoiceFact(v, next('I'));
    records.push(f);
    grounding.push({ handle: f.handle, refs: [f.invoiceNumber].filter(Boolean), claims: invoiceClaims(detail) });
    views.push(detail);
    return f;
  };
  const addPayment = (p) => {
    const f = paymentFact(p, next('P'));
    records.push(f);
    grounding.push({ handle: f.handle, refs: [f.invoiceNumber, f.txnRef].filter(Boolean), claims: paymentClaims(p) });
    views.push(p);
    return f;
  };
  const historyOf = (h) => (h?.items || []).map((e) => ({ at: e.at, action: e.action, summary: e.summary, from: e.from, to: e.to }));

  switch (intent) {
    case 'list_pending_invoices': {
      const wanted = STAGE_STATUSES[args.stage || 'any'] || STAGE_STATUSES.any;
      const items = [...(state.waiting?.items || []), ...(state.waitingMore?.items || [])].filter((i) => wanted.includes(i.status));
      for (const i of items.slice(0, MAX_LISTED)) addInvoice(i);
      extra.push(items.length);
      break;
    }
    case 'find_invoice':
    case 'explain_invoice_status':
    case 'payment_status': {
      if (state.invoice) addInvoice(state.invoice);
      if (state.payment?.payment) addPayment(state.payment.payment);
      else if (state.invoice?.payment) addPayment(state.invoice.payment);
      history = historyOf(state.history);
      // What blocks payments (payment_status with no invoice named).
      for (const i of (state.toPay?.items || []).filter((x) => ['approved', 'payment_failed'].includes(x.status)).slice(0, 30)) addInvoice(i);
      for (const p of (state.payments?.items || []).filter((x) => ['failed', 'on_hold'].includes(x.status)).slice(0, 30)) addPayment(p);
      for (const s of (state.suppliers?.items || []).filter((x) => x.pendingChange)) {
        const f = { handle: next('S'), kind: 'supplier', id: s.abn, name: text(s.name), state: s.state, pendingChange: true };
        records.push(f);
        grounding.push({ handle: f.handle, refs: [], claims: null });
        views.push({ name: s.name, state: s.state });
      }
      if (state.account?.opened) {
        records.push({ handle: null, kind: 'account', available: state.account.available, currency: state.account.currency, simulated: true });
        views.push(state.account);
      }
      break;
    }
    case 'supplier_summary': {
      const open = state.open?.items || [];
      const byAbn = new Map();
      for (const i of open) {
        const key = i.supplierAbn || null;
        if (!byAbn.has(key)) byAbn.set(key, []);
        byAbn.get(key).push(i);
      }
      const suppliers = (state.suppliers?.items || []).filter((s) => (state.abn ? s.abn === state.abn : byAbn.has(s.abn)));
      for (const s of suppliers) {
        const invoices = byAbn.get(s.abn) || [];
        const total = Math.round(invoices.reduce((n, i) => n + (i.currency === 'AUD' || !i.currency ? i.total || 0 : 0), 0) * 100) / 100;
        const overdue = invoices.filter((i) => i.due?.state === 'overdue').length;
        const oldestDue =
          invoices
            .map((i) => i.due?.date)
            .filter(Boolean)
            .sort()[0] || null;
        const f = {
          handle: next('S'),
          kind: 'supplier',
          id: s.abn,
          name: text(s.name),
          state: s.state,
          pendingChange: Boolean(s.pendingChange),
          openCount: invoices.length,
          openTotal: total,
          overdue,
          oldestDue,
        };
        records.push(f);
        grounding.push({ handle: f.handle, refs: [], claims: null });
        views.push({ name: s.name, state: s.state, openCount: invoices.length, openTotal: total, overdue, oldestDue });
        extra.push(invoices.length, total, overdue);
      }
      if (!state.abn && byAbn.has(null)) {
        const invoices = byAbn.get(null);
        records.push({ handle: null, kind: 'unmatched_supplier', openCount: invoices.length });
        extra.push(invoices.length);
      }
      extra.push(suppliers.length);
      break;
    }
    case 'list_unpaid_invoices': {
      for (const i of (state.open?.items || []).slice(0, MAX_LISTED)) addInvoice(i);
      extra.push(state.open?.total ?? 0);
      if (state.payables) views.push({ cash: state.payables.cash, overdue: state.payables.overdue?.length ?? 0, dueSoon: state.payables.dueSoon?.length ?? 0 });
      break;
    }
    case 'reconciliation_exceptions': {
      for (const s of state.open || []) {
        for (const l of (s.lines || []).filter((x) => ['suggested', 'exception', 'unmatched'].includes(x.status)).slice(0, 50)) {
          const f = lineFact(l, next('L'), s.id);
          records.push(f);
          grounding.push({ handle: f.handle, refs: [f.invoiceNumber].filter(Boolean), claims: null });
          views.push(l);
        }
      }
      extra.push(records.length);
      break;
    }
    case 'ingestion_status': {
      for (const p of state.ingestion?.providers || [])
        records.push({ handle: null, kind: 'mailbox', provider: p.provider, state: p.state, enabled: p.enabled, lastPollAt: p.lastPollAt, counts: p.counts });
      break;
    }
    case 'record_history':
      history = historyOf(state.history);
      break;
    default:
      break;
  }
  return { records, history, extra, grounding: { records: grounding, views: [...views, history] } };
}
