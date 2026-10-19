// The audit log: every status change is appended; nothing is ever rewritten.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent } from '../src/agent/finance/invoiceAgent.js';
import { extractWithRules } from '../src/agent/finance/extract.js';
import { auditEntry, bankLineId } from '../src/agent/finance/audit.js';
import { createInvoiceActions } from '../src/services/invoiceActions.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { AuditEvent, APPEND_ONLY } from '../src/models/index.js';
import { vendors, purchaseOrders, goodsReceipts, sampleInvoices, renderInvoiceText } from '../src/seed/data.js';

const policy = { matchThreshold: 85, missingAbn: 'review', priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };
const clone = (x) => JSON.parse(JSON.stringify(x));

function setup() {
  const invoices = [];
  const ledger = createMemoryLedger({ vendors, purchaseOrders, goodsReceipts, invoices });
  const agent = createInvoiceAgent({ ledger, extract: async (text) => extractWithRules(text), policy, save: async () => {}, today: () => '2026-10-12' });
  const actions = createInvoiceActions({ store: ledger, policy, rerun: async (id) => runAgent(agent, { invoice: invoices.find((i) => i.id === id) }) });
  const submit = async (id) => {
    const invoice = {
      id: `inv-${invoices.length + 1}`,
      createdAt: new Date(Date.UTC(2026, 9, 1, invoices.length)),
      source: { kind: 'sample' },
      rawText: renderInvoiceText(sampleInvoices.find((s) => s.id === id)),
      status: 'received',
    };
    invoices.push(invoice);
    await runAgent(agent, { invoice });
    return invoice;
  };
  const act = (invoice, action, input = {}) => actions.perform(invoice.id, action, { decidedBy: 'Priya N', ...input });
  return { ledger, submit, act };
}

test('every status change is appended to the log, and earlier entries are never rewritten', async () => {
  const s = setup();
  const invoice = await s.submit('clean');
  assert.deepEqual(
    s.ledger.auditEvents.map((e) => [e.subjectKind, e.actor, e.action, e.from, e.to]),
    [['invoice', 'Agent', 'processed', 'received', 'under_review']],
  );

  await s.act(invoice, 'approve', { note: 'All matches.' });
  const snapshot = clone(s.ledger.auditEvents);

  await s.act(invoice, 'schedule_payment', { decidedBy: 'Sam K', method: 'EFT', scheduledFor: '2026-10-14' });
  await s.act(invoice, 'record_payment', { decidedBy: 'Sam K', reference: 'EFT-1' });
  await s.act(invoice, 'start_recovery', { note: 'Paid twice by the bank.' });

  const log = s.ledger.auditEvents;
  assert.ok(log.length > snapshot.length, 'the log grew');
  assert.deepEqual(clone(log.slice(0, snapshot.length)), snapshot, 'earlier entries are exactly as they were');
  assert.ok(
    log.every((e) => Object.isFrozen(e)),
    'entries cannot be changed in place',
  );
  assert.throws(() => {
    'use strict';
    log[0].to = 'approved';
  }, TypeError);

  const payment = s.ledger.payments[0];
  assert.deepEqual(
    log.map((e) => [e.subjectKind, e.subjectId, e.actor, e.action, e.from, e.to]),
    [
      ['invoice', invoice.id, 'Agent', 'processed', 'received', 'under_review'],
      ['invoice', invoice.id, 'Priya N', 'approve', 'under_review', 'approved'],
      ['invoice', invoice.id, 'Sam K', 'schedule_payment', 'approved', 'payment_pending'],
      ['payment', payment.id, 'Sam K', 'scheduled', null, 'queued'],
      ['invoice', invoice.id, 'Sam K', 'record_payment', 'payment_pending', 'payment_completed'],
      ['payment', payment.id, 'Sam K', 'paid', 'queued', 'paid'],
      ['invoice', invoice.id, 'Priya N', 'start_recovery', 'payment_completed', 'payment_completed'],
      ['payment', payment.id, 'Priya N', 'recovery_opened', 'paid', 'paid'],
    ],
  );
  assert.equal(log[1].reason, 'All matches.');
  assert.ok(log.every((e) => !Number.isNaN(Date.parse(e.at))));

  // One record's history, oldest first.
  const history = await s.ledger.listAudit({ subjectId: payment.id });
  assert.deepEqual(
    history.map((e) => e.action),
    ['scheduled', 'paid', 'recovery_opened'],
  );
});

test('corrections are logged with their before and after values; refused actions log nothing', async () => {
  const s = setup();
  const invoice = await s.submit('clean');
  const before = s.ledger.auditEvents.length;
  await assert.rejects(s.act(invoice, 'reject', { note: '' }));
  assert.equal(s.ledger.auditEvents.length, before, 'nothing changed, nothing logged');

  await s.act(invoice, 'edit_fields', { note: 'PO was misread.', fields: { poNumber: 'PO-2041', total: 1402.5, invoiceNumber: 'HOS-10482-A' } });
  const edit = s.ledger.auditEvents.find((e) => e.action === 'edit_fields');
  assert.match(edit.detail, /Changes: \[\{"field":"invoiceNumber","from":"HOS-10482","to":"HOS-10482-A"\}\]/);
  assert.equal(edit.reason, 'PO was misread.');
  const after = s.ledger.auditEvents.at(-1);
  assert.deepEqual([after.actor, after.action, after.from], ['Agent', 'processed', 'processing'], 'the agent re-checking is logged too');
});

test('audit entries have a fixed shape', () => {
  const e = auditEntry({
    subjectKind: 'bank_line',
    subjectId: bankLineId('st1', 4),
    actor: 'Sam K',
    action: 'dismiss',
    from: 'unmatched',
    to: 'dismissed',
    at: '2026-10-05T01:00:00Z',
  });
  assert.deepEqual(e, {
    subjectKind: 'bank_line',
    subjectId: 'st1:4',
    actor: 'Sam K',
    action: 'dismiss',
    from: 'unmatched',
    to: 'dismissed',
    reason: null,
    detail: null,
    at: new Date('2026-10-05T01:00:00Z'),
  });
  assert.throws(() => auditEntry({ subjectKind: 'nonsense', subjectId: 'x' }), /Unknown audit subject/);
});

test('the database refuses to change or delete audit entries', async () => {
  // Refused before anything reaches MongoDB, so no database is needed here.
  for (const attempt of [
    () => AuditEvent.updateOne({}, { $set: { to: 'approved' } }),
    () => AuditEvent.updateMany({}, { $set: { to: 'approved' } }),
    () => AuditEvent.findOneAndUpdate({}, { $set: { to: 'approved' } }),
    () => AuditEvent.replaceOne({}, {}),
    () => AuditEvent.deleteOne({}),
    () => AuditEvent.deleteMany({}),
    () => AuditEvent.findOneAndDelete({}),
    () => AuditEvent.bulkWrite([{ deleteMany: { filter: {} } }]),
  ]) {
    await assert.rejects(attempt(), (err) => err.message === APPEND_ONLY);
  }
  const existing = new AuditEvent(auditEntry({ subjectKind: 'invoice', subjectId: 'x', actor: 'a', action: 'b' }));
  existing.isNew = false;
  await assert.rejects(existing.save(), (err) => err.message === APPEND_ONLY);
});
