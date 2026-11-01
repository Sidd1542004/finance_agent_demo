import mongoose from 'mongoose';
import { SUBJECT_KINDS } from '../agent/finance/audit.js';

const { Schema, model } = mongoose;
const Mixed = Schema.Types.Mixed;

// ----- People and sessions (see auth/) -----

// reviewer: checks and corrects invoices, handles supplier emails.
// approver: approves, rejects, reverses; approves bank-detail changes.
// payer: schedules and records payments, reconciles the bank.
// admin: users, simulated bank settings, demo controls. Not approving or
// paying unless those roles are granted too.
export const ROLES = ['reviewer', 'approver', 'payer', 'admin'];

export const User = model(
  'User',
  new Schema(
    {
      email: { type: String, required: true, unique: true, lowercase: true, trim: true },
      name: { type: String, required: true, trim: true },
      passwordHash: { type: String, required: true },
      roles: { type: [{ type: String, enum: ROLES }], default: [] },
      active: { type: Boolean, default: true },
      failedLogins: { type: Number, default: 0 },
      lockedUntil: { type: Date, default: null },
      lastLoginAt: { type: Date, default: null },
      passwordChangedAt: { type: Date, default: null },
      createdBy: { type: String, default: null },
    },
    { timestamps: true },
  ),
);

// One row per signed-in browser. Only the SHA-256 of the cookie's token is
// stored, so a database read does not give anyone a usable session.
// MongoDB deletes expired sessions itself (TTL index).
export const Session = model(
  'Session',
  new Schema(
    {
      tokenHash: { type: String, required: true, unique: true },
      userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      expiresAt: { type: Date, required: true, index: { expires: 0 } },
      lastSeenAt: { type: Date, default: null },
    },
    { timestamps: true },
  ),
);

// The agent's adjustable policy (the Settings screen): ONE document, _id 'policy'.
// Created with the environment's values (MATCH_THRESHOLD, PRICE_TOLERANCE_PCT,
// MIN_CONFIDENCE) the first time it is read; from then on only an administrator
// changes it, with a reason, version by version (compare-and-set). See
// services/policySettings.js. Percentages: confidenceFloor 99 means 0.99.
export const PolicySettings = model(
  'PolicySettings',
  new Schema(
    {
      _id: { type: String, default: 'policy' },
      matchThreshold: { type: Number, required: true },
      priceTolerancePct: { type: Number, required: true },
      confidenceFloor: { type: Number, required: true },
      version: { type: Number, required: true, default: 1 },
      updatedBy: { id: { type: String, default: null }, name: { type: String, default: null } },
      updatedAt: { type: Date, default: null },
    },
    { versionKey: false },
  ),
  'policysettings',
);

// Small one-off flags, keyed by _id (for example the first-administrator setup).
export const Setting = model('Setting', new Schema({ _id: String, value: { type: Mixed, default: null } }, { timestamps: true }));

// ----- Reference data (stands in for the accounting system) -----

export const Vendor = model(
  'Vendor',
  new Schema({
    name: { type: String, required: true },
    abn: { type: String, required: true, unique: true },
    gstRegistered: { type: Boolean, default: true },
    email: String,
    // Where payments go: SIMULATED details only (see agent/finance/beneficiary.js).
    // Only ever set by approving a BeneficiaryChange proposed by someone else.
    // { accountName, bsb, accountNumber, billerCode, crn, cardToken, status:
    //   'verified', version, changeId, proposedBy, verifiedBy, verifiedById, verifiedAt, simulated }
    beneficiary: { type: Mixed, default: null },
  }),
);

// A proposed change to a supplier's bank details. Two people: whoever
// proposes cannot approve. At most one pending change per supplier (index).
// Kept, with the decision, as the history of the supplier's details.
const beneficiaryChangeSchema = new Schema(
  {
    vendorAbn: { type: String, required: true, index: true },
    vendorName: String,
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'withdrawn'], default: 'pending' },
    details: { type: Mixed, required: true }, // the proposed (simulated) details
    baseVersion: { type: Number, default: 0 }, // the version it replaces; 0 = none
    reason: { type: String, default: '' },
    proposedBy: { type: String, required: true },
    proposedById: { type: String, required: true },
    decidedBy: { type: String, default: null },
    decidedById: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: null },
  },
  { timestamps: true },
);
beneficiaryChangeSchema.index({ vendorAbn: 1 }, { name: 'one_pending_change_per_supplier', unique: true, partialFilterExpression: { status: 'pending' } });
export const BeneficiaryChange = model('BeneficiaryChange', beneficiaryChangeSchema);

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
  'payment_processing',
  'payment_completed',
  'payment_failed',
  'rejected',
  'cancelled',
  'failed',
];

const invoiceSchema = new Schema(
  {
    // scan: { from: 'image' | 'pdf', pages, model } when read from a scan or photo by the vision reader.
    // email: { provider, messageId, attachmentKey, from, subject, receivedAt, itemId } for an invoice imported
    // from a mailbox (kind 'email'); fileHash: SHA-256 of the attachment, unique (one invoice per file).
    source: {
      kind: { type: String, enum: ['sample', 'upload', 'paste', 'email'], required: true },
      filename: String,
      sampleId: String,
      scan: { type: Mixed, default: undefined },
      email: { type: Mixed, default: undefined },
      fileHash: { type: String, default: undefined },
    },
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
    // Read by the rules reader because the AI reader failed: { code, reason, at, since }. Cleared when
    // the AI reader reads it again. See invoiceAgent.js (ai_reader_unavailable).
    aiFallback: { type: Mixed, default: null },
    // Set only when the (simulated) bank confirmed the payment: { txnRef, confirmedAt, amount, simulated }
    paymentConfirmation: { type: Mixed, default: null },
    corrections: { type: [Mixed], default: [] }, // fields a reviewer corrected: { field, from, to, by, note, at }. Append only.
    events: { type: [Mixed], default: [] }, // status history: { at, actor, action, from, to, reason }. Append only.
  },
  { timestamps: true, minimize: false },
);
// The same attachment never becomes two invoices, even with two workers at once.
// Partial: only invoices imported from a mailbox carry a file hash.
invoiceSchema.index({ 'aiFallback.at': -1 }, { name: 'ai_fallback', sparse: true });
invoiceSchema.index({ 'source.fileHash': 1 }, { name: 'one_invoice_per_file', unique: true, partialFilterExpression: { 'source.fileHash': { $type: 'string' } } });
export const Invoice = model('Invoice', invoiceSchema);

// The original file of an invoice (uploaded, or imported from a mailbox), so a
// person can view it in the app. Kept apart from Invoice so that invoice
// lists, the agent and the reports never load the file. One per invoice, at
// most 4 MB; only PDF, PNG, JPEG or plain text, decided from the bytes (see
// services/invoiceDocuments.js).
export const InvoiceDocument = model(
  'InvoiceDocument',
  new Schema(
    {
      invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true, unique: true },
      filename: { type: String, default: 'invoice.pdf' },
      contentType: { type: String, enum: ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'] },
      mimeType: { type: String, default: undefined }, // records kept before contentType (always PDFs)
      size: { type: Number, required: true },
      sha256: { type: String, required: true },
      data: { type: Buffer, required: true },
    },
    { timestamps: true },
  ),
);

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
    subjectKind: { type: String, enum: SUBJECT_KINDS, required: true },
    subjectId: { type: String, required: true },
    actor: { type: String, required: true },
    actorId: { type: String, default: undefined }, // the signed-in user's id, when a person acted
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

// The assistant's conversation threads (orchestrator/threads.js): per person,
// what was asked (the intent) and which records each answer showed, plus a
// pending clarification's options. Never the question, an answer, a name or an
// amount. Strict: no other field can be stored. Deleted 24 h after they start
// (TTL index on expiresAt); every read checks expiresAt too.
const threadRecord = new Schema(
  { kind: { type: String, enum: ['invoice', 'payment', 'supplier', 'bank_line'], required: true }, id: { type: String, required: true, maxlength: 64 } },
  { _id: false, strict: 'throw' },
);
export const OrchestratorThread = model(
  'OrchestratorThread',
  new Schema(
    {
      _id: { type: String, required: true },
      ownerId: { type: String, required: true, index: true },
      expiresAt: { type: Date, required: true },
      turns: {
        type: [
          new Schema(
            { at: { type: Date, required: true }, intent: { type: String, required: true, maxlength: 40 }, records: { type: [threadRecord], default: [] } },
            { _id: false, strict: 'throw' },
          ),
        ],
        default: [],
      },
      options: {
        type: [
          new Schema(
            {
              optionId: { type: String, required: true },
              intent: { type: String, required: true, maxlength: 40 },
              args: { type: Mixed, default: {} },
              records: { type: [threadRecord], default: [] },
            },
            { _id: false, strict: 'throw', minimize: false },
          ),
        ],
        default: [],
      },
    },
    { timestamps: true, strict: 'throw' },
  ).index({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
);

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
      // Invoice runs: the policy the agent checked against { matchThreshold, priceTolerancePct, confidenceFloor, version }.
      policy: { type: Mixed, default: null },
      finishedAt: Date,
    },
    { timestamps: true },
  ),
);

// Payment queue. One entry per invoice, enforced by the unique index.
const paymentSchema = new Schema(
  {
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true, unique: true },
    vendorName: String,
    vendorAbn: String,
    invoiceNumber: String,
    amount: { type: Number, required: true },
    invoiceTotal: { type: Number, default: null }, // set when a person approved less than the invoice total
    dueDate: String,
    approvedBy: String,
    // Simulated payments. queued = scheduled (Payment Pending). processing = the
    // simulated bank accepted it, not yet confirmed. paid needs a recorded
    // payment, a matching bank line or (bank-routed) the bank's confirmed
    // SUCCESS. failed and cancelled are kept, never deleted.
    status: { type: String, enum: ['queued', 'on_hold', 'processing', 'paid', 'failed', 'cancelled'], default: 'queued' },
    // bank: EFT, BPAY or Card, executed through the (simulated) bank by the
    // cron tick and confirmed only by it. manual: Cheque or Other, paid outside
    // the system and recorded with Record payment, as before.
    route: { type: String, enum: ['bank', 'manual'], default: 'manual' },
    currency: { type: String, default: 'AUD' },
    scheduledAt: { type: Date, default: null }, // the instant it may run (bank-routed)
    timeZone: { type: String, default: null },
    // Bumped by every (re)schedule. A job only runs for the version it was made for.
    scheduleVersion: { type: Number, default: 1 },
    scheduledById: { type: String, default: null },
    approvalSnapshot: { type: Mixed, default: null }, // { decidedBy, decidedById, decidedAt, amount }
    beneficiary: { type: Mixed, default: null }, // masked snapshot: { version, accountName, method, masked }
    // The current bank instruction: { idempotencyKey, amount, state, txnRef, bankStatus, submittedAt, completesAt, lastCheckedAt, error }
    submission: { type: Mixed, default: null },
    submissions: { type: [Mixed], default: [] }, // earlier instructions (failed attempts), kept
    confirmation: { type: Mixed, default: null }, // the bank's confirmed success: { txnRef, confirmedAt, amount, simulated }
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
);
paymentSchema.index({ route: 1, status: 1 });
export const Payment = model('Payment', paymentSchema);

// One execution job per scheduled bank-routed payment. The cron tick claims
// due jobs atomically with a lease; an abandoned lease can be taken over. At
// most one active (pending or running) job per payment, enforced by the index.
const paymentJobSchema = new Schema(
  {
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
    scheduleVersion: { type: Number, required: true },
    runAt: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'running', 'done', 'failed', 'cancelled', 'superseded'], default: 'pending' },
    active: { type: Boolean, default: true }, // true while pending or running
    attempts: { type: Number, default: 0 },
    leaseOwner: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    lastError: { type: String, default: null },
    result: { type: String, default: null },
    history: { type: [Mixed], default: [] },
  },
  { timestamps: true },
);
paymentJobSchema.index({ paymentId: 1 }, { name: 'one_active_job_per_payment', unique: true, partialFilterExpression: { active: true } });
paymentJobSchema.index({ active: 1, status: 1, runAt: 1 });
paymentJobSchema.index({ active: 1, status: 1, leaseUntil: 1 });
export const PaymentJob = model('PaymentJob', paymentJobSchema);

// ----- The simulated bank (SIMULATED: no real bank, no real money) -----

export const SimBankAccount = model(
  'SimBankAccount',
  new Schema(
    {
      _id: String, // e.g. SIM-OPERATING
      name: String,
      bsb: String,
      accountNumber: String,
      currency: { type: String, default: 'AUD' },
      balance: { type: Number, required: true }, // confirmed payments reduce it
      reserved: { type: Number, default: 0 }, // accepted, not yet settled
      simulated: { type: Boolean, default: true },
    },
    { timestamps: true },
  ),
);

const simTxnSchema = new Schema(
  {
    ref: { type: String, required: true, unique: true },
    idempotencyKey: { type: String, required: true, unique: true },
    requestHash: { type: String, required: true },
    accountId: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: String,
    method: String,
    beneficiary: { type: Mixed, default: null }, // masked
    reference: String,
    payee: { type: Mixed, default: null }, // { abn, name }
    scenario: String,
    status: { type: String, enum: ['PROCESSING', 'SUCCESS', 'FAILED', 'REJECTED'], required: true },
    plannedOutcome: { type: String, default: null },
    failureCode: { type: String, default: null },
    failureMessage: { type: String, default: null },
    completesAt: { type: Date, default: null },
    settledAt: { type: Date, default: null },
    history: { type: [Mixed], default: [] },
    simulated: { type: Boolean, default: true },
  },
  { timestamps: true },
);
simTxnSchema.index({ status: 1, completesAt: 1 });
export const SimBankTransaction = model('SimBankTransaction', simTxnSchema);

// Deterministic test scenarios, set by an administrator per supplier (by ABN).
export const SimBankScenario = model(
  'SimBankScenario',
  new Schema({ _id: String, scenario: { type: String, required: true }, setBy: String, setById: String }, { timestamps: true }),
);

// How many times each idempotency key was tried (the "temporary failure" scenario).
export const SimBankAttempt = model('SimBankAttempt', new Schema({ _id: String, count: { type: Number, default: 0 } }, { timestamps: true }));

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

// Messages to suppliers: replies to their emails (one per email), and payment
// notices (kind payment_*, one per payment, kind and bank transaction).
// Replies are never emailed (sample outbox). Payment notices are delivered
// only as services/emailDelivery.js allows: outside production, to the test
// recipient or nowhere (kept here as the simulated outbox).
//
// Indexes are created by ensureOutboxIndexes() below, not autoIndex: older
// databases have a plain unique index on queryId, which must be replaced by a
// partial one before payment notices (which have no queryId) can be stored.
const outboxSchema = new Schema(
  {
    kind: { type: String, enum: ['query_reply', 'payment_success', 'payment_processing', 'payment_failed'], default: 'query_reply' },
    queryId: {
      type: Schema.Types.ObjectId,
      ref: 'VendorQuery',
      required() {
        return this.kind === 'query_reply';
      },
    },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
    txnRef: { type: String },
    dedupKey: { type: String },
    to: { type: String, required: true },
    subject: String,
    body: { type: String, required: true },
    sentBy: String,
    sentById: String,
    // draft: a payment notice waiting for a person to approve it.
    status: { type: String, enum: ['draft', 'queued', 'sending', 'sent', 'held', 'discarded'], default: 'queued' },
    sentAt: Date,
    delivery: { type: Mixed, default: null }, // { mode, intendedTo, deliveredTo, redirected, id, error, at }
  },
  { timestamps: true, autoIndex: false },
);
outboxSchema.index({ queryId: 1 }, { name: 'queryId_unique_when_set', unique: true, partialFilterExpression: { queryId: { $exists: true } } });
outboxSchema.index({ dedupKey: 1 }, { name: 'dedupKey_unique_when_set', unique: true, partialFilterExpression: { dedupKey: { $exists: true } } });
outboxSchema.index({ kind: 1, status: 1, createdAt: -1 });
export const OutboxMessage = model('OutboxMessage', outboxSchema);

/**
 * Bring the outbox's indexes up to date. Safe to run any number of times.
 * Replaces the old plain unique index on queryId (which refuses a second
 * message without a queryId) with a partial one. Returns what it dropped.
 */
export async function ensureOutboxIndexes() {
  const dropped = [];
  let existing = [];
  try {
    existing = await OutboxMessage.collection.indexes();
  } catch (err) {
    if (err?.codeName !== 'NamespaceNotFound' && err?.code !== 26) throw err;
  }
  for (const ix of existing) {
    if (ix.key?.queryId === 1 && !ix.partialFilterExpression) {
      await OutboxMessage.collection.dropIndex(ix.name);
      dropped.push(ix.name);
    }
  }
  await OutboxMessage.createIndexes();
  return dropped;
}

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

// ----- Automatic invoice ingestion (see services/ingestion.js) -----

// One per mailbox provider ('gmail' | 'outlook'): connection, settings and sync state.
// `credentials` holds the refresh token ENCRYPTED (AES-256-GCM, INGESTION_ENCRYPTION_KEY);
// it is never returned by the API. `pendingAuth` is a short-lived OAuth sign-in in progress.
export const IngestionSource = model(
  'IngestionSource',
  new Schema(
    {
      _id: { type: String, enum: ['gmail', 'outlook'] },
      status: { type: String, enum: ['disconnected', 'connected', 'error'], default: 'disconnected' },
      enabled: { type: Boolean, default: false }, // an administrator turns polling on after connecting
      account: { type: String, default: null }, // the mailbox address, when the provider tells us
      credentials: { type: Mixed, default: null }, // { v, keyId, iv, tag, data } - encrypted refresh token
      scopes: { type: [String], default: [] },
      connectedBy: { type: String, default: null },
      connectedById: { type: String, default: null },
      connectedAt: { type: Date, default: null },
      pendingAuth: { type: Mixed, default: null }, // { stateHash, verifier (encrypted), byId, expiresAt }
      cursor: { type: Date, default: null }, // messages received from this time are looked at
      lastPollAt: { type: Date, default: null },
      lastSuccessAt: { type: Date, default: null },
      lastError: { type: Mixed, default: null }, // { message, code, at }
      emailsChecked: { type: Number, default: 0 },
      lock: { type: Mixed, default: null }, // { token, until }: one sync at a time
    },
    { timestamps: true, minimize: false },
  ),
);

// One per attachment of a message (or one with attachmentKey '' for a message
// with no invoice attachment), so the same email or file is never processed twice.
const ingestionItemSchema = new Schema(
  {
    provider: { type: String, enum: ['gmail', 'outlook'], required: true },
    messageId: { type: String, required: true },
    attachmentKey: { type: String, default: '' }, // stable per message: Gmail part id, Graph attachment id
    attachmentId: { type: String, default: null }, // what the provider needs to download it (may change)
    filename: { type: String, default: null },
    mimeType: { type: String, default: null },
    size: { type: Number, default: null },
    sha256: { type: String, default: null, index: true },
    from: { type: String, default: null }, // sender address only
    subject: { type: String, default: null }, // first 200 characters; the body is never stored
    receivedAt: { type: Date, default: null },
    // pending -> processing -> imported | duplicate | rejected | failed (retried while attempts remain);
    // skipped: a message with no invoice attachment.
    status: { type: String, enum: ['pending', 'processing', 'imported', 'duplicate', 'rejected', 'failed', 'skipped'], default: 'pending', index: true },
    reason: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null },
    duplicateOf: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null }, // the earlier invoice it matches
    duplicateSignals: { type: [String], default: [] },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);
ingestionItemSchema.index({ provider: 1, messageId: 1, attachmentKey: 1 }, { name: 'one_item_per_attachment', unique: true });
ingestionItemSchema.index({ provider: 1, status: 1, nextAttemptAt: 1 });
ingestionItemSchema.index({ createdAt: -1 });
export const IngestionItem = model('IngestionItem', ingestionItemSchema);
