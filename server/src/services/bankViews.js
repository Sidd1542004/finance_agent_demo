// Stored bank details as each viewer may see them, everywhere they are sent
// back: payment snapshots, simulated bank transactions, payment notices, the
// audit log and the reference data. See agent/finance/beneficiary.js:
//
//   reviewer only            no account details at all
//   payer, approver, admin   masked
//   full details             only through the audited reveal (approver, admin)
//
// Invoice documents (text and PDFs) are not masked: they are what the supplier sent.

import { bankDetailsFor, mask, methodsOf, noticeTextFor, auditTextFor, seesMaskedBankDetails } from '../agent/finance/beneficiary.js';

/** A vendor for GET /api/reference: never its bank details, only whether they are verified. */
export const referenceVendor = (v) => {
  const { beneficiary, ...rest } = v;
  return { ...rest, beneficiary: beneficiary ? { status: beneficiary.status || null, version: beneficiary.version ?? null, methods: methodsOf(beneficiary) } : null };
};

/** The bank-details snapshot a payment keeps ({ version, method, accountName, masked }). */
function snapshotFor(snapshot, viewer) {
  if (!snapshot) return snapshot;
  if (!seesMaskedBankDetails(viewer)) return { version: snapshot.version ?? null, method: snapshot.method ?? null, hidden: true };
  return { ...snapshot, masked: snapshot.masked ? mask(snapshot.masked) : snapshot.masked };
}

export const paymentFor = (payment, viewer) => (payment ? { ...payment, beneficiary: snapshotFor(payment.beneficiary, viewer) } : payment);

export const transactionFor = (txn, viewer) => (txn ? { ...txn, beneficiary: bankDetailsFor(txn.beneficiary, viewer) } : txn);

export const noticeFor = (message, viewer) => (message ? { ...message, body: noticeTextFor(message.body, viewer) } : message);

// Long digit runs in a reason (an account number someone typed): hidden from reviewers.
const hideDigits = (s) => (s ? String(s).replace(/\d[\d\s-]{4,}\d/g, '•••') : s);

/** An audit entry: bank-detail entries (subject "supplier") are masked, or hidden from reviewers. */
export function auditEntryFor(entry, viewer) {
  if (entry?.subjectKind !== 'supplier') return entry;
  return { ...entry, detail: auditTextFor(entry.detail, viewer), reason: seesMaskedBankDetails(viewer) ? entry.reason : hideDigits(entry.reason) };
}
