import mongoose from 'mongoose';

const { Schema, model } = mongoose;
const Mixed = Schema.Types.Mixed;

// ----- Reference data (stands in for the accounting system) -----

export const Vendor = model(
  'Vendor',
  new Schema({
    name: { type: String, required: true },
    abn: { type: String, required: true, unique: true },
    gstRegistered: { type: Boolean, default: true },
    email: String,
  }),
);

export const PurchaseOrder = model(
  'PurchaseOrder',
  new Schema({
    poNumber: { type: String, required: true, unique: true },
    vendorAbn: { type: String, required: true },
    vendorName: String,
    raisedOn: String,
    lines: [{ _id: false, sku: String, description: String, qty: Number, unitPrice: Number }],
  }),
);

export const GoodsReceipt = model(
  'GoodsReceipt',
  new Schema({
    poNumber: { type: String, required: true, index: true },
    receivedOn: String,
    lines: [{ _id: false, sku: String, qty: Number }],
  }),
);

// ----- What the agent works on -----

// Invoice statuses: see agent/finance/lifecycle.js for the allowed moves.
export const INVOICE_STATUSES = [
  'received',
  'processing',
  'under_review',
  'needs_review',
  'on_hold',
  'approved',
  'payment_pending',
  'payment_completed',
  'payment_failed',
  'rejected',
  'cancelled',
  'failed',
];

const invoiceSchema = new Schema(
  {
    // scan: { from: 'image' | 'pdf', pages, model } when read from a scan or photo by the vision reader.
    source: { kind: { type: String, enum: ['sample', 'upload', 'paste'], required: true }, filename: String, sampleId: String, scan: { type: Mixed, default: undefined } },
    rawText: { type: String, required: true }, // for a scan or photo: the vision reader's transcription
    status: { type: String, enum: INVOICE_STATUSES, default: 'received', index: true },
    extracted: { type: Mixed, default: null }, // fields read from the invoice
    extraction: { type: Mixed, default: null }, // which reader, confidence, notes
    validation: { type: Mixed, default: null }, // jurisdiction, tax identifier, GST registration
    match: { type: Mixed, default: null }, // score, comparison table, PO suggestions
    supplier: { type: Mixed, default: null }, // the supplier record it was matched to
    due: { type: Mixed, default: null }, // due date and where it came from
    dupKey: { type: String, default: null, index: true }, // kept for older records: supplier + invoice number
    fingerprints: {
      numberKey: { type: String, default: null, index: true },
      amountKey: { type: String, default: null, index: true },
      looseKey: { type: String, default: null, index: true },
      contentHash: { type: String, default: null, index: true },
    },
    matchedPo: { type: String, default: null, index: true },
    checks: { type: [Mixed], default: [] },
    lineMatches: { type: [Mixed], default: [] },
    decision: { type: Mixed, default: null }, // the agent's outcome and reasons
    approval: { type: Mixed, default: null }, // the approval, kept even if it is later reversed
    poOverride: { type: Mixed, default: null }, // a PO a reviewer linked: { poNumber, decidedBy, note, at }
    duplicateCleared: { type: Mixed, default: null }, // { decidedBy, note, at }
    correction: { type: Mixed, default: null }, // corrected invoice requested: { decidedBy, note, at }
    reversal: { type: Mixed, default: null }, // approval reversed: { decidedBy, note, at, from }
    rejection: { type: Mixed, default: null }, // { decidedBy, note, decidedAt }
    hold: { type: Mixed, default: null }, // placed on hold by a person: { decidedBy, note, decidedAt }
    cancellation: { type: Mixed, default: null }, // { decidedBy, note, at, from }
    reopened: { type: Mixed, default: null }, // accidental decision undone: { decidedBy, note, at, from, priorDecision }
    recovery: { type: Mixed, default: null }, // money already paid being recovered: { status, opened, closed }
    corrections: { type: [Mixed], default: [] }, // fields a reviewer corrected: { field, from, to, by, note, at }. Append only.
    events: { type: [Mixed], default: [] }, // status history: { at, actor, action, from, to, reason }. Append only.
  },
  { timestamps: true, minimize: false },
);
export const Invoice = model('Invoice', invoiceSchema);

// What reviewers' corrections taught the reader about one supplier's invoices:
// per field, the label printed near the value and an example of the format.
// Never a whole invoice. See agent/finance/supplierHints.js.
export const SupplierHint = model(
  'SupplierHint',
  new Schema(
    {
      vendorAbn: { type: String, required: true },
      vendorName: String,
      field: { type: String, required: true },
      label: { type: String, default: null },
      example: { type: String, required: true },
      updatedBy: String,
      updatedAt: String,
    },
    { timestamps: false },
  ).index({ vendorAbn: 1, field: 1 }, { unique: true }),
);

// ----- The audit log -----

// Every status change of an invoice, payment, supplier email, bank line or
// report (see agent/finance/audit.js). Append only: updates and deletes are
// refused here, so no code path (and no route) can rewrite the history.
const auditSchema = new Schema(
  {
    subjectKind: { type: String, enum: ['invoice', 'payment', 'query', 'statement', 'bank_line', 'report', 'system'], required: true },
    subjectId: { type: String, required: true },
    actor: { type: String, required: true },
    action: { type: String, required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    reason: { type: String, default: null },
    detail: { type: String, default: null },
    at: { type: Date, required: true },
  },
  { versionKey: false },
);
auditSchema.index({ subjectId: 1, at: 1 });
auditSchema.index({ at: -1 });
export const APPEND_ONLY = 'The audit log is append only: entries cannot be changed or deleted.';
const refuse = () => {
  throw new Error(APPEND_ONLY);
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'replaceOne', 'deleteOne', 'deleteMany']) {
  auditSchema.pre(op, { document: false, query: true }, refuse);
}
auditSchema.pre('deleteOne', { document: true, query: false }, refuse);
auditSchema.pre('save', function auditInsertOnly() {
  if (!this.isNew) throw new Error(APPEND_ONLY);
});
auditSchema.pre('bulkWrite', refuse);
export const AuditEvent = model('AuditEvent', auditSchema);

// One record per agent run: the audit trail of the six stages.
export const AgentRun = model(
  'AgentRun',
  new Schema(
    {
      agent: { type: String, required: true },
      // Invoice runs use invoiceId. The other workflows use subjectKind + subjectId.
      invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', index: true },
      subjectKind: { type: String, enum: ['query', 'statement', 'report'] },
      subjectId: { type: Schema.Types.ObjectId, index: true },
      status: { type: String, default: 'running' },
      steps: { type: [Mixed], default: [] },
      finishedAt: Date,
    },
    { timestamps: true },
  ),
);

// Payment queue. One entry per invoice, enforced by the unique index.
export const Payment = model(
  'Payment',
  new Schema(
    {
      invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true, unique: true },
      vendorName: String,
      vendorAbn: String,
      invoiceNumber: String,
      amount: { type: Number, required: true },
      invoiceTotal: { type: Number, default: null }, // set when a person approved less than the invoice total
      dueDate: String,
      approvedBy: String,
      // Simulated payments. queued = Payment Pending. paid needs a recorded payment
      // or a matching bank line. failed and cancelled are kept, never deleted.
      status: { type: String, enum: ['queued', 'on_hold', 'paid', 'failed', 'cancelled'], default: 'queued' },
      simulated: { type: Boolean, default: true },
      method: { type: String, default: null }, // EFT, BPAY, card, cheque, other
      reference: { type: String, default: null },
      scheduledFor: { type: String, default: null },
      scheduledBy: { type: String, default: null },
      attempts: { type: Number, default: 1 },
      paidAmount: { type: Number, default: null },
      paidOn: { type: String, default: null },
      recordedBy: { type: String, default: null },
      failure: { type: Mixed, default: null },
      recovery: { type: Mixed, default: null },
      history: { type: [Mixed], default: [] },
      bank: { type: Mixed, default: null }, // { statementId, line, date, description }
    },
    { timestamps: true },
  ),
);

// ----- Vendor queries -----

// An email from a supplier.
export const VendorQuery = model(
  'VendorQuery',
  new Schema(
    {
      source: { kind: { type: String, enum: ['sample', 'manual'], required: true }, sampleId: String },
      from: { type: String, required: true },
      subject: { type: String, default: '' },
      body: { type: String, required: true },
      status: { type: String, enum: ['received', 'processing', 'answered', 'needs_person', 'closed', 'failed'], default: 'received', index: true },
      understood: { type: Mixed, default: null }, // { intent, invoiceNumbers, summary }
      reading: { type: Mixed, default: null }, // which reader, confidence, notes
      supplier: { type: Mixed, default: null },
      matchedInvoices: { type: [Mixed], default: [] },
      checks: { type: [Mixed], default: [] },
      decision: { type: Mixed, default: null },
      draft: { type: Mixed, default: null }, // { subject, body } prepared by the agent
      resolution: { type: Mixed, default: null }, // the human decision, if one was needed
    },
    { timestamps: true, minimize: false },
  ),
);

// Replies to suppliers. One per email, enforced by the unique index.
// Sample outbox only: nothing here is actually emailed.
export const OutboxMessage = model(
  'OutboxMessage',
  new Schema(
    {
      queryId: { type: Schema.Types.ObjectId, ref: 'VendorQuery', required: true, unique: true },
      to: { type: String, required: true },
      subject: String,
      body: { type: String, required: true },
      sentBy: String,
      status: { type: String, enum: ['queued', 'sent', 'held'], default: 'queued' },
      sentAt: Date,
    },
    { timestamps: true },
  ),
);

// ----- Bank reconciliation -----

export const BankStatement = model(
  'BankStatement',
  new Schema(
    {
      source: { kind: { type: String, enum: ['sample', 'upload', 'paste'], required: true }, filename: String },
      rawText: { type: String, required: true },
      status: { type: String, enum: ['received', 'processing', 'reconciled', 'needs_person', 'failed'], default: 'received', index: true },
      lines: { type: [Mixed], default: [] }, // one entry per statement line, with its match
      unpaid: { type: [Mixed], default: [] }, // approved payments this statement does not show
      decision: { type: Mixed, default: null },
    },
    // optimisticConcurrency: two people deciding lines at the same moment cannot overwrite each other.
    { timestamps: true, minimize: false, optimisticConcurrency: true },
  ),
);

// ----- Month-end reporting -----

export const Report = model(
  'Report',
  new Schema(
    {
      month: { type: String, required: true, index: true }, // YYYY-MM
      status: { type: String, enum: ['processing', 'ready', 'open_items', 'failed'], default: 'processing' },
      figures: { type: Mixed, default: null },
      commentary: { type: Mixed, default: null }, // { text, method, model, note }
      decision: { type: Mixed, default: null },
    },
    { timestamps: true, minimize: false },
  ),
);
