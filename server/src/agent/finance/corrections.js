// A reviewer corrects fields the reader got wrong. Plain functions.
//
// Corrections are kept on the invoice (invoice.corrections, append only:
// { field, from, to, by, note, at }) and laid over whatever the reader reads
// every time the agent runs, so they survive processing again. The latest
// correction of a field wins. Every other check (ABN checksum, arithmetic,
// PO matching, duplicates, approval blockers) runs on the corrected values.

import { ActionError } from './lifecycle.js';
import { normaliseAbn, formatAbn } from './rules.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// field -> { label, kind }
export const EDITABLE_FIELDS = {
  vendorName: { label: 'Supplier', kind: 'text' },
  abn: { label: 'ABN', kind: 'abn' },
  gstin: { label: 'GSTIN', kind: 'gstin' },
  invoiceNumber: { label: 'Invoice number', kind: 'text' },
  invoiceDate: { label: 'Invoice date', kind: 'date' },
  dueDate: { label: 'Due date', kind: 'date' },
  poNumber: { label: 'Purchase order', kind: 'code' },
  currency: { label: 'Currency', kind: 'currency' },
  subtotal: { label: 'Subtotal', kind: 'amount' },
  gst: { label: 'GST', kind: 'amount' },
  total: { label: 'Total', kind: 'amount' },
  lines: { label: 'Line items', kind: 'lines' },
};

export const LINE_FIELDS = ['sku', 'description', 'qty', 'unitPrice', 'amount'];
const MAX_LINES = 200;

const bad = (message) => new ActionError(400, message);
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && !v.trim());

function realDate(s) {
  if (!ISO.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function number(v, label) {
  if (blank(v)) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s$]/g, ''));
  if (!Number.isFinite(n)) throw bad(`${label} must be a number.`);
  return Math.round(n * 10000) / 10000;
}

function text(v, label, max = 200) {
  if (blank(v)) return null;
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${label} must be text.`);
  const s = String(v).trim();
  if (s.length > max) throw bad(`${label} is too long (at most ${max} characters).`);
  return s;
}

/** Check and tidy one value. Empty means "not on the invoice" (null). */
export function cleanValue(field, value) {
  const def = EDITABLE_FIELDS[field];
  if (!def) throw bad(`${field} cannot be edited.`);
  const { label, kind } = def;
  switch (kind) {
    case 'text':
      return text(value, label);
    case 'code': {
      const s = text(value, label, 80);
      return s ? s.toUpperCase() : null;
    }
    case 'abn': {
      if (blank(value)) return null;
      const raw = String(value).trim();
      if (!/^[\d\s]+$/.test(raw)) throw bad('ABN must be digits only (spaces are fine).');
      const digits = normaliseAbn(raw);
      if (digits.length !== 11) throw bad('ABN must have 11 digits.');
      return digits;
    }
    case 'gstin': {
      if (blank(value)) return null;
      const g = String(value).trim().toUpperCase().replace(/\s+/g, '');
      if (!/^[0-9A-Z]{15}$/.test(g)) throw bad('GSTIN must be 15 letters and digits.');
      return g;
    }
    case 'date': {
      if (blank(value)) return null;
      const s = String(value).trim();
      if (!realDate(s)) throw bad(`${label} must be a date written YYYY-MM-DD.`);
      return s;
    }
    case 'currency': {
      if (blank(value)) return null;
      const c = String(value).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(c)) throw bad('Currency must be a three-letter code such as AUD.');
      return c;
    }
    case 'amount':
      return number(value, label);
    case 'lines': {
      if (!Array.isArray(value)) throw bad('Line items must be a list.');
      if (value.length > MAX_LINES) throw bad(`At most ${MAX_LINES} line items.`);
      return value.map((l, i) => {
        if (!l || typeof l !== 'object') throw bad(`Line ${i + 1} is not valid.`);
        const line = {
          sku: text(l.sku, `Line ${i + 1} item code`, 80),
          description: text(l.description, `Line ${i + 1} description`),
          qty: number(l.qty, `Line ${i + 1} quantity`),
          unit: text(l.unit, `Line ${i + 1} unit`, 20),
          unitPrice: number(l.unitPrice, `Line ${i + 1} unit price`),
          amount: number(l.amount, `Line ${i + 1} amount`),
        };
        if (!line.sku && !line.description) throw bad(`Line ${i + 1} needs an item code or a description.`);
        return line;
      });
    }
    default:
      throw bad(`${field} cannot be edited.`);
  }
}

const sameLines = (a = [], b = []) => a.length === b.length && a.every((l, i) => LINE_FIELDS.every((k) => (l?.[k] ?? null) === (b[i]?.[k] ?? null)));
const same = (field, a, b) => (field === 'lines' ? sameLines(a || [], b || []) : (a ?? null) === (b ?? null));

/**
 * The changes a reviewer asked for, against the invoice as currently read.
 * `fields` = { total: 1402.5, abn: '51 824 753 556', lines: [...] }. Only
 * fields that actually change are returned: [{ field, from, to }].
 */
export function correctionChanges(extracted, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw bad('Send the corrected fields.');
  const unknown = Object.keys(fields).filter((k) => !EDITABLE_FIELDS[k]);
  if (unknown.length) throw bad(`These fields cannot be edited: ${unknown.join(', ')}.`);
  const current = extracted || {};
  const changes = [];
  for (const [field, value] of Object.entries(fields)) {
    const to = cleanValue(field, value);
    const from = field === 'lines' ? (current.lines || []).map((l) => Object.fromEntries([...LINE_FIELDS, 'unit'].map((k) => [k, l?.[k] ?? null]))) : current[field] ?? null;
    if (!same(field, from, to)) changes.push({ field, from, to });
  }
  if (!changes.length) throw bad('Nothing was changed.');
  return changes;
}

/** The latest correction of each field: Map field -> correction. */
export function latestCorrections(corrections) {
  const map = new Map();
  for (const c of corrections || []) if (c && EDITABLE_FIELDS[c.field]) map.set(c.field, c);
  return map;
}

const money = (n) => (typeof n === 'number' ? n.toFixed(2) : 'blank');

/** A value as a person reads it, for the history and the read panel. */
export function showValue(field, value) {
  if (value === null || value === undefined || value === '') return 'blank';
  const kind = EDITABLE_FIELDS[field]?.kind;
  if (kind === 'abn') return formatAbn(value);
  if (kind === 'amount') return money(value);
  if (kind === 'lines') {
    if (!value.length) return 'no line items';
    return value.map((l) => `${[l.sku, l.description].filter(Boolean).join(' ')}: ${l.qty ?? '?'} x ${money(l.unitPrice)} = ${money(l.amount)}`).join('; ');
  }
  return String(value);
}

export const describeChange = (c) => `${EDITABLE_FIELDS[c.field]?.label || c.field}: ${showValue(c.field, c.from)} → ${showValue(c.field, c.to)}`;
