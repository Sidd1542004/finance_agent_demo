// The facts of a query to a supplier about an invoice's variance, worked out
// by code only (no model). Built from what the agent already recorded on the
// invoice: its failed variance checks, its line matches against the purchase
// order and the goods received, and the GST it shows. The drafting model is
// given these facts and nothing else (disputeDraft.js), and every number in
// its email must be one of them.
//
// The credit asked for, before GST, per variance:
//   quantity  (qty invoiced - qty that can be paid for) x PO unit price
//             (what can be paid for: within what was ordered and received)
//   price     (invoiced unit price - PO unit price) x qty invoiced
// then GST at the policy rate on that credit. These two never overlap: together
// they are exactly what was billed minus what is owed at PO prices.
//   GST       charged - correct (10% of the subtotal). When the supplier charged
//             too little GST there is nothing to credit: a tax invoice must show
//             the right GST, so a corrected invoice is asked for instead.
//
// What is asked for is chosen here, from the variance types, with an
// alternative where one makes sense:
//   quantity  a credit note, or word that the rest is still to be delivered
//   price     a credit note, or confirmation of a revised price for our PO
//   GST       a corrected tax invoice (whatever else is wrong)
// The model may only ask for these (`requests`; `outcomeText` joins them).

import { isNum } from './rules.js';

export const VARIANCE_CHECKS = Object.freeze(['quantity_match', 'price_match', 'tax_charged']);

const r2 = (n) => Math.round(n * 100) / 100;
const r1 = (n) => Math.round(n * 10) / 10;
/** "AUD 84.70": every amount with its currency code. */
export const money = (n, currency = 'AUD') => `${currency} ${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-09-18" -> "18 Sep 2026"; anything else as it is (or null). */
export const shortDate = (iso) => {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso || null;
};

/** The variance checks that failed on an invoice. */
export const failedVariances = (invoice) => (invoice?.checks || []).filter((c) => c.status === 'fail' && VARIANCE_CHECKS.includes(c.id)).map((c) => c.id);

const describe = (l) => l.poDescription || l.description || l.sku || 'item';
const named = (l) => (l.sku && describe(l) !== l.sku ? `${describe(l)} (${l.sku})` : describe(l));
/** "2 × Standard timber pallet 1200 x 1000": a quantity of an item, as the email writes it. */
const times = (n, l) => `${n} × ${describe(l)}`;

/**
 * The dispute facts for an invoice, or null when no variance check failed.
 *   invoice   the stored invoice (checks, lineMatches, extracted, matchedPo)
 *   vendor    the supplier record (name, email) or null
 *   receipts  goods receipts for the PO ({ receivedOn }), for the delivery date
 *   gstRatePct, buyer  from the policy and config
 * `variances` is empty when a check failed but nothing can be claimed (for
 * example a price below the PO): there is then nothing to query.
 */
export function disputeFacts({ invoice, vendor = null, receipts = [], gstRatePct = 10, buyer = null }) {
  const failed = failedVariances(invoice);
  if (!failed.length) return null;
  const e = invoice.extracted || {};
  const currency = e.currency || 'AUD';
  const m = (n) => money(n, currency);
  const variances = [];

  for (const l of invoice.lineMatches || []) {
    if (!l.onPo) continue;
    if (failed.includes('quantity_match') && isNum(l.qtyInvoiced) && isNum(l.qtyPayable) && isNum(l.pricePo)) {
      const excess = r2(l.qtyInvoiced - l.qtyPayable);
      if (excess > 0) {
        const amount = r2(excess * l.pricePo);
        const before = l.qtyInvoicedBefore || 0;
        // Short on delivery, or beyond what was ordered (what was received limits first when it is lower).
        const notReceived = isNum(l.qtyReceived) && l.qtyReceived - before < (l.qtyOrdered ?? Infinity) - before;
        variances.push({
          type: 'quantity',
          check: 'quantity_match',
          reason: notReceived ? 'not_received' : 'not_ordered',
          item: named(l),
          description: describe(l),
          ordered: l.qtyOrdered ?? null,
          received: l.qtyReceived ?? null,
          alreadyInvoiced: before,
          invoiced: l.qtyInvoiced,
          invoicedText: times(l.qtyInvoiced, l),
          excess,
          excessText: times(excess, l),
          poUnitPrice: l.pricePo,
          poUnitPriceText: m(l.pricePo),
          amountExGst: amount,
          amountExGstText: m(amount),
          working: `${excess} × ${m(l.pricePo)} = ${m(amount)} ex GST`,
        });
      }
    }
    if (failed.includes('price_match') && isNum(l.qtyInvoiced) && isNum(l.priceInvoiced) && isNum(l.pricePo) && l.pricePo > 0 && l.priceInvoiced > l.pricePo && !l.priceOk) {
      const unitDifference = r2(l.priceInvoiced - l.pricePo);
      const amount = r2(unitDifference * l.qtyInvoiced);
      variances.push({
        type: 'price',
        check: 'price_match',
        item: named(l),
        description: describe(l),
        invoiced: l.qtyInvoiced,
        invoicedText: times(l.qtyInvoiced, l),
        poUnitPrice: l.pricePo,
        poUnitPriceText: m(l.pricePo),
        invoicedUnitPrice: l.priceInvoiced,
        invoicedUnitPriceText: m(l.priceInvoiced),
        unitDifference,
        unitDifferenceText: m(unitDifference),
        pctAbovePo: r1((unitDifference / l.pricePo) * 100),
        amountExGst: amount,
        amountExGstText: m(amount),
        working: `${l.qtyInvoiced} × ${m(unitDifference)} = ${m(amount)} ex GST`,
      });
    }
  }

  let tax = null;
  if (failed.includes('tax_charged')) {
    if (isNum(e.gst) && isNum(e.subtotal)) {
      const correct = Math.round(e.subtotal * gstRatePct) / 100;
      const difference = r2(e.gst - correct);
      tax = {
        type: 'gst',
        check: 'tax_charged',
        ratePct: gstRatePct,
        subtotal: e.subtotal,
        subtotalText: m(e.subtotal),
        charged: e.gst,
        chargedText: m(e.gst),
        correct,
        correctText: m(correct),
        difference: Math.abs(difference),
        differenceText: m(Math.abs(difference)),
        direction: difference > 0 ? 'overcharged' : 'undercharged',
        working: `${gstRatePct}% × ${m(e.subtotal)} = ${m(correct)}`,
      };
    } else {
      tax = { type: 'gst', check: 'tax_charged', ratePct: gstRatePct, missing: isNum(e.gst) ? 'subtotal' : 'gst' };
    }
    variances.push(tax);
  }

  // The credit: the line amounts plus GST on them, plus any GST overcharged.
  const exGst = r2(variances.filter((v) => v.type !== 'gst').reduce((s, v) => s + v.amountExGst, 0));
  const gstOnCredit = r2((exGst * gstRatePct) / 100);
  const gstOvercharged = tax?.direction === 'overcharged' ? tax.difference : 0;
  const total = r2(exGst + gstOnCredit + gstOvercharged);
  const outcome = tax || total <= 0 ? 'corrected_invoice' : 'credit_note';

  // What is asked for, in the words the email uses (the model may use only these).
  const requests = [];
  if (outcome === 'credit_note') {
    requests.push({ id: 'credit_note', text: `issue a credit note for ${m(total)}` });
    const short = variances.filter((v) => v.type === 'quantity' && v.reason === 'not_received');
    if (short.length)
      requests.push({
        id: 'remaining_delivery',
        text: `let us know if the remaining ${short.map((v) => v.excessText).join(' and ')} ${short.length === 1 && short[0].excess === 1 ? 'is' : 'are'} still to be delivered`,
      });
    if (variances.some((v) => v.type === 'price'))
      requests.push({ id: 'revised_price', text: 'if a revised price was agreed, send the confirmation so we can update our purchase order' });
  } else {
    requests.push({
      id: 'corrected_invoice',
      text:
        tax?.correct !== undefined
          ? `send a corrected tax invoice showing GST of ${m(tax.correct)}${exGst > 0 ? ', with the amounts above corrected' : ''}`
          : 'send a corrected tax invoice',
    });
  }
  const outcomeText = requests.map((r, i) => (i === 0 ? r.text : r.id === 'revised_price' ? `or, ${r.text}` : `or ${r.text}`)).join(', ');

  const latest = receipts
    .map((r) => r.receivedOn)
    .filter(Boolean)
    .sort()
    .at(-1);

  return {
    invoiceNumber: e.invoiceNumber || null,
    invoiceDate: shortDate(e.invoiceDate),
    invoiceTotal: isNum(e.total) ? e.total : null,
    invoiceTotalText: isNum(e.total) ? m(e.total) : null,
    poNumber: invoice.matchedPo || e.poNumber || null,
    deliveryDate: shortDate(latest),
    supplierName: vendor?.name || e.vendorName || null,
    supplierEmail: vendor?.email || null,
    buyer,
    currency,
    gstRatePct,
    failedChecks: failed,
    variances,
    credit: {
      exGst,
      exGstText: m(exGst),
      gst: r2(gstOnCredit + gstOvercharged),
      gstText: m(gstOnCredit + gstOvercharged),
      total,
      totalText: m(total),
      working: exGst > 0 ? `${m(exGst)} + GST ${m(gstOnCredit + gstOvercharged)} = ${m(total)}` : null,
    },
    outcome,
    requests,
    outcomeText,
  };
}
