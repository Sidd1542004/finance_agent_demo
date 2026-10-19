// Shared invoice helpers. Plain functions, no database and no AI.
//
// The AI model only READS the invoice. Everything in this file DECIDES, using
// fixed rules, so the same invoice always gets the same decision and every
// decision can be explained line by line.

export const cents = (n) => Math.round(Number(n) * 100);
export const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

export const money = (n) => (isNum(n) ? n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' }) : 'not shown');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-10-14" -> "14 Oct 2026". Anything else is returned as it was read.
export const day = (value) => {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m && MONTHS[Number(m[2]) - 1] ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(value ?? '');
};

export const normaliseAbn = (value) => String(value ?? '').replace(/\D/g, '');

export const formatAbn = (value) => {
  const d = normaliseAbn(value);
  return d.length === 11 ? `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : String(value ?? '');
};

// Australian Business Number checksum (ATO algorithm): subtract 1 from the
// first digit, multiply each digit by its weight, the sum must divide by 89.
export function isValidAbn(value) {
  const d = normaliseAbn(value);
  if (d.length !== 11) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const digits = d.split('').map(Number);
  digits[0] -= 1;
  return digits.reduce((sum, digit, i) => sum + digit * weights[i], 0) % 89 === 0;
}

export const normaliseAcn = (value) => String(value ?? '').replace(/\D/g, '');

export const formatAcn = (value) => {
  const d = normaliseAcn(value);
  return d.length === 9 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : String(value ?? '');
};

// Australian Company Number checksum (ASIC algorithm): the first 8 digits,
// weighted 8 down to 1, summed; the 9th digit is 10 minus the remainder on
// 10 (0 if that remainder is 0). Separate from the ABN, which is a different
// number and a different algorithm, even though the first 9 digits of an
// ABN are often (but not always) built from a company's ACN.
export function isValidAcn(value) {
  const d = normaliseAcn(value);
  if (d.length !== 9) return false;
  const weights = [8, 7, 6, 5, 4, 3, 2, 1];
  const digits = d.split('').map(Number);
  const sum = digits.slice(0, 8).reduce((s, digit, i) => s + digit * weights[i], 0);
  const complement = (10 - (sum % 10)) % 10;
  return complement === digits[8];
}

const nameKey = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(pty|ltd|limited|proprietary|co|company|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function namesMatch(a, b) {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// The same name once case, punctuation and legal suffixes are ignored. Strict
// enough to identify a supplier on its name alone; namesMatch, which also
// accepts one name inside the other ("Harbour" in "Harbour Office Supplies"),
// is only a similarity to warn about, never proof of who the supplier is.
export function namesEqual(a, b) {
  const x = nameKey(a);
  return Boolean(x) && x === nameKey(b);
}

// Purchase order matching moved to matching.js, invoice validation to
// validation.js, duplicates to duplicates.js. This file keeps the shared helpers.

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * "Approve the received quantity only": what the invoice comes to if each line
 * is paid for the quantity both ordered and received, at the invoiced price.
 * Items not on the purchase order are not paid. GST is recalculated if the
 * invoice charged GST. Returns null when it does not apply.
 */
export function receivedOnly(invoice, gstRatePct = 10) {
  const failed = (invoice?.checks || []).filter((c) => c.status === 'fail').map((c) => c.id);
  if (!failed.includes('quantity_match')) return null;
  const e = invoice.extracted || {};
  const lines = (invoice.lineMatches || []).map((m) => {
    // qtyPayable: the most that can be paid for (remaining on the PO, and received).
    const payQty = m.onPo ? (isNum(m.qtyPayable) ? m.qtyPayable : Math.max(0, Math.min(m.qtyInvoiced, m.qtyReceived ?? 0, m.qtyOrdered ?? 0))) : 0;
    return { sku: m.sku, description: m.description, qtyInvoiced: m.qtyInvoiced, payQty, unitPrice: m.priceInvoiced, amount: round2(payQty * m.priceInvoiced) };
  });
  if (!lines.length || lines.some((l) => !isNum(l.unitPrice) || !isNum(l.qtyInvoiced)) || !isNum(e.total)) return null;
  const subtotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  const gst = isNum(e.gst) && e.gst > 0 ? round2((subtotal * gstRatePct) / 100) : 0;
  const total = round2(subtotal + gst);
  if (cents(total) <= 0 || cents(total) >= cents(e.total)) return null;
  return { subtotal, gst, total, invoiceTotal: e.total, lines };
}
