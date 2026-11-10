// Goods invoiced against a purchase order need a delivery slip (goods receipt)
// before they can be approved (matching.js, lifecycle.js). With the policy
// switch requireDeliverySlip off, the old behaviour: the quantity check passes
// with a "not checked" note. Service lines on the PO never need one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchToPo, skuKey } from '../src/agent/finance/matching.js';
import { statusFromChecks, blockedReason, blockingUnverified } from '../src/agent/finance/lifecycle.js';
import { vendors, purchaseOrders, findSample } from '../src/seed/data.js';
import { startApp } from '../test-support/app.js';

const POLICY = { matchThreshold: 99, missingAbn: 'review', priceTolerancePct: 2, minConfidence: 0.99, gstRatePct: 10, roundingTolerance: 0.05 };
const PO = purchaseOrders[0]; // PO-2041: paper, toner, pens (Harbour Office Supplies)
const HARBOUR = vendors.find((v) => v.abn === PO.vendorAbn);
// The clean sample invoice (HOS-10482) as read: every line on PO-2041 at the PO price.
const clean = findSample('clean');
const subtotal = clean.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0); // 1,275.00
const extracted = {
  vendorName: clean.vendor.name,
  abn: clean.vendor.abn,
  poNumber: PO.poNumber,
  currency: 'AUD',
  subtotal,
  gst: Math.round(subtotal * 10) / 100,
  total: Math.round(subtotal * 110) / 100,
  lines: clean.lines.map((l) => ({ sku: l.sku, description: l.description, qty: l.qty, unitPrice: l.unitPrice, amount: l.qty * l.unitPrice })),
};
// Receipts are keyed by the normalised SKU, as the ledger gives them (skuKey).
const ALL_RECEIVED = Object.fromEntries(PO.lines.map((l) => [skuKey(l.sku), l.qty]));
const match = ({ received = null, policy = POLICY, po = PO, lines = extracted.lines } = {}) =>
  matchToPo({ extracted: { ...extracted, lines }, vendor: HARBOUR, po, received, invoicedBefore: {}, taxStatus: 'pass', arithmeticOk: true, policy });
const qtyCheck = (r) => r.checks.find((c) => c.id === 'quantity_match');
const qtyPart = (r) => r.score.components.find((c) => c.id === 'quantity');
const asInvoice = (r, status) => ({
  status,
  checks: r.checks,
  extracted: { ...extracted, total: extracted.total },
  supplier: { name: HARBOUR.name, abn: HARBOUR.abn, by: 'abn' },
  match: { po: r.po },
});

test('no delivery slip for goods: quantity_match is unverified and blocking, the quantity part scores 0.5, Needs Review, not eligible', () => {
  const r = match();
  const q = qtyCheck(r);
  assert.equal(q.status, 'unverified');
  assert.equal(q.blocking, true);
  assert.equal(q.severity, 'review');
  assert.equal(q.detail, 'No delivery slip (goods receipt) is recorded for PO-2041, so delivery could not be confirmed.');
  assert.equal(qtyPart(r).value, 0.5);
  assert.equal(qtyPart(r).points, 10);
  assert.match(qtyPart(r).detail, /No delivery slip is recorded, so those goods count half\./);
  assert.equal(r.score.eligible, false);
  assert.ok(r.lineMatches.every((l) => l.kind === 'goods' && l.receiptUnconfirmed));
  assert.equal(statusFromChecks(r.checks), 'needs_review');
  assert.deepEqual(
    blockingUnverified(r.checks).map((c) => c.id),
    ['quantity_match'],
  );
  // A person cannot approve it, nor approve "the received quantity" (nothing is recorded as received).
  assert.match(blockedReason(asInvoice(r, 'needs_review'), 'approve'), /^No delivery slip \(goods receipt\) is recorded for the purchase order, so delivery is not confirmed\./);
  assert.ok(blockedReason(asInvoice(r, 'needs_review'), 'approve_received'));
});

test('the delivery slip matches: quantity_match passes and counts in full', () => {
  const r = match({ received: ALL_RECEIVED });
  assert.equal(qtyCheck(r).status, 'pass');
  assert.equal(qtyCheck(r).detail, 'Nothing is invoiced beyond what was ordered and received.');
  assert.equal(qtyCheck(r).blocking, undefined);
  assert.equal(qtyPart(r).value, 1);
  assert.equal(r.score.total, 100);
  assert.equal(r.score.eligible, true);
  assert.equal(statusFromChecks(r.checks), 'under_review');
});

test('received less than invoiced: quantity_match fails as before (On Hold, approve the received quantity)', () => {
  const r = match({ received: { ...ALL_RECEIVED, [skuKey('PAP-A4-80')]: 15 } });
  const q = qtyCheck(r);
  assert.equal(q.status, 'fail');
  assert.equal(q.severity, 'hold');
  assert.equal(q.blocking, undefined);
  assert.match(q.detail, /PAP-A4-80: invoiced 20, received 15\./);
  assert.equal(statusFromChecks(r.checks.filter((c) => c.id !== 'match_score')), 'on_hold');
});

test('the switch off: the old behaviour, a pass with the "not checked" note and a full quantity score', () => {
  const r = match({ policy: { ...POLICY, requireDeliverySlip: false } });
  assert.equal(qtyCheck(r).status, 'pass');
  assert.equal(qtyCheck(r).detail, 'Within the quantities on PO-2041. No goods receipt is recorded yet, so receipt was not checked.');
  assert.equal(qtyPart(r).value, 1);
  assert.equal(r.score.total, 100);
  assert.equal(r.score.eligible, true);
  assert.equal(statusFromChecks(r.checks), 'under_review');
  // Unset means on.
  assert.equal(qtyCheck(match({ policy: { ...POLICY, requireDeliverySlip: undefined } })).status, 'unverified');
});

test('service lines expect no delivery slip; goods on the same PO still do', () => {
  const services = { ...PO, lines: PO.lines.map((l) => ({ ...l, kind: 'service' })) };
  const onlyServices = match({ po: services });
  assert.equal(qtyCheck(onlyServices).status, 'pass');
  assert.equal(qtyCheck(onlyServices).detail, 'Within the quantities on PO-2041. Services only: no delivery slip is expected.');
  assert.equal(qtyPart(onlyServices).value, 1);
  assert.ok(onlyServices.lineMatches.every((l) => l.kind === 'service' && !l.receiptUnconfirmed));

  const mixed = { ...PO, lines: PO.lines.map((l, i) => (i === 0 ? l : { ...l, kind: 'service' })) };
  assert.equal(qtyCheck(match({ po: mixed })).status, 'unverified', 'the paper is goods');
  // With a receipt that covers the goods, a service line missing from it is not "received 0".
  const r = match({ po: mixed, received: { [skuKey('PAP-A4-80')]: 20 } });
  assert.equal(qtyCheck(r).status, 'pass');
  assert.equal(r.lineMatches[1].qtyReceived, null);
});

test('PO suggestions keep their provisional score: the delivery-slip rule is not applied before a PO is linked', async () => {
  const { suggestPurchaseOrders } = await import('../src/agent/finance/matching.js');
  const [best] = suggestPurchaseOrders({ extracted: { ...extracted, poNumber: null }, vendor: HARBOUR, purchaseOrders, policy: POLICY });
  assert.equal(best.poNumber, 'PO-2041');
  // Tax is unverified at this stage (95%), exactly as before the rule: no half-scored quantity.
  assert.ok(best.explanation.includes('3 within the ordered quantity. Provisional score 95% (before checking goods received).'), best.explanation);
});

// ----- through the app: the switch is audited, and invoices follow it -----

test('through the app: no slip -> Needs Review and approval refused; the switch is audited; off -> the old behaviour', async () => {
  const t = await startApp();
  try {
    const { GoodsReceipt, AuditEvent, AgentRun, PolicySettings } = await import('../src/models/index.js');
    const { renderInvoiceText } = await import('../src/seed/data.js');
    await GoodsReceipt.deleteMany({ poNumber: 'PO-2041' }); // nothing delivered yet
    const reviewer = await t.signIn('reviewer');
    const approver = await t.signIn('approver');
    const admin = await t.signIn('admin');
    // The test app reads with the rules reader at 90% confidence: allow that, so the delivery slip is the only question left.
    const floor = await admin.put('/api/settings/policy', { confidenceFloor: 90, expectedVersion: 1, reason: 'Rules reader in tests.' });
    assert.equal(floor.status, 200, JSON.stringify(floor.data));

    const posted = await reviewer.post('/api/invoices', { text: renderInvoiceText(clean) });
    assert.equal(posted.status, 201, JSON.stringify(posted.data));
    const inv = posted.data.invoice;
    // Needs Review because of the missing slip alone: every other check passes (the ABN is only unverified, without a register lookup).
    assert.deepEqual(
      inv.checks.filter((c) => c.status === 'fail' || c.blocking).map((c) => [c.id, c.status]),
      [
        ['quantity_match', 'unverified'],
        ['match_score', 'fail'],
      ],
    );
    assert.equal(inv.match.score.total, 90, 'the quantity part counts half: 10 of 20 points');
    assert.equal(inv.status, 'needs_review');
    assert.equal(inv.match.score.eligible, false);
    const q = inv.checks.find((c) => c.id === 'quantity_match');
    assert.deepEqual([q.status, q.blocking], ['unverified', true]);
    const refused = await approver.post(`/api/invoices/${inv._id}/actions/approve`, {});
    assert.ok(refused.status >= 400, `approval refused (${refused.status})`);
    assert.match(refused.data.error, /No delivery slip \(goods receipt\) is recorded/);
    assert.equal((await AgentRun.findOne({ invoiceId: inv._id }).sort({ createdAt: -1 }).lean()).policy.requireDeliverySlip, true);

    // A switch takes true or false only; a reason is required; the change is audited.
    assert.equal((await admin.put('/api/settings/policy', { requireDeliverySlip: 'no', expectedVersion: 2, reason: 'Trial.' })).status, 400);
    assert.equal((await admin.put('/api/settings/policy', { requireDeliverySlip: false, expectedVersion: 2 })).status, 400, 'no reason');
    const saved = await admin.put('/api/settings/policy', { requireDeliverySlip: false, expectedVersion: 2, reason: 'Delivery slips arrive late this month.' });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.fields.find((f) => f.key === 'requireDeliverySlip').value, false);
    assert.equal((await PolicySettings.findById('policy').lean()).requireDeliverySlip, false);
    const entry = (await AuditEvent.find({ subjectKind: 'settings', action: 'policy_changed' }).sort({ at: 1, _id: 1 }).lean()).at(-1);
    assert.equal(entry.actor, 'Ada Admin');
    assert.equal(entry.reason, 'Delivery slips arrive late this month.');
    assert.equal(entry.detail, 'Require delivery slip for goods: on -> off');
    assert.deepEqual([entry.from, entry.to], ['v2', 'v3']);

    // Off: processed again, the old behaviour, and the run records the switch.
    const again = await reviewer.post(`/api/invoices/${inv._id}/rerun`, {});
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.invoice.status, 'under_review', JSON.stringify(again.data.invoice.checks.filter((c) => c.status !== 'pass')));
    const passed = again.data.invoice.checks.find((c) => c.id === 'quantity_match');
    assert.equal(passed.status, 'pass');
    assert.match(passed.detail, /No goods receipt is recorded yet, so receipt was not checked\./);
    assert.equal(again.data.run.policy.requireDeliverySlip, false);
    assert.equal(again.data.run.policy.version, 3);
  } finally {
    await t.stop();
  }
});
