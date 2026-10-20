// The fixed rules on their own: validation, PO matching, the match score and
// duplicates. No agent, no database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidAbn, formatAbn, isValidAcn, formatAcn, namesMatch } from '../src/agent/finance/rules.js';
import { validateInvoice, identifyVendor } from '../src/agent/finance/validation.js';
import { matchToPo, suggestPurchaseOrders, WEIGHTS } from '../src/agent/finance/matching.js';
import { duplicateCheck } from '../src/agent/finance/duplicates.js';
import { statusFromChecks } from '../src/agent/finance/lifecycle.js';
import { vendors, purchaseOrders } from '../src/seed/data.js';

const policy = { matchThreshold: 85, missingAbn: 'review', priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };

test('ABN checksum', () => {
  assert.equal(isValidAbn('51 824 753 556'), true, 'the ATO worked example');
  assert.equal(isValidAbn('51824753556'), true);
  assert.equal(isValidAbn('51 824 753 557'), false, 'one digit changed');
  assert.equal(isValidAbn('11 111 111 111'), false);
  assert.equal(isValidAbn('1234'), false);
  assert.equal(isValidAbn(null), false);
  for (const v of vendors) assert.equal(isValidAbn(v.abn), true, `${v.name} sample ABN`);
  assert.equal(formatAbn('51824753556'), '51 824 753 556');
});

test('4. ABN checksum: an invalid ABN fails even though it is 11 digits', () => {
  assert.equal(isValidAbn('57 600 410 276'), false, 'one digit changed from a real, valid ABN');
  assert.equal(isValidAbn('57600410275'), true, 'the unmodified ABN it was changed from');
});

test('ACN checksum', () => {
  assert.equal(isValidAcn('004 085 616'), true, 'a published ASIC worked example');
  assert.equal(isValidAcn('004085616'), true);
  assert.equal(isValidAcn('004 085 617'), false, 'one digit changed');
  assert.equal(isValidAcn('1234'), false, 'wrong length');
  assert.equal(isValidAcn(null), false);
  assert.equal(formatAcn('004085616'), '004 085 616');
});

test('supplier names match despite Pty Ltd, case and punctuation', () => {
  assert.equal(namesMatch('Harbour Office Supplies Pty Ltd', 'HARBOUR OFFICE SUPPLIES'), true);
  assert.equal(namesMatch('Coastal Print & Sign Pty Ltd', 'Coastal Print and Sign'), true);
  assert.equal(namesMatch('Harbour Office Supplies Pty Ltd', 'Bluegum IT Services'), false);
  assert.equal(namesMatch('Harbour Office Supplies', ''), false);
});

// A correct invoice against PO-2041; each test below breaks one thing.
const base = () => ({
  extracted: {
    vendorName: 'Harbour Office Supplies Pty Ltd',
    abn: '57600410275',
    invoiceNumber: 'HOS-1',
    invoiceDate: '2026-09-14',
    dueDate: '2026-10-14',
    poNumber: 'PO-2041',
    currency: 'AUD',
    lines: [
      { sku: 'PAP-A4-80', description: 'A4 copy paper 80gsm, carton', qty: 20, unitPrice: 42, amount: 840 },
      { sku: 'TON-HP-58A', description: 'Toner cartridge HP 58A', qty: 5, unitPrice: 79, amount: 395 },
    ],
    subtotal: 1235,
    gst: 123.5,
    total: 1358.5,
  },
  extraction: { method: 'rules', confidence: 0.9, notes: null },
  vendors: [vendors[0]],
  po: purchaseOrders[0],
  received: { PAPA480: 20, TONHP58A: 5, PENBLK50: 4 },
  invoicedBefore: {},
  duplicates: [],
  policy,
});

// The same steps the agent's "decide" stage takes.
function runChecks(input) {
  const e = input.extracted;
  const { vendor, by } = identifyVendor(e, input.vendors);
  const v = validateInvoice({ extracted: e, extraction: input.extraction, text: input.text || '', vendor, vendorBy: by, abr: input.abr || null, policy: input.policy });
  const m = matchToPo({
    extracted: e,
    vendor,
    po: input.po,
    received: input.received,
    invoicedBefore: input.invoicedBefore,
    taxStatus: v.checks.find((c) => c.id === 'tax_charged')?.status || 'unverified',
    arithmeticOk: v.checks.find((c) => c.id === 'arithmetic')?.status === 'pass',
    policy: input.policy,
  });
  const dup = duplicateCheck(input.duplicates, input.cleared || null);
  const checks = [...v.checks, dup, ...m.checks];
  return { checks, lineMatches: m.lineMatches, score: m.score, comparison: m.comparison, validation: v, status: statusFromChecks(checks) };
}
const failedIds = (input) =>
  runChecks(input)
    .checks.filter((c) => c.status === 'fail')
    .map((c) => c.id);

test('a correct invoice passes every check, scores 100% and is only eligible for review', () => {
  const r = runChecks(base());
  assert.deepEqual(
    r.checks.filter((c) => c.status === 'fail'),
    [],
  );
  assert.equal(r.score.total, 100);
  assert.equal(r.score.eligible, true);
  assert.equal(r.status, 'under_review', 'eligible for approval review, not approved');
  // No ABR configured: the ABN is well formed, but not verified with the register.
  assert.equal(r.checks.find((c) => c.id === 'supplier_tax_id').status, 'unverified');
});

test('the score weights add up to 100 and every component is explained', () => {
  assert.equal(
    Object.values(WEIGHTS).reduce((s, w) => s + w, 0),
    100,
  );
  const { score } = runChecks(base());
  assert.deepEqual(
    score.components.map((c) => c.id),
    ['supplier', 'items', 'quantity', 'price', 'amounts', 'tax'],
  );
  for (const c of score.components) assert.ok(c.detail, c.id);
});

test('invoiced more than received', () => {
  const input = base();
  input.received.PAPA480 = 18;
  const { checks, lineMatches, status } = runChecks(input);
  assert.deepEqual(
    checks.filter((c) => c.status === 'fail').map((c) => c.id),
    ['quantity_match'],
  );
  assert.match(checks.find((c) => c.id === 'quantity_match').detail, /invoiced 20, received 18/);
  assert.equal(lineMatches[0].qtyPayable, 18);
  assert.equal(status, 'on_hold');
});

test('invoiced more than ordered, even if it was all delivered', () => {
  const input = base();
  input.extracted.lines[1] = { ...input.extracted.lines[1], qty: 6, amount: 474 };
  input.extracted.subtotal = 1314;
  input.extracted.gst = 131.4;
  input.extracted.total = 1445.4;
  input.received.TONHP58A = 6;
  assert.deepEqual(failedIds(input), ['quantity_match']);
});

test('quantity beyond what is left on the PO after earlier invoices', () => {
  const input = base();
  input.invoicedBefore = { PAPA480: 15 };
  const { checks, lineMatches } = runChecks(input);
  assert.deepEqual(
    checks.filter((c) => c.status === 'fail').map((c) => c.id),
    ['quantity_match'],
  );
  assert.equal(lineMatches[0].qtyRemaining, 5);
  assert.equal(lineMatches[0].qtyPayable, 5);
  assert.match(checks.find((c) => c.id === 'quantity_match').detail, /15 already invoiced/);
});

test('price tolerance: 2% passes, just over fails, in either direction', () => {
  const priced = (unitPrice) => {
    const input = base();
    input.extracted.lines = [{ sku: 'PAP-A4-80', description: 'x', qty: 10, unitPrice, amount: Math.round(unitPrice * 1000) / 100 }];
    input.extracted.subtotal = input.extracted.lines[0].amount;
    input.extracted.gst = Math.round(input.extracted.subtotal * 10) / 100;
    input.extracted.total = Math.round((input.extracted.subtotal + input.extracted.gst) * 100) / 100;
    return failedIds(input).filter((id) => id !== 'match_score');
  };
  assert.deepEqual(priced(42.84), [], 'exactly +2%');
  assert.deepEqual(priced(42.9), ['price_match'], '+2.1%');
  assert.deepEqual(priced(41.0), ['price_match'], '-2.4%');
});

test('an item that is not on the purchase order', () => {
  const input = base();
  input.extracted.lines[1] = { sku: 'XYZ-999', description: 'Mystery item', qty: 5, unitPrice: 79, amount: 395 };
  const ids = failedIds(input);
  assert.ok(ids.includes('price_match'));
  assert.ok(!ids.includes('quantity_match'), 'an item off the PO is a price/item problem, not a quantity one');
});

test('lines match by description when the invoice has no item codes', () => {
  const input = base();
  input.extracted.lines = input.extracted.lines.map((l) => ({ ...l, sku: null }));
  const r = runChecks(input);
  assert.deepEqual(
    r.checks.filter((c) => c.status === 'fail'),
    [],
  );
  assert.ok(r.lineMatches.every((l) => l.matchedBy === 'description'));
});

test('GST wrong, and sums that do not add up', () => {
  const gst = base();
  gst.extracted.gst = 100;
  gst.extracted.total = 1335;
  assert.deepEqual(failedIds(gst), ['tax_charged']);
  assert.equal(runChecks(gst).status, 'on_hold');

  const sums = base();
  sums.extracted.total = 1400;
  assert.ok(failedIds(sums).includes('arithmetic'));
  assert.equal(runChecks(sums).status, 'needs_review');

  const line = base();
  line.extracted.lines[0].amount = 850;
  assert.ok(failedIds(line).includes('arithmetic'));
});

test('supplier not registered for GST must not charge it', () => {
  const input = base();
  input.vendors = [{ ...vendors[0], gstRegistered: false }];
  assert.ok(failedIds(input).includes('gst_registration'));
  input.extracted.gst = 0;
  input.extracted.total = 1235;
  assert.ok(!failedIds(input).includes('gst_registration'));
});

test('supplier problems', () => {
  const unknown = base();
  unknown.vendors = [];
  assert.ok(failedIds(unknown).includes('supplier_known'));

  const wrongName = base();
  wrongName.extracted.vendorName = 'Harbor Offce Suplies Trading';
  assert.ok(failedIds(wrongName).includes('supplier_known'), 'right ABN, different name');

  const badAbn = base();
  badAbn.extracted.abn = '57600410276';
  const ids = failedIds(badAbn);
  assert.ok(ids.includes('supplier_tax_id'), 'checksum fails');
  assert.equal(runChecks(badAbn).checks.find((c) => c.id === 'supplier_tax_id').severity, 'review');
});

test('6. a supplier name with punctuation and legal-suffix differences still matches, when there is no ABN to go by', () => {
  const { vendor, by } = identifyVendor({ vendorName: 'HARBOUR OFFICE SUPPLIES, Pty. Ltd.', abn: null }, vendors);
  assert.equal(vendor?.name, 'Harbour Office Supplies Pty Ltd');
  assert.equal(by, 'name');
});

// Regression: with no ABN, a merely similar name used to be accepted as the
// approved supplier ("Harbour Pty Ltd" was matched to Harbour Office Supplies).
test('6b. a similar but different supplier name, with no ABN, is flagged for a person, never matched', () => {
  for (const name of ['Harbour Pty Ltd', 'Harbour Office Supplies North Pty Ltd']) {
    const extracted = { ...base().extracted, vendorName: name, abn: null };
    const { vendor, by, conflict } = identifyVendor(extracted, vendors);
    assert.equal(vendor, null, name);
    assert.equal(by, null, name);
    assert.equal(conflict?.name, 'Harbour Office Supplies Pty Ltd', name);
    const known = validateInvoice({ extracted, extraction: base().extraction, text: '', vendor, vendorBy: by, vendorConflict: conflict, abr: null, policy }).checks.find(
      (c) => c.id === 'supplier_known',
    );
    assert.equal(known.status, 'fail', name);
    assert.match(known.detail, /similar to the approved supplier Harbour Office Supplies Pty Ltd, but it is not the same name/, name);
    assert.doesNotMatch(known.detail, /ABN on the invoice/, 'no ABN was printed, so none is quoted');

    // Quoting Harbour's PO does not make it Harbour's invoice either.
    const r = matchToPo({ extracted, vendor: null, po: purchaseOrders[0], received: null, invoicedBefore: {}, taxStatus: 'pass', arithmeticOk: true, policy });
    assert.equal(r.checks.find((c) => c.id === 'po_found').status, 'fail', name);
  }
});

// Regression: with no subtotal and no line items there was nothing to compare,
// yet the check passed as "Line amounts, subtotal, tax and total are consistent."
test('arithmetic is never "consistent" when the subtotal, line items or tax are missing: it is unable to verify, and says why', () => {
  const arithmetic = (patch) => {
    const input = base();
    Object.assign(input.extracted, patch);
    return runChecks(input).checks.find((c) => c.id === 'arithmetic');
  };
  assert.equal(arithmetic({}).status, 'pass', 'a complete invoice still passes');

  const none = arithmetic({ subtotal: null, lines: [] });
  assert.equal(none.status, 'unverified');
  assert.match(none.detail, /^Unable to verify the amounts: the invoice as read shows no line items and subtotal\./);
  assert.doesNotMatch(none.detail, /consistent/);

  assert.match(arithmetic({ subtotal: null }).detail, /shows no subtotal\./, 'lines + tax = total is checked, but the subtotal is still missing');
  assert.match(arithmetic({ lines: [] }).detail, /shows no line items\./);
  assert.match(arithmetic({ gst: null }).detail, /shows no tax amount\./);
  assert.equal(arithmetic({ gst: null, total: 1235 }).status, 'pass', 'no tax figure is fine when the total equals the subtotal');

  const wrong = arithmetic({ subtotal: null, total: 9999 });
  assert.equal(wrong.status, 'fail', 'a sum that disagrees is still a failure, not merely unverified');

  // The match score does not give the "sums add up" half-mark for an unverified result.
  const r = matchToPo({
    extracted: { ...base().extracted, subtotal: null },
    vendor: vendors[0],
    po: purchaseOrders[0],
    received: null,
    invoicedBefore: {},
    taxStatus: 'pass',
    arithmeticOk: false,
    arithmeticStatus: 'unverified',
    policy,
  });
  assert.match(r.score.components.find((c) => c.id === 'amounts').detail, /could not be fully checked/);
  assert.equal(r.comparison.find((row) => row.field === 'Total').result, 'check');
});

test('PO suggestions say they are not confirmed, and whether the supplier is known to own the PO', () => {
  const lines = [{ sku: null, description: 'Standard timber pallet 1200 x 1000', qty: 20, unitPrice: 38.5, amount: 770 }];
  const e = { vendorName: 'Australia org', abn: null, poNumber: null, lines, subtotal: 770, gst: 77, total: 847 };

  const [unknown] = suggestPurchaseOrders({ extracted: e, vendor: null, vendorBy: null, purchaseOrders, policy });
  assert.equal(unknown.poNumber, 'PO-2045');
  assert.deepEqual([unknown.status, unknown.confirmed, unknown.supplierOwnership], ['suggested', false, 'unverified']);
  assert.match(unknown.explanation, /^Suggested, not a confirmed match\./);
  assert.match(unknown.explanation, /never on the amount alone/);
  assert.match(unknown.explanation, /raised with Southern Cross Pallets Pty Ltd, but "Australia org" is not an approved supplier.*Verify supplier ownership before linking/);

  const pallets = vendors.find((v) => v.name.startsWith('Southern Cross'));
  const [byAbn] = suggestPurchaseOrders({ extracted: { ...e, vendorName: pallets.name, abn: pallets.abn }, vendor: pallets, vendorBy: 'abn', purchaseOrders, policy });
  assert.equal(byAbn.supplierOwnership, 'confirmed_by_abn');
  assert.equal(byAbn.confirmed, false, 'still only a suggestion');
  const [byName] = suggestPurchaseOrders({ extracted: { ...e, vendorName: pallets.name }, vendor: pallets, vendorBy: 'name', purchaseOrders, policy });
  assert.equal(byName.supplierOwnership, 'name_only');
  assert.match(byName.explanation, /by name only/);

  // Same amount as PO-2045, nothing in common: no suggestion at all.
  const amountOnly = { ...e, lines: [{ sku: null, description: 'Normal pipe', qty: 7, unitPrice: 110, amount: 770 }] };
  assert.deepEqual(suggestPurchaseOrders({ extracted: amountOnly, vendor: null, purchaseOrders, policy }), []);
});

test('7. a supplier name and ABN that conflict are never resolved by guessing: a person must decide', () => {
  // The name matches an approved supplier, but the ABN printed on the
  // invoice does not belong to anyone on the approved list.
  const input = base();
  input.extracted.vendorName = 'Southern Cross Pallets Pty Ltd';
  input.extracted.abn = '11111111112'; // not Southern Cross Pallets' real ABN, and not checksum-valid either, but that is a separate check
  input.vendors = vendors;
  const { vendor, by, conflict } = identifyVendor(input.extracted, input.vendors);
  assert.equal(vendor, null, 'never silently matched by name when the ABN disagrees');
  assert.equal(by, null);
  assert.equal(conflict?.name, 'Southern Cross Pallets Pty Ltd');

  const v = validateInvoice({ extracted: input.extracted, extraction: input.extraction, text: '', vendor, vendorBy: by, vendorConflict: conflict, abr: null, policy });
  const known = v.checks.find((c) => c.id === 'supplier_known');
  assert.equal(known.status, 'fail');
  assert.match(known.detail, /do not agree/);
  assert.match(known.detail, /Southern Cross Pallets/);
});

test('PO from another supplier is a supplier mismatch, and the score drops', () => {
  const input = base();
  input.po = purchaseOrders[1];
  input.received = null;
  const r = runChecks(input);
  assert.equal(r.checks.find((c) => c.id === 'po_found').status, 'fail');
  assert.match(r.checks.find((c) => c.id === 'po_found').detail, /not with this supplier/);
  assert.ok(r.score.total < 85);
  assert.equal(r.comparison.find((row) => row.field === 'Supplier').result, 'mismatch');
});

test('no purchase order: line checks are skipped and the score is low', () => {
  const none = base();
  none.extracted.poNumber = null;
  none.po = null;
  const { checks, score } = runChecks(none);
  assert.deepEqual(
    checks.filter((c) => c.status === 'fail').map((c) => c.id),
    ['po_found', 'match_score'],
  );
  assert.deepEqual(
    checks.filter((c) => c.status === 'skip').map((c) => c.id),
    ['price_match', 'quantity_match'],
  );
  assert.ok(score.total < 85);
});

test('duplicate, low confidence and missing fields', () => {
  const dup = base();
  dup.duplicates = [{ id: 'x', invoiceNumber: 'HOS-1', total: 1358.5, status: 'approved', createdAt: new Date('2026-09-20'), signals: ['same supplier and invoice number'] }];
  assert.deepEqual(failedIds(dup), ['duplicate']);
  assert.equal(runChecks(dup).status, 'needs_review');

  const rejectedCopy = base();
  rejectedCopy.duplicates = [{ ...dup.duplicates[0], status: 'rejected' }];
  assert.deepEqual(failedIds(rejectedCopy), [], 'a rejected earlier copy is not a live duplicate');

  const unsure = base();
  unsure.extraction = { method: 'groq', confidence: 0.5, notes: 'Total was hard to read.' };
  assert.deepEqual(failedIds(unsure), ['reader_confidence']);

  const empty = base();
  empty.extracted = { vendorName: null, abn: null, invoiceNumber: null, invoiceDate: null, dueDate: null, poNumber: null, lines: [], subtotal: null, gst: null, total: null };
  empty.po = null;
  const ids = failedIds(empty);
  for (const id of ['required_fields', 'arithmetic', 'jurisdiction', 'supplier_known', 'po_found', 'match_score']) assert.ok(ids.includes(id), id);
  assert.equal(runChecks(empty).status, 'needs_review', 'missing information is reviewed, never rejected');
});

test('the threshold is configurable: the same invoice can fall either side of it', () => {
  const input = base();
  input.received.PAPA480 = 18; // scores below 100
  const at = runChecks(input).score.total;
  input.policy = { ...policy, matchThreshold: at };
  assert.equal(runChecks(input).checks.find((c) => c.id === 'match_score').status, 'pass');
  input.policy = { ...policy, matchThreshold: at + 1 };
  assert.equal(runChecks(input).checks.find((c) => c.id === 'match_score').status, 'fail');
});
