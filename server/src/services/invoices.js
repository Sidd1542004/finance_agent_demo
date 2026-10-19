// Glue between the API and the invoice agent: run the agent, apply a person's
// actions (approve, reject, link a PO, schedule and record payments, ...) and
// keep the audit trail.

import { runAgent } from '../agent/core/loop.js';
import { createInvoiceAgent } from '../agent/finance/invoiceAgent.js';
import { createExtractor, createVisionReader } from '../agent/finance/extract.js';
import { createAbrLookup } from '../agent/finance/abr.js';
import { receivedOnly, normaliseAbn } from '../agent/finance/rules.js';
import { allowedActions, ActionError, AWAITING_DECISION } from '../agent/finance/lifecycle.js';
import { payablesSummary, todayIso } from '../agent/finance/due.js';
import { sampleLedger } from '../integrations/sampleLedger.js';
import { Invoice, AgentRun, Payment, PurchaseOrder } from '../models/index.js';
import { config } from '../config.js';
import { HttpError, recordAudit } from './runs.js';
import { createInvoiceActions, PAYMENT_METHODS } from './invoiceActions.js';

export const extractor = createExtractor(config);
export const visionReader = createVisionReader(config);
export const abrLookup = createAbrLookup(config);

const agent = createInvoiceAgent({
  ledger: sampleLedger,
  extract: extractor.extract,
  abr: abrLookup,
  policy: config.policy,
  save: (invoice) => invoice.save(),
  today: () => todayIso(),
});

// `reading`: a scan or photo the vision reader has already read (see uploads.js).
export async function processInvoice(invoice, { reading = null } = {}) {
  const run = await AgentRun.create({ agent: agent.name, invoiceId: invoice._id, status: 'running', steps: [] });

  const result = await runAgent(
    agent,
    { invoice, reading },
    {
      onStep: async (_step, steps) => {
        run.steps = [...steps];
        await run.save();
      },
    },
  );

  // If even the escalate stage failed, make sure the invoice is not left looking fine.
  if (!result.outcome) {
    const reason = `The agent could not finish: ${result.error?.message || 'unknown error'}`;
    await Invoice.updateOne({ _id: invoice._id }, { $set: { status: 'failed', decision: { outcome: 'failed', reasons: [reason] } } });
    await recordAudit({ subjectKind: 'invoice', subjectId: invoice._id, actor: 'Agent', action: 'failed', from: invoice.status, to: 'failed', reason });
  }

  run.status = result.outcome || 'failed';
  run.finishedAt = new Date();
  await run.save();
  return result;
}

const actions = createInvoiceActions({
  store: sampleLedger,
  policy: config.policy,
  roles: config.roles,
  rerun: async (id) => {
    const doc = await Invoice.findById(id);
    if (doc) await processInvoice(doc);
  },
});

export async function getInvoiceDetail(id) {
  const invoice = await Invoice.findById(id).lean();
  if (!invoice) throw new HttpError(404, 'That invoice no longer exists.');
  const [run, payment, po] = await Promise.all([
    AgentRun.findOne({ invoiceId: id }).sort({ createdAt: -1 }).lean(),
    Payment.findOne({ invoiceId: id }).lean(),
    invoice.matchedPo ? sampleLedger.findPurchaseOrder(invoice.matchedPo) : null,
  ]);
  const partial = AWAITING_DECISION.includes(invoice.status) ? receivedOnly(invoice, config.policy.gstRatePct) : null;
  const ctx = { payment: payment ? { ...payment, id: String(payment._id) } : null, receivedOnly: partial, roles: config.roles, policy: config.policy };

  // POs a reviewer can link: the supplier's when it is known, otherwise all.
  let linkablePos = [];
  if (AWAITING_DECISION.includes(invoice.status)) {
    const filter = invoice.supplier?.abn ? { vendorAbn: normaliseAbn(invoice.supplier.abn) } : {};
    linkablePos = (await PurchaseOrder.find(filter).select('poNumber vendorName raisedOn').sort({ poNumber: 1 }).lean()).map((p) => ({
      poNumber: p.poNumber,
      vendorName: p.vendorName,
      raisedOn: p.raisedOn,
    }));
  }
  return { invoice, run, payment, po, receivedOnly: partial, actions: allowedActions(invoice, ctx), linkablePos, paymentMethods: PAYMENT_METHODS };
}

async function addHumanStep(id, summary) {
  const run = await AgentRun.findOne({ invoiceId: id }).sort({ createdAt: -1 });
  if (!run) return;
  run.steps = [...run.steps, { stage: 'human', status: 'done', summary, detail: null, ms: 0, at: new Date().toISOString() }];
  await run.save();
}

export async function performInvoiceAction(id, action, input) {
  try {
    const { summary } = await actions.perform(id, action, input || {});
    // Actions that re-run the agent start a new run; the person's step goes on the latest one.
    await addHumanStep(id, summary);
  } catch (err) {
    if (err instanceof ActionError) throw new HttpError(err.status, err.message);
    throw err;
  }
  return getInvoiceDetail(id);
}

// The earlier API: approve | approve_received | reject.
export function applyHumanDecision(id, { decision, decidedBy, note }) {
  if (!['approve', 'approve_received', 'reject'].includes(decision)) throw new HttpError(400, 'Choose approve, approve the received quantity only, or reject.');
  return performInvoiceAction(id, decision, { decidedBy, note });
}

// Overdue and due-soon invoices and the cash needed.
export async function getPayables() {
  const docs = await Invoice.find({ status: { $in: ['under_review', 'needs_review', 'on_hold', 'approved', 'payment_pending', 'payment_failed'] } })
    .select('status extracted.invoiceNumber extracted.vendorName extracted.total extracted.currency extracted.dueDate extracted.invoiceDate extracted.paymentTerms approval')
    .lean();
  const payments = await Payment.find({ invoiceId: { $in: docs.map((d) => d._id) } }).lean();
  return payablesSummary(
    docs.map((d) => ({ ...d, id: String(d._id), payment: payments.find((p) => String(p.invoiceId) === String(d._id)) || null })),
    todayIso(),
  );
}
