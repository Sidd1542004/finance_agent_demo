// Bank details on screen, as plain functions (no React), so they can be tested
// with node --test. The server decides what each person may see
// (server/src/agent/finance/beneficiary.js): reviewers get { hidden: true },
// payers, approvers and administrators get masked details, and only an
// audited reveal returns the full ones.

export const HIDDEN_TEXT = 'Hidden for your role. Payers, approvers and administrators see them masked.';

/** Label/value rows for one set of details (masked, full after a reveal, or hidden). */
export function bankDetailRows(d) {
  if (!d) return [];
  if (d.hidden) return [{ label: 'Bank details', value: HIDDEN_TEXT }];
  const rows = [];
  if (d.accountName) rows.push({ label: 'Account name', value: d.accountName });
  if (d.bsb) rows.push({ label: 'BSB and account', value: `${d.bsb} ${d.accountNumber || ''}`.trim() });
  if (d.billerCode) rows.push({ label: 'BPAY', value: `Biller ${d.billerCode}${d.crn ? `, ref ${d.crn}` : ''}` });
  if (d.cardToken) rows.push({ label: 'Card', value: d.cardToken });
  return rows;
}

/** One line for a payment's verified details: "Name BSB 999-••• •••001 (v2)", or hidden. */
export function paidToText(snapshot) {
  if (!snapshot) return null;
  const v = snapshot.version ? ` (v${snapshot.version})` : '';
  if (snapshot.hidden || !snapshot.masked) return `Hidden for your role${v}`;
  const m = snapshot.masked;
  const account = m.bsb ? `BSB ${m.bsb} ${m.accountNumber || ''}` : m.billerCode ? `BPAY ${m.billerCode}` : m.cardToken || '';
  return `${m.accountName || snapshot.accountName || ''} ${account}`.replace(/\s+/g, ' ').trim() + v;
}
