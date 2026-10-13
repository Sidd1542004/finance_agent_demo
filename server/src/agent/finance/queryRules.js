// Supplier email checks and the reply text. Plain functions, no database, no AI.
//
// The AI model only works out what the supplier is asking and which invoices
// they mean. Whether a reply may go out without a person, and every word of
// that reply, is decided here from the records.

import { money, day, isNum, cents } from './rules.js';

export const INTENTS = ['payment_status', 'bank_details_change', 'dispute', 'other'];

export const INTENT_LABEL = {
  payment_status: 'a payment status question',
  bank_details_change: 'a request to change bank or payment details',
  dispute: 'a dispute or complaint',
  other: 'something other than a payment status question',
};

// "Dana <accounts@x.example>" -> "accounts@x.example"
export const emailAddress = (value) => {
  const m = String(value ?? '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
};

// On shared mail providers the domain proves nothing, so the full address must match.
const PUBLIC_MAIL = new Set(['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'yahoo.com.au', 'icloud.com', 'live.com', 'bigpond.com', 'proton.me', 'protonmail.com']);

export function senderMatchesVendor(sender, vendorEmail) {
  const a = emailAddress(sender);
  const b = emailAddress(vendorEmail);
  if (!a || !b) return false;
  if (a === b) return true;
  const domainA = a.split('@')[1];
  const domainB = b.split('@')[1];
  return domainA === domainB && !PUBLIC_MAIL.has(domainA);
}

export const findVendorForSender = (sender, vendors) => vendors.find((v) => senderMatchesVendor(sender, v.email)) || null;

// Any mention of bank or payment details sends the email to a person, whatever
// the AI reader thought the email was about. Changed bank details are a common
// fraud route.
const BANK_DETAILS = /\b(bsb|bank\s+(?:account|details?)|account\s+(?:number|no\.?|details?)|new\s+account|changed\s+banks?|payment\s+details|remit\s+to)\b/i;
export const mentionsBankDetails = (text) => BANK_DETAILS.test(String(text ?? ''));

// Several invoices can share a number (a duplicate submission). Pick the one
// that belongs to this supplier and is furthest along.
const RANK = { payment_completed: 0, payment_pending: 1, approved: 2, under_review: 3, needs_review: 3, on_hold: 3, payment_failed: 4, rejected: 5, cancelled: 5, received: 6, processing: 6 };
export function pickInvoice(candidates, vendorAbn) {
  return (
    (candidates || [])
      .filter((c) => c.abn === vendorAbn && c.status !== 'failed')
      .sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9))[0] || null
  );
}

// Statuses the agent may tell a supplier about on its own.
// Rejected, cancelled and failed payments always go to a person.
export function shareable(invoice) {
  if (!invoice) return false;
  if (['under_review', 'needs_review', 'on_hold', 'approved'].includes(invoice.status)) return true;
  if (invoice.status === 'payment_pending') return invoice.payment?.status === 'queued';
  return invoice.status === 'payment_completed' && invoice.payment?.status === 'paid';
}

// Only reasons the supplier can act on are passed on. Internal ones (approval
// limit, duplicate, reading confidence, supplier checks) are not.
const SUPPLIER_REASON = {
  quantity_match: 'The quantity invoiced is more than we have recorded as received.',
  price_match: 'A unit price differs from our purchase order.',
  tax_charged: 'The GST charged does not match the subtotal.',
  supplier_tax_id: 'The invoice does not show a valid ABN.',
  arithmetic: 'The amounts on the invoice do not add up.',
  po_found: 'We could not match the invoice to one of our purchase orders.',
};

export function statusLine(invoice) {
  const head = `Invoice ${invoice.invoiceNumber} (${money(invoice.total)})`;
  const pay = invoice.payment;
  const part = pay && isNum(pay.amount) && isNum(invoice.total) && cents(pay.amount) !== cents(invoice.total);
  if (pay?.status === 'paid') return `${head}: ${part ? `${money(pay.amount)} paid, for the quantity we have received` : 'paid'}${pay.paidOn ? ` on ${day(pay.paidOn)}` : ''}.`;
  if (invoice.status === 'payment_pending') {
    return `${head}: ${part ? `approved for ${money(pay.amount)}, the quantity we have received, and scheduled for payment` : 'approved and scheduled for payment'}${invoice.dueDate ? `, due ${day(invoice.dueDate)}` : ''}.`;
  }
  if (invoice.status === 'approved') {
    const amount = isNum(invoice.approvedAmount) ? invoice.approvedAmount : invoice.total;
    const partApproved = isNum(amount) && isNum(invoice.total) && cents(amount) !== cents(invoice.total);
    return `${head}: ${partApproved ? `approved for ${money(amount)}, the quantity we have received` : 'approved'}. Payment will be scheduled${invoice.dueDate ? ` by the due date, ${day(invoice.dueDate)}` : ''}.`;
  }
  const reasons = (invoice.failedChecks || []).map((c) => SUPPLIER_REASON[c.id]).filter(Boolean);
  return `${head}: received and under review. ${reasons.length ? reasons.join(' ') : 'Our accounts team will contact you if anything is needed.'}`;
}

export function composeReply({ subject, invoices, companyName }) {
  const clean = String(subject || '').trim();
  return {
    subject: /^re:/i.test(clean) ? clean : `Re: ${clean || 'Your invoice query'}`,
    body: [
      'Hello,',
      '',
      invoices.length === 1 ? 'Thank you for your email. Here is the current status of your invoice:' : 'Thank you for your email. Here is the current status of your invoices:',
      '',
      ...invoices.map((i) => `- ${statusLine(i)}`),
      '',
      'Regards,',
      'Accounts Payable',
      companyName,
      '',
      'This reply was prepared automatically from our accounts records.',
    ].join('\n'),
  };
}

/**
 * @param items [{ invoiceNumber, onFile, invoice }] where `invoice` is the
 *              supplier's own invoice with that number, or null.
 */
export function runQueryChecks({ text, understood, reading, vendor, sender, items, policy }) {
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  const pct = (x) => `${Math.round(x * 100)}%`;

  add(
    'sender_known',
    'Sender is an approved supplier',
    vendor ? 'pass' : 'fail',
    vendor ? `${sender} matches the address on file for ${vendor.name}.` : `${sender} does not match the address on file for any approved supplier.`,
  );

  add(
    'request_type',
    'It is a payment status question',
    understood.intent === 'payment_status' ? 'pass' : 'fail',
    understood.intent === 'payment_status' ? 'The supplier is asking about the status of a payment.' : `The email reads as ${INTENT_LABEL[understood.intent] || INTENT_LABEL.other}.`,
  );

  const bank = mentionsBankDetails(text);
  add(
    'no_bank_details',
    'No bank or payment details involved',
    bank ? 'fail' : 'pass',
    bank ? 'The email mentions bank or payment details. Requests like this are never answered automatically.' : 'The email does not mention bank or payment details.',
  );

  const confidence = isNum(reading?.confidence) ? reading.confidence : 0;
  add(
    'reader_confidence',
    'Email was read with enough confidence',
    confidence >= policy.minConfidence ? 'pass' : 'fail',
    confidence >= policy.minConfidence
      ? `Reader confidence ${pct(confidence)} (minimum ${pct(policy.minConfidence)}).`
      : `Reader confidence ${pct(confidence)} is below the ${pct(policy.minConfidence)} minimum.${reading?.notes ? ` ${reading.notes}` : ''}`,
  );

  const named = understood.invoiceNumbers || [];
  if (named.length === 0) add('invoice_named', 'Email names the invoice', 'fail', 'The email does not give an invoice number.');
  else if (named.length > 5) add('invoice_named', 'Email names the invoice', 'fail', `The email lists ${named.length} invoices, which is more than the 5 the agent answers at once.`);
  else add('invoice_named', 'Email names the invoice', 'pass', `Invoice${named.length === 1 ? '' : 's'} mentioned: ${named.join(', ')}.`);

  const missing = items.filter((i) => !i.invoice).map((i) => i.invoiceNumber);
  if (!vendor || named.length === 0) {
    add('invoice_found', "Invoice is on file for this supplier", 'skip', 'Not checked because the sender or the invoice is not identified.');
    add('status_shareable', 'Status can be shared without review', 'skip', 'Not checked because the sender or the invoice is not identified.');
  } else if (missing.length) {
    add('invoice_found', "Invoice is on file for this supplier", 'fail', `Not on file for ${vendor.name}: ${missing.join(', ')}.`);
    add('status_shareable', 'Status can be shared without review', 'skip', 'Not checked because an invoice was not found.');
  } else {
    add('invoice_found', "Invoice is on file for this supplier", 'pass', `Found ${items.length === 1 ? 'the invoice' : `all ${items.length} invoices`} for ${vendor.name}.`);
    const blocked = items.filter((i) => !shareable(i.invoice));
    add(
      'status_shareable',
      'Status can be shared without review',
      blocked.length ? 'fail' : 'pass',
      blocked.length
        ? blocked
            .map((i) => `${i.invoiceNumber} is ${i.invoice.status === 'rejected' ? 'rejected' : i.invoice.payment?.status === 'on_hold' ? 'approved but its payment is on hold' : 'not in a state the agent can report'}, so a person should reply.`)
            .join(' ')
        : 'Every invoice is either approved, paid or under review.',
    );
  }

  return checks;
}

export function decideQuery(checks) {
  const failed = checks.filter((c) => c.status === 'fail');
  return failed.length ? { outcome: 'needs_person', reasons: failed.map((c) => c.detail) } : { outcome: 'auto_answer', reasons: [] };
}
