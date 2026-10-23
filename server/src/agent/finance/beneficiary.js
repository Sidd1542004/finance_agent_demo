// Supplier beneficiary (bank) details: what is accepted, how it is shown, and
// whether a payment may use it. Plain functions, no database.
//
// Only SIMULATED details are accepted: a BSB in the simulated range (default
// 999-xxx), BPAY biller codes and references made of digits, and synthetic
// card tokens (SIMCARD-...). The simulated bank refuses anything else too.
// Details change only by a proposal from one person approved by another
// (services/beneficiaries.js); never from an email or an AI suggestion.

export const BANK_METHODS = ['EFT', 'BPAY', 'Card'];

const digits = (v) => String(v ?? '').replace(/[\s-]/g, '');
const text = (v, max) =>
  String(v ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max);

/**
 * Check proposed details. Returns { details, problems }. `details` keeps only
 * known fields, in a standard format (BSB as 999-123).
 */
export function normaliseDetails(input = {}, { bsbPrefix = '999' } = {}) {
  const problems = [];
  const details = { accountName: text(input.accountName, 80) };
  if (!details.accountName) problems.push('Enter the account name.');

  const bsb = digits(input.bsb);
  const account = digits(input.accountNumber);
  if (bsb || account) {
    if (!/^\d{6}$/.test(bsb)) problems.push('The BSB must be 6 digits.');
    else if (!bsb.startsWith(bsbPrefix)) problems.push(`Only simulated BSBs starting with ${bsbPrefix} are accepted. Real bank details are never stored here.`);
    if (!/^\d{6,9}$/.test(account)) problems.push('The account number must be 6 to 9 digits.');
    details.bsb = `${bsb.slice(0, 3)}-${bsb.slice(3)}`;
    details.accountNumber = account;
  }
  const biller = digits(input.billerCode);
  const crn = digits(input.crn);
  if (biller || crn) {
    if (!/^\d{3,10}$/.test(biller)) problems.push('The BPAY biller code must be 3 to 10 digits.');
    if (!/^\d{2,20}$/.test(crn)) problems.push('The BPAY reference (CRN) must be 2 to 20 digits.');
    details.billerCode = biller;
    details.crn = crn;
  }
  const card = String(input.cardToken ?? '')
    .trim()
    .toUpperCase();
  if (card) {
    if (!/^SIMCARD-[A-Z0-9]{4,24}$/.test(card)) problems.push('A card must be a simulated card token, like SIMCARD-4242.');
    details.cardToken = card;
  }
  if (!problems.length && !methodsOf(details).length) problems.push('Enter bank account (BSB and account number), BPAY or simulated card details.');
  return { details, problems };
}

/** The payment methods these details can be paid by. */
export function methodsOf(details) {
  if (!details) return [];
  const out = [];
  if (details.bsb && details.accountNumber) out.push('EFT');
  if (details.billerCode && details.crn) out.push('BPAY');
  if (details.cardToken) out.push('Card');
  return out;
}

const last = (s, n) => (s ? `•••${String(s).slice(-n)}` : null);

/** Details safe to show anyone and to write in the audit log. */
export function mask(details) {
  if (!details) return null;
  return {
    accountName: details.accountName || null,
    bsb: details.bsb || null,
    accountNumber: last(details.accountNumber, 3),
    billerCode: details.billerCode || null,
    crn: last(details.crn, 3),
    cardToken: details.cardToken ? `SIMCARD-${last(details.cardToken.replace(/^SIMCARD-/, ''), 4)}` : null,
    methods: methodsOf(details),
  };
}

export function maskedText(details) {
  const m = mask(details);
  if (!m) return 'none';
  const parts = [m.accountName];
  if (m.bsb) parts.push(`BSB ${m.bsb} account ${m.accountNumber}`);
  if (m.billerCode) parts.push(`BPAY ${m.billerCode} ref ${m.crn}`);
  if (m.cardToken) parts.push(`card ${m.cardToken}`);
  return `${parts.join(', ')} (simulated)`;
}

/** 'verified' | 'change_pending' | 'unverified' */
export function beneficiaryState(vendor, pending) {
  if (pending) return 'change_pending';
  return vendor?.beneficiary?.status === 'verified' ? 'verified' : 'unverified';
}

/**
 * Why a bank payment to this supplier by this method cannot be submitted, or null.
 * `pending`: a change is waiting for approval (payments are blocked until it is decided).
 */
export function beneficiaryBlock(vendor, pending, method) {
  if (!vendor) return 'The supplier is not on file, so there are no verified bank details to pay.';
  if (pending) return `A change to ${vendor.name}'s bank details is waiting for approval. Payments are blocked until it is approved or rejected.`;
  if (vendor.beneficiary?.status !== 'verified') return `${vendor.name} has no verified bank details. Propose them on the Suppliers screen; a second person must approve them.`;
  if (method && !methodsOf(vendor.beneficiary).includes(method))
    return `${vendor.name}'s verified details cannot be paid by ${method}. Choose ${methodsOf(vendor.beneficiary).join(' or ')}.`;
  return null;
}

/** The snapshot kept on a payment: which verified version it was scheduled against. */
export const beneficiarySnapshot = (vendor, method) => ({
  version: vendor.beneficiary.version,
  method,
  accountName: vendor.beneficiary.accountName,
  masked: mask(vendor.beneficiary),
});
