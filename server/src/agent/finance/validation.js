// Central invoice validation service.
//
// Every validation rule about the invoice itself lives here, once:
//   * required details and reading confidence
//   * arithmetic (lines, subtotal, discounts and charges, tax, total)
//   * jurisdiction (Australia or India) and the tax rules for it:
//       - the supplier's tax identifier (ABN or GSTIN) and whether it is
//         a valid number, and whether it was verified with the register
//       - GST registration (is the supplier allowed to charge GST?)
//       - whether the tax charged is correct
//   * whether the supplier is one we know
//
// Purchase order matching lives in matching.js, duplicates in duplicates.js.
// Plain functions, no database and no AI.

import { cents, isNum, isValidAbn, normaliseAbn, formatAbn, namesMatch } from './rules.js';

// Every check has a severity that says where a failure sends the invoice:
//   review - Needs Review: data, identity or tax details a person must confirm
//   hold   - On Hold: a mismatch against the PO, goods received or the tax rules
// Some failures also block approval outright (see lifecycle.js APPROVAL_BLOCKERS).
export const SEVERITY = {
  required_fields: 'review',
  reader_confidence: 'review',
  arithmetic: 'review',
  jurisdiction: 'review',
  supplier_tax_id: 'review',
  supplier_known: 'review',
  gst_registration: 'review',
  tax_charged: 'hold',
};

export const fmtMoney = (n, currency = 'AUD') => {
  if (!isNum(n)) return 'not shown';
  try {
    return n.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-AU', { style: 'currency', currency: currency || 'AUD' });
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
};

const near = (a, b, tol) => Math.abs(cents(a) - cents(b)) <= cents(tol);

// ---------- Indian GSTIN ----------

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const GSTIN_PATTERN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/;

// GSTIN check character (mod 36, alternating weights 1 and 2).
export function isValidGstin(value) {
  const g = String(value ?? '').trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  const state = Number(g.slice(0, 2));
  if (state < 1 || state > 38) return false;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = GSTIN_CHARS.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === g[14];
}

// ---------- Jurisdiction ----------

const AU_STATE = /\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+\d{4}\b/;

/**
 * Work out which country's tax rules apply, from what the invoice shows.
 * Returns { code: 'AU' | 'IN' | 'unknown', reasons: [string] }.
 */
export function detectJurisdiction(extracted, text = '') {
  const au = [];
  const india = [];
  const t = String(text);
  if (extracted.gstin || GSTIN_PATTERN.test(t.toUpperCase())) india.push('a GSTIN');
  if (/\b(CGST|SGST|IGST|UTGST)\b/i.test(t) || (extracted.taxLines || []).some((l) => /^(CGST|SGST|IGST|UTGST)$/.test(l.type))) india.push('CGST, SGST or IGST');
  if (extracted.currency === 'INR' || /₹|\bINR\b/.test(t)) india.push('Indian rupees');
  if (extracted.abn) au.push('an ABN');
  else if (/\bA\.?B\.?N\b/.test(t)) au.push('an ABN label');
  if (extracted.currency === 'AUD' || /\bAUD\b|A\$/.test(t)) au.push('Australian dollars');
  if (/\bGST\s*\(?\s*10\s*%/i.test(t)) au.push('GST at 10%');
  if (AU_STATE.test(t)) au.push('an Australian address');
  if (india.length > au.length) return { code: 'IN', reasons: india };
  if (au.length > india.length) return { code: 'AU', reasons: au };
  if (au.length && india.length) return { code: 'unknown', reasons: [...au, ...india] };
  return { code: 'unknown', reasons: [] };
}

// ---------- Arithmetic ----------

export function checkArithmetic(e, { tolerance = 0.05 } = {}) {
  const cur = e.currency || 'AUD';
  const m = (n) => fmtMoney(n, cur);
  const problems = [];
  const lines = e.lines || [];
  for (const l of lines) {
    if (!isNum(l.qty) || !isNum(l.unitPrice) || !isNum(l.amount)) {
      problems.push(`${l.sku || l.description || 'An item'}: quantity, price or amount is missing.`);
    } else if (!near(l.qty * l.unitPrice, l.amount, tolerance)) {
      problems.push(`${l.sku || l.description || 'An item'}: ${l.qty} x ${m(l.unitPrice)} is ${m(l.qty * l.unitPrice)}, not ${m(l.amount)}.`);
    }
  }
  const lineSum = lines.reduce((s, l) => s + (isNum(l.amount) ? l.amount : 0), 0);
  const discount = isNum(e.discount) ? Math.abs(e.discount) : 0;
  const charges = isNum(e.charges) ? e.charges : 0;
  const tax = isNum(e.gst) ? e.gst : null;

  if (isNum(e.subtotal) && lines.length) {
    const ok = near(lineSum, e.subtotal, tolerance) || near(lineSum - discount + charges, e.subtotal, tolerance);
    if (!ok) problems.push(`Line items add up to ${m(lineSum)}${discount || charges ? ` (${m(lineSum - discount + charges)} after discounts and charges)` : ''}, but the subtotal says ${m(e.subtotal)}.`);
  }
  if (isNum(e.subtotal) && tax !== null && isNum(e.total)) {
    const ok = near(e.subtotal + tax, e.total, tolerance) || near(e.subtotal + tax - discount + charges, e.total, tolerance);
    if (!ok) problems.push(`Subtotal plus tax is ${m(e.subtotal + tax)}, but the total says ${m(e.total)}.`);
  } else if (!isNum(e.total)) {
    problems.push('There is no total, so the sums cannot be checked.');
  } else if (!isNum(e.subtotal) && lines.length && tax !== null && !near(lineSum - discount + charges + tax, e.total, tolerance)) {
    problems.push(`Line items plus tax come to ${m(lineSum - discount + charges + tax)}, but the total says ${m(e.total)}.`);
  }
  return problems;
}

// ---------- Tax ----------

const INDIAN_RATES = [0, 0.25, 1.5, 3, 5, 6, 12, 18, 28, 40];

function australianTax({ e, vendor, abr, policy }) {
  const cur = e.currency || 'AUD';
  const m = (n) => fmtMoney(n, cur);
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail, severity: SEVERITY[id] });

  // 1. The ABN itself: present, a valid number, verified with the register.
  let identifier;
  if (!e.abn) {
    identifier = { type: 'ABN', value: null, format: 'missing', verification: 'not_checked' };
    checks.push({ id: 'supplier_tax_id', label: "Supplier's ABN", status: 'fail', severity: policy.missingAbn === 'hold' ? 'hold' : 'review', detail: "The invoice does not show the supplier's ABN. A tax invoice must show it before the GST credit can be claimed, and paying a supplier with no ABN can require no-ABN withholding. Confirm the ABN with the supplier before approving." });
  } else if (!isValidAbn(e.abn)) {
    identifier = { type: 'ABN', value: e.abn, format: 'invalid', verification: 'not_checked' };
    add('supplier_tax_id', "Supplier's ABN", 'fail', `ABN ${formatAbn(e.abn)} fails the ATO checksum, so it is not a real ABN.`);
  } else if (abr && abr.status === 'active') {
    identifier = { type: 'ABN', value: e.abn, format: 'valid', verification: 'verified', register: abr };
    add('supplier_tax_id', "Supplier's ABN", 'pass', `ABN ${formatAbn(e.abn)} is active on the Australian Business Register${abr.entityName ? ` (${abr.entityName})` : ''}.`);
  } else if (abr && (abr.status === 'cancelled' || abr.status === 'not_found')) {
    identifier = { type: 'ABN', value: e.abn, format: 'valid', verification: abr.status, register: abr };
    add('supplier_tax_id', "Supplier's ABN", 'fail', `ABN ${formatAbn(e.abn)} is ${abr.status === 'cancelled' ? 'cancelled' : 'not found'} on the Australian Business Register.`);
  } else {
    identifier = { type: 'ABN', value: e.abn, format: 'valid', verification: 'unverified' };
    add(
      'supplier_tax_id',
      "Supplier's ABN",
      'unverified',
      `ABN ${formatAbn(e.abn)} is a valid number (it passes the ATO checksum), but it has not been checked against the Australian Business Register${abr?.status === 'error' ? ` (the lookup failed: ${abr.message})` : ', because no ABR lookup is configured'}.`,
    );
  }

  // 2. GST registration: may this supplier charge GST at all?
  let registered = null;
  let source = null;
  if (abr && abr.status === 'active') {
    registered = Boolean(abr.gstFrom);
    source = 'Australian Business Register';
  } else if (vendor && typeof vendor.gstRegistered === 'boolean') {
    registered = vendor.gstRegistered;
    source = 'supplier record';
  }
  const charged = isNum(e.gst) && e.gst > 0;
  if (registered === false && charged) {
    add('gst_registration', 'GST registration', 'fail', `The ${source} says the supplier is not registered for GST, but the invoice charges ${m(e.gst)} GST.`);
  } else if (registered === null) {
    add('gst_registration', 'GST registration', 'unverified', "The supplier's GST registration could not be confirmed (no supplier record or register lookup).");
  } else {
    add('gst_registration', 'GST registration', 'pass', registered ? `Registered for GST (${source}).` : `Not registered for GST (${source}) and no GST was charged.`);
  }

  // 3. Is the GST charged correct?
  const rate = policy.gstRatePct;
  if (!isNum(e.gst)) {
    add('tax_charged', 'GST charged correctly', 'fail', 'The invoice does not show a GST amount, so the GST cannot be checked.');
  } else if (!isNum(e.subtotal)) {
    add('tax_charged', 'GST charged correctly', 'fail', 'The invoice does not show a subtotal before GST, so the GST cannot be checked.');
  } else if (e.gst === 0) {
    add(
      'tax_charged',
      'GST charged correctly',
      registered === true ? 'unverified' : 'pass',
      registered === true ? 'No GST was charged by a GST-registered supplier. Check the items are GST-free.' : 'No GST was charged.',
    );
  } else {
    const expected = Math.round(e.subtotal * rate) / 100;
    const ok = near(e.gst, expected, policy.roundingTolerance);
    add('tax_charged', 'GST charged correctly', ok ? 'pass' : 'fail', ok ? `GST ${m(e.gst)} is ${rate}% of the subtotal.` : `GST shown is ${m(e.gst)}, but ${rate}% of ${m(e.subtotal)} is ${m(expected)}.`);
  }

  return { identifier, registration: { registered, source }, checks };
}

function indianTax({ e, policy }) {
  const cur = e.currency || 'INR';
  const m = (n) => fmtMoney(n, cur);
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail, severity: SEVERITY[id] });

  // 1. GSTIN.
  let identifier;
  if (!e.gstin) {
    identifier = { type: 'GSTIN', value: null, format: 'missing', verification: 'not_checked' };
    add('supplier_tax_id', "Supplier's GSTIN", 'fail', "The invoice does not show the supplier's GSTIN. A GST tax invoice must show it.");
  } else if (!isValidGstin(e.gstin)) {
    identifier = { type: 'GSTIN', value: e.gstin, format: 'invalid', verification: 'not_checked' };
    add('supplier_tax_id', "Supplier's GSTIN", 'fail', `GSTIN ${e.gstin} is not a valid number (format or check character).`);
  } else {
    identifier = { type: 'GSTIN', value: e.gstin, format: 'valid', verification: 'unverified' };
    add('supplier_tax_id', "Supplier's GSTIN", 'unverified', `GSTIN ${e.gstin} is a valid number (state code ${e.gstin.slice(0, 2)}), but it has not been checked on the GST portal.`);
  }

  // 2. Registration: a valid GSTIN means registered; nothing else to check offline.
  add('gst_registration', 'GST registration', e.gstin && isValidGstin(e.gstin) ? 'pass' : 'unverified', e.gstin && isValidGstin(e.gstin) ? 'A valid GSTIN means the supplier is GST-registered (not verified online).' : 'GST registration could not be confirmed.');

  // 3. Tax charged: CGST + SGST (same state) or IGST (between states), never both.
  const lines = e.taxLines || [];
  const byType = (t) => lines.filter((l) => l.type === t);
  const cgst = byType('CGST');
  const sgst = [...byType('SGST'), ...byType('UTGST')];
  const igst = byType('IGST');
  const sum = (ls) => ls.reduce((s, l) => s + (isNum(l.amount) ? l.amount : 0), 0);
  const problems = [];
  const tol = Math.max(policy.roundingTolerance, 1); // Indian invoices often round tax to the rupee
  if (!lines.length) {
    if (!isNum(e.gst)) problems.push('The invoice does not show the GST charged (CGST, SGST or IGST).');
  } else {
    if (igst.length && (cgst.length || sgst.length)) problems.push('The invoice charges IGST together with CGST/SGST. A supply is either within one state (CGST + SGST) or between states (IGST), not both.');
    if (cgst.length && !sgst.length) problems.push('CGST is charged without SGST/UTGST.');
    if (sgst.length && !cgst.length) problems.push('SGST/UTGST is charged without CGST.');
    if (cgst.length && sgst.length && !near(sum(cgst), sum(sgst), tol)) problems.push(`CGST (${m(sum(cgst))}) and SGST (${m(sum(sgst))}) should be equal.`);
    if (isNum(e.subtotal)) {
      for (const l of lines) {
        if (isNum(l.rate) && isNum(l.amount) && !near((e.subtotal * l.rate) / 100, l.amount, tol)) {
          problems.push(`${l.type} at ${l.rate}% of ${m(e.subtotal)} is ${m((e.subtotal * l.rate) / 100)}, but the invoice shows ${m(l.amount)}.`);
        }
      }
      const total = (cgst[0]?.rate || 0) + (sgst[0]?.rate || 0) + (igst[0]?.rate || 0);
      if (total && !INDIAN_RATES.includes(total)) problems.push(`A combined GST rate of ${total}% is not a standard GST rate.`);
    }
    if (isNum(e.gst) && !near(sum(lines), e.gst, tol)) problems.push(`The tax lines add up to ${m(sum(lines))}, but the tax total says ${m(e.gst)}.`);
  }
  add('tax_charged', 'GST charged correctly', problems.length ? 'fail' : 'pass', problems.length ? problems.join(' ') : `${igst.length ? 'IGST' : 'CGST and SGST'} add up and match the stated rates.`);

  return { identifier, registration: { registered: Boolean(e.gstin && isValidGstin(e.gstin)), source: 'GSTIN' }, checks };
}

/**
 * Validate an extracted invoice.
 *
 * @param extracted  the reader's output (extract.js normalise format)
 * @param extraction { confidence, notes } from the reader
 * @param text       the invoice text, used to identify the jurisdiction
 * @param vendor     the approved supplier record, if one was identified
 * @param vendorBy   how the supplier was identified: 'abn' | 'name' | null
 * @param abr        result of an Australian Business Register lookup, or null
 * @returns { jurisdiction, identifier, registration, checks }
 */
export function validateInvoice({ extracted: e, extraction, text, vendor, vendorBy, abr = null, policy }) {
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail, severity: SEVERITY[id] });
  const pct = (x) => `${Math.round(x * 100)}%`;

  // Required details. The tax identifier is checked once, under tax, not here.
  const missing = [];
  if (!e.vendorName && !vendor) missing.push('supplier name');
  if (!e.invoiceNumber) missing.push('invoice number');
  if (!e.invoiceDate) missing.push('invoice date');
  if (!isNum(e.total)) missing.push('total');
  if (!(e.lines || []).length) missing.push('line items');
  add('required_fields', 'Invoice has the required details', missing.length ? 'fail' : 'pass', missing.length ? `Could not find: ${missing.join(', ')}.` : 'Supplier, invoice number, date, line items and total are present.');

  const confidence = isNum(extraction?.confidence) ? extraction.confidence : 0;
  add(
    'reader_confidence',
    'Invoice was read with enough confidence',
    confidence >= policy.minConfidence ? 'pass' : 'fail',
    confidence >= policy.minConfidence ? `Reader confidence ${pct(confidence)} (minimum ${pct(policy.minConfidence)}).` : `Reader confidence ${pct(confidence)} is below the ${pct(policy.minConfidence)} minimum.${extraction?.notes ? ` ${extraction.notes}` : ''}`,
  );

  const sums = checkArithmetic(e, { tolerance: policy.roundingTolerance });
  add('arithmetic', 'Amounts add up', sums.length ? 'fail' : 'pass', sums.length ? sums.join(' ') : 'Line amounts, subtotal, tax and total are consistent.');

  const jurisdiction = detectJurisdiction(e, text);
  let tax;
  if (jurisdiction.code === 'AU') tax = australianTax({ e, vendor, abr, policy });
  else if (jurisdiction.code === 'IN') tax = indianTax({ e, policy });
  else tax = { identifier: { type: null, value: e.abn || e.gstin || null, format: 'unknown', verification: 'not_checked' }, registration: { registered: null, source: null }, checks: [] };
  add(
    'jurisdiction',
    'Tax rules identified',
    jurisdiction.code === 'unknown' ? 'fail' : 'pass',
    jurisdiction.code === 'unknown'
      ? `Could not tell which country's tax rules apply${jurisdiction.reasons.length ? ` (the invoice shows ${jurisdiction.reasons.join(' and ')})` : ''}. A person should confirm the tax treatment.`
      : `${jurisdiction.code === 'AU' ? 'Australian' : 'Indian'} GST rules applied, because the invoice shows ${jurisdiction.reasons.join(', ')}.`,
  );
  checks.push(...tax.checks);

  // Supplier: one we know? Identified by tax ID where possible, by name otherwise.
  if (!vendor) {
    add('supplier_known', 'Supplier is on the approved list', 'fail', `${e.vendorName ? `"${e.vendorName}"` : 'The supplier'} is not on the approved supplier list${tax.identifier.value ? ` (no supplier has ${tax.identifier.type} ${tax.identifier.type === 'ABN' ? formatAbn(tax.identifier.value) : tax.identifier.value})` : ''}.`);
  } else if (vendorBy === 'abn' && e.vendorName && !namesMatch(vendor.name, e.vendorName)) {
    add('supplier_known', 'Supplier is on the approved list', 'fail', `That ABN belongs to ${vendor.name}, but the invoice is from "${e.vendorName}".`);
  } else if (vendorBy === 'name') {
    add('supplier_known', 'Supplier is on the approved list', 'pass', `${vendor.name} is an approved supplier (matched by name, because the invoice shows no ABN).`);
  } else {
    add('supplier_known', 'Supplier is on the approved list', 'pass', `${vendor.name} is an approved supplier.`);
  }

  return { jurisdiction, identifier: tax.identifier, registration: tax.registration, checks };
}

// Find the supplier record: by ABN first, then by exact-ish name when the invoice shows no ABN.
export function identifyVendor(extracted, vendors) {
  if (extracted.abn) {
    const v = vendors.find((x) => normaliseAbn(x.abn) === extracted.abn);
    return v ? { vendor: v, by: 'abn' } : { vendor: null, by: null };
  }
  if (extracted.vendorName) {
    const v = vendors.find((x) => namesMatch(x.name, extracted.vendorName));
    if (v) return { vendor: v, by: 'name' };
  }
  return { vendor: null, by: null };
}
