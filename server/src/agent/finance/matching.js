// Purchase order matching and the match score.
//
// Compares an invoice with a purchase order (and the goods received against
// it, and what earlier invoices already billed against it), line by line, and
// works out a transparent score out of 100.
//
// SCORE WEIGHTS (out of 100). Each part is a fraction from 0 to 1, multiplied
// by its weight. Line-based parts are weighted by line value, so a $5,000 line
// counts more than a $5 line.
//   supplier  20  invoice supplier is the PO's supplier: 1 by ABN, 0.75 by the
//                 supplier record when the invoice has no ABN, 0.5 by name only
//   items     20  share of invoice value on lines that match a PO line
//                 (by item code, or by description words when there is no code)
//   quantity  20  share of invoice value on matched lines whose quantity is
//                 within what remains on the PO and what was received
//   price     20  share of invoice value on matched lines whose unit price is
//                 within the price tolerance of the PO price
//   amounts   10  half for the invoice's own sums adding up, half for the
//                 subtotal agreeing with the matched quantities at PO prices
//   tax       10  1 if the tax charged is correct, 0.5 if it could not be
//                 verified, 0 if it is wrong
//
// The score decides whether an invoice is ELIGIBLE FOR APPROVAL REVIEW. It never
// approves anything. Must-pass checks (duplicate, arithmetic, quantity beyond
// what was received, ...) are separate and are not averaged away by the score.

import { cents, isNum, normaliseAbn, namesMatch } from './rules.js';
import { fmtMoney } from './validation.js';

export const WEIGHTS = { supplier: 20, items: 20, quantity: 20, price: 20, amounts: 10, tax: 10 };
const LABELS = { supplier: 'Supplier', items: 'Items', quantity: 'Quantity', price: 'Unit price', amounts: 'Amounts', tax: 'Tax' };
export const DESCRIPTION_MATCH = 0.6;

const round2 = (n) => Math.round(n * 100) / 100;
export const skuKey = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const STOP = new Set(['the', 'and', 'for', 'of', 'with', 'per', 'a', 'an', 'x', 'pack', 'box', 'each', 'ea', 'unit', 'units']);
const words = (s) => new Set(String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 2 && !STOP.has(w)));

// Word overlap between two descriptions (Jaccard): 1 is identical, 0 nothing shared.
export function descriptionSimilarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

// Pair each invoice line with at most one PO line: item code first, then the
// most similar description above the threshold. Never paired on amount alone.
export function pairLines(invoiceLines, poLines) {
  const used = new Set();
  const pairs = (invoiceLines || []).map((line) => ({ line, poLine: null, how: null, similarity: 0 }));
  for (const p of pairs) {
    if (!p.line.sku) continue;
    const i = (poLines || []).findIndex((l, idx) => !used.has(idx) && skuKey(l.sku) && skuKey(l.sku) === skuKey(p.line.sku));
    if (i >= 0) {
      used.add(i);
      Object.assign(p, { poLine: poLines[i], how: 'item code', similarity: 1 });
    }
  }
  for (const p of pairs) {
    if (p.poLine) continue;
    let best = -1;
    let bestSim = 0;
    (poLines || []).forEach((l, idx) => {
      if (used.has(idx)) return;
      const sim = descriptionSimilarity(p.line.description, l.description);
      if (sim > bestSim) {
        bestSim = sim;
        best = idx;
      }
    });
    if (best >= 0 && bestSim >= DESCRIPTION_MATCH) {
      used.add(best);
      Object.assign(p, { poLine: poLines[best], how: 'description', similarity: Math.round(bestSim * 100) / 100 });
    }
  }
  return pairs;
}

const lineValue = (l) => Math.abs(isNum(l.amount) ? l.amount : isNum(l.qty) && isNum(l.unitPrice) ? l.qty * l.unitPrice : 0) || 1;

function supplierScore(extracted, vendor, po) {
  if (!po) return { value: 0, detail: 'No purchase order to compare with.' };
  if (extracted.abn && normaliseAbn(po.vendorAbn) === extracted.abn) return { value: 1, detail: `ABN matches ${po.vendorName}.` };
  if (extracted.abn) return { value: 0, detail: `The invoice ABN is not ${po.vendorName}'s ABN.` };
  if (vendor && normaliseAbn(vendor.abn) === normaliseAbn(po.vendorAbn)) return { value: 0.75, detail: `Matched to ${po.vendorName} through the supplier record (no ABN on the invoice).` };
  if (namesMatch(po.vendorName, extracted.vendorName)) return { value: 0.5, detail: `Name matches ${po.vendorName}, but there is no ABN to confirm it.` };
  return { value: 0, detail: `The invoice supplier does not match ${po.vendorName}.` };
}

/**
 * Match an invoice to a purchase order.
 *
 * @param extracted       reader output
 * @param vendor          supplier record or null
 * @param po              the purchase order, or null when none was identified
 * @param received        { SKU: qty received } or null when no goods receipt exists for the PO
 * @param invoicedBefore  { SKU: qty } already billed against this PO by earlier invoices
 * @param taxStatus       status of the tax_charged check: 'pass' | 'unverified' | 'fail'
 * @param arithmeticOk    whether the invoice's own sums add up
 */
export function matchToPo({ extracted: e, vendor, po, received = null, invoicedBefore = {}, taxStatus, arithmeticOk, policy }) {
  const cur = e.currency || 'AUD';
  const m = (n) => fmtMoney(n, cur);
  const tolPct = policy.priceTolerancePct;
  const lines = e.lines || [];
  const pairs = po ? pairLines(lines, po.lines) : lines.map((line) => ({ line, poLine: null, how: null }));

  const lineMatches = pairs.map(({ line, poLine, how, similarity }) => {
    const key = poLine ? skuKey(poLine.sku) : null;
    const before = poLine ? Number(invoicedBefore[key] || 0) : null;
    const qtyReceived = poLine && received ? Number(received[key] || 0) : null;
    const remainingOrdered = poLine ? poLine.qty - before : null;
    const remainingReceived = qtyReceived === null ? null : qtyReceived - before;
    const issues = [];
    let qtyOk = false;
    let priceOk = false;
    const name = line.sku || line.description || 'An item';
    if (poLine) {
      if (isNum(line.qty)) {
        if (remainingReceived !== null && line.qty > remainingReceived) {
          issues.push(`${name}: invoiced ${line.qty}, received ${qtyReceived}${before ? ` (${before} already invoiced)` : ''}.`);
        } else if (line.qty > remainingOrdered) {
          issues.push(`${name}: invoiced ${line.qty}, but only ${Math.max(0, remainingOrdered)} remain on ${po.poNumber} (ordered ${poLine.qty}${before ? `, ${before} already invoiced` : ''}).`);
        } else qtyOk = true;
      } else issues.push(`${name}: the invoice shows no quantity.`);
      if (isNum(line.unitPrice) && isNum(poLine.unitPrice) && poLine.unitPrice > 0) {
        const diffPct = ((line.unitPrice - poLine.unitPrice) / poLine.unitPrice) * 100;
        if (Math.abs(diffPct) > tolPct + 1e-9) issues.push(`${name}: invoiced at ${m(line.unitPrice)} each, the PO says ${m(poLine.unitPrice)} (${diffPct > 0 ? '+' : ''}${diffPct.toFixed(1)}%).`);
        else priceOk = true;
      }
    } else if (po) {
      issues.push(`${name} is not on ${po.poNumber}.`);
    }
    const payable = poLine && isNum(line.qty) ? Math.max(0, Math.min(line.qty, remainingOrdered, remainingReceived ?? Infinity)) : 0;
    return {
      sku: line.sku ?? poLine?.sku ?? null,
      description: line.description ?? poLine?.description ?? null,
      poDescription: poLine?.description ?? null,
      matchedBy: how,
      similarity: similarity ?? null,
      qtyInvoiced: line.qty,
      qtyOrdered: poLine ? poLine.qty : null,
      qtyReceived,
      qtyInvoicedBefore: before,
      qtyRemaining: poLine ? remainingOrdered : null,
      qtyPayable: payable,
      priceInvoiced: line.unitPrice,
      pricePo: poLine ? poLine.unitPrice : null,
      amount: line.amount,
      onPo: Boolean(poLine),
      qtyOk,
      priceOk,
      issues,
      _value: lineValue(line),
    };
  });

  // ----- score -----
  const totalValue = lineMatches.reduce((s, l) => s + l._value, 0) || 1;
  const share = (pred) => lineMatches.filter(pred).reduce((s, l) => s + l._value, 0) / totalValue;
  const sup = supplierScore(e, vendor, po);
  const atPoPrices = lineMatches.filter((l) => l.onPo && isNum(l.qtyInvoiced)).reduce((s, l) => s + l.qtyInvoiced * l.pricePo, 0);
  const subtotalAgrees = po && isNum(e.subtotal) && lineMatches.every((l) => l.onPo) && Math.abs(atPoPrices - e.subtotal) <= Math.max(policy.roundingTolerance, (atPoPrices * tolPct) / 100);
  const parts = {
    supplier: { value: sup.value, detail: sup.detail },
    items: { value: po ? share((l) => l.onPo) : 0, detail: po ? `${lineMatches.filter((l) => l.onPo).length} of ${lineMatches.length} invoice line(s) are on ${po.poNumber}.` : 'No purchase order to compare with.' },
    quantity: { value: po ? share((l) => l.onPo && l.qtyOk) : 0, detail: po ? `${lineMatches.filter((l) => l.qtyOk).length} of ${lineMatches.length} line(s) are within what was ordered and received.` : 'No purchase order to compare with.' },
    price: { value: po ? share((l) => l.onPo && l.priceOk) : 0, detail: po ? `${lineMatches.filter((l) => l.priceOk).length} of ${lineMatches.length} line(s) are within ${tolPct}% of the PO price.` : 'No purchase order to compare with.' },
    amounts: {
      value: (arithmeticOk ? 0.5 : 0) + (subtotalAgrees ? 0.5 : 0),
      detail: `${arithmeticOk ? 'The invoice sums add up' : "The invoice sums don't add up"}; ${po ? (subtotalAgrees ? `the subtotal agrees with the PO prices (${m(atPoPrices)})` : `at PO prices the lines come to ${m(atPoPrices)}, against a subtotal of ${m(e.subtotal)}`) : 'no PO to compare the subtotal with'}.`,
    },
    tax: { value: taxStatus === 'pass' ? 1 : taxStatus === 'unverified' ? 0.5 : 0, detail: taxStatus === 'pass' ? 'Tax charged is correct.' : taxStatus === 'unverified' ? 'Tax could not be fully verified.' : 'Tax charged is wrong or missing.' },
  };
  const components = Object.entries(WEIGHTS).map(([id, weight]) => ({
    id,
    label: LABELS[id],
    weight,
    value: Math.round(parts[id].value * 100) / 100,
    points: round2(parts[id].value * weight),
    detail: parts[id].detail,
  }));
  const total = Math.round(components.reduce((s, c) => s + c.points, 0));
  const threshold = policy.matchThreshold;

  // ----- checks -----
  const checks = [];
  const add = (id, label, status, detail, severity) => checks.push({ id, label, status, detail, severity });
  const priceIssues = lineMatches.flatMap((l) => l.issues.filter((i) => /each, the PO says|is not on /.test(i)));
  const qtyIssues = lineMatches.flatMap((l) => l.issues.filter((i) => /invoiced \d|no quantity|only .* remain/.test(i)));
  if (po) {
    const supplierOk = sup.value >= 0.75 || (sup.value === 0.5 && !e.abn);
    add(
      'po_found',
      'Purchase order identified',
      supplierOk ? 'pass' : 'fail',
      supplierOk ? `${po.poNumber} was raised with ${po.vendorName}.` : `${po.poNumber} was raised with ${po.vendorName}, not with this supplier.`,
      'review',
    );
    add('price_match', 'Items and prices match the purchase order', priceIssues.length ? 'fail' : 'pass', priceIssues.length ? priceIssues.join(' ') : `Every item is on ${po.poNumber} at the agreed price (within ${tolPct}%).`, 'hold');
    add(
      'quantity_match',
      'Quantities match what was ordered and received',
      qtyIssues.length ? 'fail' : 'pass',
      qtyIssues.length ? qtyIssues.join(' ') : received === null ? `Within the quantities on ${po.poNumber}. No goods receipt is recorded yet, so receipt was not checked.` : 'Nothing is invoiced beyond what was ordered and received.',
      'hold',
    );
  } else {
    add('po_found', 'Purchase order identified', 'fail', e.poNumber ? `Purchase order ${e.poNumber} does not exist.` : 'The invoice does not quote a purchase order number.', 'review');
    add('price_match', 'Items and prices match the purchase order', 'skip', 'Not checked because no purchase order was identified.', 'hold');
    add('quantity_match', 'Quantities match what was ordered and received', 'skip', 'Not checked because no purchase order was identified.', 'hold');
  }
  add('match_score', `Match score at least ${threshold}%`, total >= threshold ? 'pass' : 'fail', `Match score ${total}% (threshold ${threshold}%).${total >= threshold ? ' Eligible for approval review, not approved.' : ''}`, 'hold');

  // ----- comparison table: Field | Invoice | PO | Difference | Result -----
  const rows = [];
  const row = (field, invoice, poValue, difference, result) => rows.push({ field, invoice, po: poValue, difference, result });
  row('Supplier', [e.vendorName, e.abn ? `ABN ${e.abn}` : e.gstin ? `GSTIN ${e.gstin}` : 'no ABN'].filter(Boolean).join(', '), po ? `${po.vendorName}, ABN ${po.vendorAbn}` : '—', '', po ? (sup.value >= 0.75 ? 'match' : sup.value > 0 ? 'check' : 'mismatch') : 'missing');
  row('PO number', e.poNumber || 'not quoted', po?.poNumber || '—', '', po ? (e.poNumber && skuKey(e.poNumber) === skuKey(po.poNumber) ? 'match' : e.poNumber ? 'mismatch' : 'linked') : 'missing');
  for (const l of lineMatches) {
    const name = l.description || l.sku || 'Item';
    row(`Item: ${name}`, [l.sku, l.description].filter(Boolean).join(' '), l.onPo ? [l.sku, l.poDescription].filter(Boolean).join(' ') : 'not on PO', l.matchedBy ? `matched by ${l.matchedBy}` : '', l.onPo ? 'match' : po ? 'mismatch' : 'missing');
    if (!l.onPo) continue;
    const rem = [`ordered ${l.qtyOrdered}`, l.qtyReceived !== null ? `received ${l.qtyReceived}` : 'no receipt', l.qtyInvoicedBefore ? `already invoiced ${l.qtyInvoicedBefore}` : null].filter(Boolean).join(', ');
    row(`Quantity: ${name}`, String(l.qtyInvoiced ?? '—'), rem, isNum(l.qtyInvoiced) ? `${l.qtyInvoiced - l.qtyPayable > 0 ? '+' : ''}${round2(l.qtyInvoiced - l.qtyPayable)} beyond what can be paid` : '', l.qtyOk ? 'match' : 'mismatch');
    row(`Unit price: ${name}`, m(l.priceInvoiced), m(l.pricePo), isNum(l.priceInvoiced) && isNum(l.pricePo) ? m(round2(l.priceInvoiced - l.pricePo)) : '', l.priceOk ? 'match' : 'mismatch');
    const expectLine = isNum(l.qtyInvoiced) ? round2(l.qtyInvoiced * l.pricePo) : null;
    row(`Line total: ${name}`, m(l.amount), m(expectLine), isNum(l.amount) && isNum(expectLine) ? m(round2(l.amount - expectLine)) : '', isNum(l.amount) && isNum(expectLine) && cents(l.amount) === cents(expectLine) ? 'match' : 'mismatch');
  }
  if (po) {
    row('Subtotal', m(e.subtotal), m(round2(atPoPrices)), isNum(e.subtotal) ? m(round2(e.subtotal - atPoPrices)) : '', subtotalAgrees ? 'match' : 'mismatch');
    const poValue = po.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const before = po.lines.reduce((s, l) => s + Number(invoicedBefore[skuKey(l.sku)] || 0) * l.unitPrice, 0);
    row('PO value remaining', m(round2(atPoPrices)), `${m(round2(poValue - before))} of ${m(round2(poValue))}`, m(round2(poValue - before - atPoPrices)), poValue - before - atPoPrices >= -policy.roundingTolerance ? 'match' : 'mismatch');
  }
  row('Tax', m(e.gst), '—', '', taxStatus === 'pass' ? 'match' : taxStatus === 'unverified' ? 'check' : 'mismatch');
  row('Total', m(e.total), '—', '', arithmeticOk ? 'match' : 'mismatch');

  return {
    lineMatches: lineMatches.map(({ _value, ...rest }) => rest),
    score: { total, threshold, eligible: total >= threshold, components },
    checks,
    comparison: rows,
    po: po ? { poNumber: po.poNumber, vendorName: po.vendorName, vendorAbn: po.vendorAbn } : null,
  };
}

/**
 * When the invoice quotes no PO (or a PO that does not exist), suggest likely
 * POs. Only POs that share at least one item are suggested, never on amount
 * alone. A person must confirm a suggestion; nothing is linked automatically.
 */
export function suggestPurchaseOrders({ extracted: e, vendor, purchaseOrders, policy, limit = 3 }) {
  const pool = vendor ? purchaseOrders.filter((p) => normaliseAbn(p.vendorAbn) === normaliseAbn(vendor.abn)) : purchaseOrders;
  const out = [];
  for (const po of pool) {
    const r = matchToPo({ extracted: e, vendor, po, received: null, invoicedBefore: {}, taxStatus: 'unverified', arithmeticOk: true, policy });
    const items = r.score.components.find((c) => c.id === 'items');
    if (items.value === 0) continue;
    if (r.score.total < 50) continue;
    const matched = r.lineMatches.filter((l) => l.onPo);
    const how = [...new Set(matched.map((l) => l.matchedBy))].join(' and ');
    out.push({
      poNumber: po.poNumber,
      vendorName: po.vendorName,
      score: r.score.total,
      explanation: `${matched.length} of ${r.lineMatches.length} invoice line(s) match ${po.poNumber} by ${how}; ${r.lineMatches.filter((l) => l.priceOk).length} at the PO price; ${r.lineMatches.filter((l) => l.qtyOk).length} within the ordered quantity. Provisional score ${r.score.total}% (before checking goods received).`,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
