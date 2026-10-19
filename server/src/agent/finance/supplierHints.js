// What the agent learns from a reviewer's corrections, per supplier and field:
// the label printed near the right value on that supplier's invoices, and an
// example of the right format. Never a whole invoice.
//
// Hints go to the AI reader for that supplier's later invoices. They never
// stand in for the invoice: every value is still checked against the
// invoice's own text (see extract.js), hint or no hint.

import { EDITABLE_FIELDS } from './corrections.js';

// Lines and dates are not worth a hint: lines are per invoice, and the reader
// already writes dates as YYYY-MM-DD.
export const HINT_FIELDS = ['vendorName', 'abn', 'gstin', 'invoiceNumber', 'poNumber', 'currency', 'subtotal', 'gst', 'total'];
const MAX_LABEL = 40;
const MAX_EXAMPLE = 60;
const MAX_HINTS_PER_SUPPLIER = 12;

// The ways a value may be printed: 1402.5 as "1402.50" or "1,402.50"; an ABN with or without spaces.
function printedForms(field, value) {
  if (typeof value === 'number') {
    const fixed = value.toFixed(2);
    const grouped = value.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return [...new Set([grouped, fixed, Number.isInteger(value) ? String(value) : null].filter(Boolean))];
  }
  const s = String(value ?? '').trim();
  if (!s) return [];
  if (field === 'abn') return [s.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4'), s];
  return [s];
}

/** The text printed just before a value on the invoice (its label), or null. */
export function labelNear(field, value, text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  for (const form of printedForms(field, value)) {
    const at = lower.indexOf(form.toLowerCase());
    if (at < 0) continue;
    const lineStart = t.lastIndexOf('\n', at - 1) + 1;
    let label = t.slice(lineStart, at);
    // A value at the start of its line takes its label from the line above.
    if (!/[A-Za-z]/.test(label)) {
      const prevStart = t.lastIndexOf('\n', lineStart - 2) + 1;
      label = t.slice(prevStart, Math.max(prevStart, lineStart - 1));
    }
    label = label.replace(/[$₹]|\b(AUD|INR)\b/g, '').replace(/\s+/g, ' ').trim();
    // Keep the whole words nearest the value.
    if (label.length > MAX_LABEL) label = label.slice(-MAX_LABEL).replace(/^\S*\s+/, '');
    return /[A-Za-z]/.test(label) && !/\d{3,}/.test(label) ? label : null;
  }
  return null;
}

/** One hint per corrected field, for an identified supplier. */
export function buildHints({ supplier, corrections, text, by, at }) {
  if (!supplier?.abn) return [];
  return corrections
    .filter((c) => HINT_FIELDS.includes(c.field) && c.to !== null && c.to !== undefined && c.to !== '')
    .map((c) => ({
      vendorAbn: String(supplier.abn).replace(/\D/g, ''),
      vendorName: supplier.name || null,
      field: c.field,
      label: labelNear(c.field, c.to, text),
      example: (typeof c.to === 'number' ? c.to.toFixed(2) : String(c.to)).slice(0, MAX_EXAMPLE),
      updatedBy: by,
      updatedAt: at,
    }));
}

const squash = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

/** The hints for whichever known supplier this invoice text names, by ABN, or by name. */
export function hintsForText(hints, text) {
  const flat = squash(text);
  const lower = String(text || '').toLowerCase();
  const bySupplier = new Map();
  for (const h of hints || []) {
    if (!bySupplier.has(h.vendorAbn)) bySupplier.set(h.vendorAbn, []);
    bySupplier.get(h.vendorAbn).push(h);
  }
  for (const [abn, list] of bySupplier) {
    const name = list.find((h) => h.vendorName)?.vendorName;
    if ((abn && flat.includes(abn)) || (name && lower.includes(name.toLowerCase()))) return list.slice(0, MAX_HINTS_PER_SUPPLIER);
  }
  return [];
}

/** The hints as a short note for the AI reader's user message. */
export function hintsPrompt(hints) {
  if (!hints?.length) return '';
  const name = hints.find((h) => h.vendorName)?.vendorName || 'this supplier';
  const lines = hints.map((h) => `- ${h.field} (${EDITABLE_FIELDS[h.field]?.label || h.field}): ${h.label ? `printed next to "${h.label}"; ` : ''}an earlier correct value looked like "${h.example}".`);
  return `\n\nReviewers corrected earlier invoices from ${name}. Where to look and the format to expect (these are not this invoice's values; copy every value from the invoice text above, and use null if it is not there):\n${lines.join('\n')}`;
}
