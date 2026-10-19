// Duplicate invoice detection.
//
// An invoice gets fingerprints when it is read. An earlier invoice that shares
// a fingerprint is a possible duplicate:
//   numberKey   same supplier (ABN, GSTIN or name) and same invoice number
//               (ignoring punctuation, case and leading zeros)
//   amountKey   same supplier, same total and same invoice date
//   loose       same invoice number and same total, supplier unknown or different
//   contentHash the same document text, even if it was read differently
// A suspected duplicate cannot be approved or paid until a person clears it.

import { businessTimeZone } from './timeZone.js';
import crypto from 'node:crypto';
import { isNum } from './rules.js';

const alnum = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const invoiceKey = (n) => alnum(n).replace(/^0+(?=\d)/, '').replace(/([A-Z])0+(?=\d)/g, '$1');
const nameKey = (s) => alnum(String(s ?? '').replace(/\b(pty|ltd|limited|co|company|the)\b/gi, ''));

export function supplierKey(e) {
  if (e.abn) return `ABN:${e.abn}`;
  if (e.gstin) return `GSTIN:${String(e.gstin).toUpperCase()}`;
  const n = nameKey(e.vendorName);
  return n ? `NAME:${n}` : null;
}

export function fingerprints(e, rawText) {
  const sup = supplierKey(e);
  const num = e.invoiceNumber ? invoiceKey(e.invoiceNumber) : null;
  const total = isNum(e.total) ? e.total.toFixed(2) : null;
  const text = String(rawText ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return {
    numberKey: sup && num ? `${sup}|${num}` : null,
    amountKey: sup && total && e.invoiceDate ? `${sup}|${total}|${e.invoiceDate}` : null,
    looseKey: num && total ? `${num}|${total}` : null,
    contentHash: text ? crypto.createHash('sha256').update(text).digest('hex') : null,
  };
}

const SIGNAL = {
  numberKey: 'same supplier and invoice number',
  amountKey: 'same supplier, total and invoice date',
  looseKey: 'same invoice number and total',
  contentHash: 'identical document',
};

// Which fingerprints do two invoices share?
export function sharedSignals(a, b) {
  return Object.keys(SIGNAL).filter((k) => a?.[k] && b?.[k] && a[k] === b[k]).map((k) => SIGNAL[k]);
}

const INACTIVE = ['rejected', 'cancelled', 'failed'];

/**
 * @param candidates earlier invoices sharing a fingerprint:
 *                   [{ id, invoiceNumber, total, status, createdAt, signals }]
 * @param cleared    { decidedBy, note } when a person has said this is not a duplicate
 */
export function duplicateCheck(candidates, cleared, fmt = (n) => String(n)) {
  const live = candidates.filter((c) => !INACTIVE.includes(c.status));
  const gone = candidates.filter((c) => INACTIVE.includes(c.status));
  const describe = (c) => `invoice ${c.invoiceNumber || '(no number)'} for ${fmt(c.total)} received ${new Date(c.createdAt).toLocaleDateString('en-AU', { timeZone: businessTimeZone() })} (${c.signals.join(', ')}; now ${String(c.status).replace(/_/g, ' ')})`;
  if (!live.length) {
    return {
      id: 'duplicate',
      label: 'Not a duplicate',
      status: 'pass',
      severity: 'review',
      detail: gone.length ? `No live duplicate. An earlier copy was ${gone[0].status}: ${describe(gone[0])}.` : 'No earlier invoice matches this one.',
      candidates: candidates.map(({ id, invoiceNumber, status, signals }) => ({ id, invoiceNumber, status, signals })),
    };
  }
  if (cleared) {
    return {
      id: 'duplicate',
      label: 'Not a duplicate',
      status: 'pass',
      severity: 'review',
      detail: `Possible duplicate of ${describe(live[0])}, cleared by ${cleared.decidedBy}: ${cleared.note}`,
      candidates: live.map(({ id, invoiceNumber, status, signals }) => ({ id, invoiceNumber, status, signals })),
    };
  }
  return {
    id: 'duplicate',
    label: 'Not a duplicate',
    status: 'fail',
    severity: 'review',
    detail: `Possible duplicate of ${describe(live[0])}${live.length > 1 ? ` and ${live.length - 1} more` : ''}. It cannot be approved or paid until a person confirms it is not a duplicate.`,
    candidates: live.map(({ id, invoiceNumber, status, signals }) => ({ id, invoiceNumber, status, signals })),
  };
}
