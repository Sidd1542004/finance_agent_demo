// Bank reconciliation rules: read a statement file and match its lines to
// approved payments. Plain functions, no database, no AI. Matching money is
// done by fixed rules only.

import { cents, money, day } from './rules.js';
import { toIsoDate } from './extract.js';
import { STATUS_LABEL } from './lifecycle.js';

const MAX_LINES = 500;

// ---------- Reading the statement (CSV) ----------

function splitCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

// "-1,402.50", "$12.50", "(811.80)" and "811.80 DR" are all understood.
export function parseAmount(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s) || /\bDR$/i.test(s);
  const digits = s.replace(/[^0-9.]/g, '');
  if (!digits || !/^\d*\.?\d*$/.test(digits) || digits === '.') return null;
  const n = Number(digits);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

/**
 * Read a bank statement exported as CSV.
 * Needs a header row with a date column, a description column, and either an
 * amount column (money out is negative) or separate debit and credit columns.
 */
export function parseStatement(text) {
  const rows = splitCsv(String(text ?? ''));
  if (rows.length < 2) throw new Error('The statement has no transactions. It needs a header row and at least one line.');

  const header = rows[0].map((h) => h.toLowerCase());
  const col = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = col('date');
  const iDesc = col('description', 'narrative', 'details', 'particulars', 'transaction');
  const iAmount = col('amount');
  const iDebit = col('debit', 'withdrawal', 'money out');
  const iCredit = col('credit', 'deposit', 'money in');
  if (iDate < 0 || iDesc < 0 || (iAmount < 0 && iDebit < 0 && iCredit < 0)) {
    throw new Error('The statement needs columns for date, description and amount (or debit and credit). Check the header row.');
  }
  if (rows.length - 1 > MAX_LINES) throw new Error(`The statement has more than ${MAX_LINES} lines. Split it into smaller files.`);

  return rows.slice(1).map((r, index) => {
    const n = index + 1;
    let amount;
    if (iAmount >= 0) {
      amount = parseAmount(r[iAmount]);
      if (amount === null) throw new Error(`Line ${n}: the amount "${r[iAmount] ?? ''}" is not a number.`);
    } else {
      const debit = iDebit >= 0 ? parseAmount(r[iDebit]) : null;
      const credit = iCredit >= 0 ? parseAmount(r[iCredit]) : null;
      if (debit === null && credit === null) throw new Error(`Line ${n}: there is no debit or credit amount.`);
      amount = Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
    }
    return { n, date: toIsoDate(r[iDate]) || null, description: r[iDesc] || '', amount: Math.round(amount * 100) / 100 };
  });
}

// ---------- Matching ----------

const norm = (s) =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

// "HOS10482" in the description counts as invoice HOS-10482.
export function refInDescription(description, invoiceNumber) {
  const ref = norm(invoiceNumber);
  return ref.length >= 5 && norm(description).includes(ref);
}

const NOISE = new Set(['pty', 'ltd', 'limited', 'and', 'the', 'co', 'company']);
const words = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NOISE.has(w));

// Banks shorten names ("HARBOUR OFFICE SUP"), so a word in the description may
// be the start of a word in the supplier's name. Two words must agree.
export function vendorInDescription(description, vendorName) {
  const vendor = words(vendorName);
  const desc = words(description);
  if (!vendor.length) return false;
  const hits = vendor.filter((v) => desc.some((d) => d === v || (d.length >= 3 && v.startsWith(d)))).length;
  return hits >= Math.min(2, vendor.length);
}

const sameAmount = (line, payment) => cents(Math.abs(line.amount)) === cents(payment.amount);

/**
 * Match statement lines to payments.
 *
 * @param lines     [{ n, date, description, amount }] from parseStatement
 * @param payments  every payment: [{ id, invoiceNumber, vendorName, amount, status, paidOn, bank }]
 * @param invoices  every readable invoice: [{ invoiceNumber, vendorName, status }]
 * @returns { lines, unpaid }
 *   line.status: matched   - the agent will mark the payment as paid
 *                suggested - probably this payment, a person confirms
 *                exception - something is wrong, a person decides
 *                unmatched - nothing fits, a person decides
 *                skipped   - money in, outside this agent's job
 */
export function matchLines(lines, allPayments, invoices) {
  let payments = allPayments;
  const taken = new Map(); // payment id -> line number that pays it
  const out = lines.map((l) => ({
    ...l,
    status: null,
    method: null,
    kind: null,
    paymentId: null,
    invoiceNumber: null,
    vendorName: null,
    candidate: null,
    reason: null,
    aiNote: null,
    resolution: null,
  }));
  const brief = (p) => ({ paymentId: p.id, invoiceNumber: p.invoiceNumber, vendorName: p.vendorName, amount: p.amount });
  const set = (line, fields) => Object.assign(line, fields);

  const alreadyPaid = (line, p) => {
    const by = taken.get(p.id);
    if (by !== undefined) {
      return `Same supplier and amount as invoice ${p.invoiceNumber}, which line ${by} of this statement already pays. Possible double payment.`;
    }
    const same = p.bank && p.bank.date === line.date && p.bank.description === line.description;
    return same
      ? `This looks like the same bank line that already paid invoice ${p.invoiceNumber} in an earlier statement.`
      : `Invoice ${p.invoiceNumber} was already paid${p.paidOn ? ` on ${day(p.paidOn)}` : ''}. Possible double payment.`;
  };

  for (const line of out) {
    if (line.amount >= 0) set(line, { status: 'skipped', reason: 'Money in. This agent only reconciles payments to suppliers.' });
  }

  // Cancelled payments never went out and can't be matched.
  payments = payments.filter((p) => p.status !== 'cancelled');

  // Pass 1: the description quotes an invoice number.
  for (const line of out.filter((l) => !l.status)) {
    const named = payments.filter((p) => refInDescription(line.description, p.invoiceNumber));
    const p = named.find((x) => x.status === 'queued' && !taken.has(x.id) && sameAmount(line, x)) || named[0];
    if (p) {
      const who = { invoiceNumber: p.invoiceNumber, vendorName: p.vendorName };
      if (p.status === 'paid' || taken.has(p.id)) {
        set(line, { ...who, status: 'exception', kind: 'duplicate', reason: alreadyPaid(line, p) });
      } else if (p.status !== 'queued') {
        set(line, {
          ...who,
          status: 'exception',
          kind: 'on_hold',
          reason: `The payment for invoice ${p.invoiceNumber} is ${p.status === 'failed' ? 'marked as failed' : 'on hold'}, but the bank shows money going out.`,
        });
      } else if (sameAmount(line, p)) {
        taken.set(p.id, line.n);
        set(line, { ...who, status: 'matched', method: 'invoice number and amount', paymentId: p.id, reason: `Quotes invoice ${p.invoiceNumber} and the amount matches.` });
      } else {
        set(line, {
          ...who,
          status: 'exception',
          kind: 'amount_differs',
          candidate: brief(p),
          reason: `The bank shows ${money(Math.abs(line.amount))}, but invoice ${p.invoiceNumber} was approved for ${money(p.amount)}.`,
        });
      }
      continue;
    }
    const invoice = invoices.find((i) => refInDescription(line.description, i.invoiceNumber));
    if (invoice) {
      set(line, {
        status: 'exception',
        kind: 'not_approved',
        invoiceNumber: invoice.invoiceNumber,
        vendorName: invoice.vendorName,
        reason:
          invoice.status === 'approved'
            ? `Quotes invoice ${invoice.invoiceNumber}, which is approved but has no scheduled payment.`
            : `Quotes invoice ${invoice.invoiceNumber}, which is not approved for payment (it is ${(STATUS_LABEL[invoice.status] || invoice.status).toLowerCase()}).`,
      });
    }
  }

  // Pass 2: no invoice number, but the supplier's name and the amount fit.
  for (const line of out.filter((l) => !l.status)) {
    const fits = payments.filter((p) => vendorInDescription(line.description, p.vendorName) && sameAmount(line, p));
    const open = fits.filter((p) => p.status === 'queued' && !taken.has(p.id));
    if (open.length === 1) {
      const p = open[0];
      taken.set(p.id, line.n);
      set(line, {
        status: 'matched',
        method: 'supplier name and amount',
        paymentId: p.id,
        invoiceNumber: p.invoiceNumber,
        vendorName: p.vendorName,
        reason: `Names ${p.vendorName} and the amount matches invoice ${p.invoiceNumber}.`,
      });
    } else if (open.length > 1) {
      set(line, {
        status: 'exception',
        kind: 'ambiguous',
        vendorName: open[0].vendorName,
        reason: `${open.length} approved payments to ${open[0].vendorName} are for this amount (${open.map((p) => p.invoiceNumber).join(', ')}), so the agent cannot tell which one this is.`,
      });
    } else if (fits.length) {
      const p = fits.find((x) => taken.has(x.id)) || fits[0];
      set(line, { status: 'exception', kind: 'duplicate', invoiceNumber: p.invoiceNumber, vendorName: p.vendorName, reason: alreadyPaid(line, p) });
    }
  }

  // Pass 3: only the amount fits. Never matched without a person.
  for (const line of out.filter((l) => !l.status)) {
    const open = payments.filter((p) => p.status === 'queued' && !taken.has(p.id) && sameAmount(line, p));
    if (open.length === 1) {
      const p = open[0];
      set(line, {
        status: 'suggested',
        kind: 'amount_only',
        candidate: brief(p),
        reason: `Same amount as the approved payment to ${p.vendorName} for invoice ${p.invoiceNumber}, but the description does not name them.`,
      });
    } else {
      set(line, { status: 'unmatched', reason: 'No approved payment matches this line.' });
    }
  }

  const unpaid = payments
    .filter((p) => p.status === 'queued' && !taken.has(p.id))
    .map((p) => ({ invoiceNumber: p.invoiceNumber, vendorName: p.vendorName, amount: p.amount, dueDate: p.dueDate ?? null }));

  return { lines: out, unpaid };
}

export const NEEDS_PERSON = ['suggested', 'exception', 'unmatched'];
export const needsPerson = (line) => NEEDS_PERSON.includes(line.status);
