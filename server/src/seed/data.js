// Sample data. Every company, ABN, address and amount here is made up for the
// demo. The ABNs pass the checksum but were generated, not looked up.

const BUYER = 'Meridian Logistics Pty Ltd';

const HARBOUR = { name: 'Harbour Office Supplies Pty Ltd', abn: '57600410275', address: '14 Wharf Street, Fremantle WA 6160', email: 'accounts@harbouroffice.example' };
const PALLETS = { name: 'Southern Cross Pallets Pty Ltd', abn: '37600518342', address: '88 Depot Road, Dandenong South VIC 3175', email: 'ar@southerncrosspallets.example' };
const BLUEGUM = { name: 'Bluegum IT Services Pty Ltd', abn: '36600733916', address: 'Level 3, 210 George Street, Brisbane QLD 4000', email: 'billing@bluegumit.example' };
const COASTAL = { name: 'Coastal Print & Sign Pty Ltd', abn: '11111111111', address: '5 Marina Parade, Wollongong NSW 2500', email: 'hello@coastalprint.example' };

export const vendors = [HARBOUR, PALLETS, BLUEGUM].map((v) => ({ name: v.name, abn: v.abn, email: v.email, gstRegistered: true }));

export const purchaseOrders = [
  {
    poNumber: 'PO-2041',
    vendorAbn: HARBOUR.abn,
    vendorName: HARBOUR.name,
    raisedOn: '2026-09-02',
    lines: [
      { sku: 'PAP-A4-80', description: 'A4 copy paper 80gsm, carton', qty: 20, unitPrice: 42.0 },
      { sku: 'TON-HP-58A', description: 'Toner cartridge HP 58A', qty: 5, unitPrice: 79.0 },
      { sku: 'PEN-BLK-50', description: 'Ballpoint pens black, box of 50', qty: 4, unitPrice: 10.0 },
    ],
  },
  {
    poNumber: 'PO-2042',
    vendorAbn: PALLETS.abn,
    vendorName: PALLETS.name,
    raisedOn: '2026-09-08',
    lines: [
      { sku: 'PAL-STD-1200', description: 'Standard timber pallet 1200 x 1000', qty: 12, unitPrice: 38.5 },
      { sku: 'WRAP-500', description: 'Stretch wrap 500mm roll', qty: 30, unitPrice: 9.2 },
    ],
  },
  {
    poNumber: 'PO-2043',
    vendorAbn: BLUEGUM.abn,
    vendorName: BLUEGUM.name,
    raisedOn: '2026-09-10',
    lines: [
      { sku: 'LAP-14-I5', description: '14-inch laptop, i5, 16GB', qty: 10, unitPrice: 1450.0 },
      { sku: 'DOCK-USBC', description: 'USB-C docking station', qty: 10, unitPrice: 189.0 },
    ],
  },
  {
    poNumber: 'PO-2044',
    vendorAbn: HARBOUR.abn,
    vendorName: HARBOUR.name,
    raisedOn: '2026-09-15',
    lines: [
      { sku: 'CHR-ERG-01', description: 'Ergonomic task chair', qty: 6, unitPrice: 245.0 },
      { sku: 'DSK-SIT-16', description: 'Sit-stand desk 1600mm', qty: 2, unitPrice: 520.0 },
    ],
  },
  {
    poNumber: 'PO-2045',
    vendorAbn: PALLETS.abn,
    vendorName: PALLETS.name,
    raisedOn: '2026-09-22',
    lines: [{ sku: 'PAL-STD-1200', description: 'Standard timber pallet 1200 x 1000', qty: 20, unitPrice: 38.5 }],
  },
];

// Everything was delivered in full except PO-2042, where 10 of 12 pallets arrived.
export const goodsReceipts = [
  {
    poNumber: 'PO-2041',
    receivedOn: '2026-09-11',
    lines: [
      { sku: 'PAP-A4-80', qty: 20 },
      { sku: 'TON-HP-58A', qty: 5 },
      { sku: 'PEN-BLK-50', qty: 4 },
    ],
  },
  {
    poNumber: 'PO-2042',
    receivedOn: '2026-09-17',
    lines: [
      { sku: 'PAL-STD-1200', qty: 10 },
      { sku: 'WRAP-500', qty: 30 },
    ],
  },
  {
    poNumber: 'PO-2043',
    receivedOn: '2026-09-24',
    lines: [
      { sku: 'LAP-14-I5', qty: 10 },
      { sku: 'DOCK-USBC', qty: 10 },
    ],
  },
  {
    poNumber: 'PO-2044',
    receivedOn: '2026-09-25',
    lines: [
      { sku: 'CHR-ERG-01', qty: 6 },
      { sku: 'DSK-SIT-16', qty: 2 },
    ],
  },
  { poNumber: 'PO-2045', receivedOn: '2026-09-30', lines: [{ sku: 'PAL-STD-1200', qty: 20 }] },
];

// Sample invoices, one per situation the agent has to handle.
// `expect` is the status the agent should leave the invoice in, and the checks
// that should fail; the tests check it. The agent never approves: a clean
// invoice ends as "under_review" (eligible for approval, waiting for a person).
export const sampleInvoices = [
  {
    id: 'clean',
    title: 'Matches its purchase order',
    hint: 'Scores 100% and goes to Under Review: eligible for approval, but a person still approves it. Send it twice to see duplicate detection.',
    expect: { outcome: 'under_review', failed: [] },
    vendor: HARBOUR,
    invoiceNumber: 'HOS-10482',
    invoiceDate: '14 Sep 2026',
    dueDate: '14 Oct 2026',
    poNumber: 'PO-2041',
    lines: [
      { sku: 'PAP-A4-80', description: 'A4 copy paper 80gsm, carton', qty: 20, unitPrice: 42.0 },
      { sku: 'TON-HP-58A', description: 'Toner cartridge HP 58A', qty: 5, unitPrice: 79.0 },
      { sku: 'PEN-BLK-50', description: 'Ballpoint pens black, box of 50', qty: 4, unitPrice: 10.0 },
    ],
  },
  {
    id: 'quantity-variance',
    title: 'Bills for more than was delivered',
    hint: '12 pallets invoiced, 10 received. On hold; a person can approve the received quantity only.',
    expect: { outcome: 'on_hold', failed: ['quantity_match'] },
    vendor: PALLETS,
    invoiceNumber: 'SCP-7731',
    invoiceDate: '18 Sep 2026',
    dueDate: '18 Oct 2026',
    poNumber: 'PO-2042',
    lines: [
      { sku: 'PAL-STD-1200', description: 'Standard timber pallet 1200 x 1000', qty: 12, unitPrice: 38.5 },
      { sku: 'WRAP-500', description: 'Stretch wrap 500mm roll', qty: 30, unitPrice: 9.2 },
    ],
  },
  {
    id: 'price-variance',
    title: 'Price is higher than agreed',
    hint: 'Chairs invoiced 8% above the purchase order price.',
    expect: { outcome: 'on_hold', failed: ['price_match', 'match_score'] },
    vendor: HARBOUR,
    invoiceNumber: 'HOS-10517',
    invoiceDate: '26 Sep 2026',
    dueDate: '26 Oct 2026',
    poNumber: 'PO-2044',
    lines: [
      { sku: 'CHR-ERG-01', description: 'Ergonomic task chair', qty: 6, unitPrice: 264.6 },
      { sku: 'DSK-SIT-16', description: 'Sit-stand desk 1600mm', qty: 2, unitPrice: 520.0 },
    ],
  },
  {
    id: 'gst-error',
    title: 'GST is calculated wrongly',
    hint: 'GST shown is $70.00; 10% of the subtotal is $77.00.',
    expect: { outcome: 'on_hold', failed: ['tax_charged'] },
    vendor: PALLETS,
    invoiceNumber: 'SCP-7790',
    invoiceDate: '1 Oct 2026',
    dueDate: '31 Oct 2026',
    poNumber: 'PO-2045',
    gst: 70.0,
    lines: [{ sku: 'PAL-STD-1200', description: 'Standard timber pallet 1200 x 1000', qty: 20, unitPrice: 38.5 }],
  },
  {
    id: 'over-limit',
    title: 'Correct, a large amount',
    hint: 'Everything matches. $18,029.00 is still only eligible for approval: nothing is ever approved automatically.',
    expect: { outcome: 'under_review', failed: [] },
    vendor: BLUEGUM,
    invoiceNumber: 'BG-2026-0914',
    invoiceDate: '25 Sep 2026',
    dueDate: '25 Oct 2026',
    poNumber: 'PO-2043',
    lines: [
      { sku: 'LAP-14-I5', description: '14-inch laptop, i5, 16GB', qty: 10, unitPrice: 1450.0 },
      { sku: 'DOCK-USBC', description: 'USB-C docking station', qty: 10, unitPrice: 189.0 },
    ],
  },
  {
    id: 'unknown-supplier',
    title: 'Unknown supplier with an invalid ABN',
    hint: 'The ABN fails the checksum and the purchase order does not exist.',
    expect: { outcome: 'needs_review', failed: ['supplier_tax_id', 'supplier_known', 'po_found', 'match_score'] },
    vendor: COASTAL,
    invoiceNumber: 'CPS-0388',
    invoiceDate: '29 Sep 2026',
    dueDate: '13 Oct 2026',
    poNumber: 'PO-2099',
    lines: [{ sku: 'BAN-PVC-3M', description: 'PVC banner 3m, printed', qty: 4, unitPrice: 185.0 }],
  },
  {
    id: 'no-po',
    title: 'No purchase order quoted',
    hint: 'A known supplier, but nothing to match the invoice against.',
    expect: { outcome: 'needs_review', failed: ['po_found', 'match_score'] },
    vendor: BLUEGUM,
    invoiceNumber: 'BG-2026-0951',
    invoiceDate: '2 Oct 2026',
    dueDate: '1 Nov 2026',
    poNumber: null,
    lines: [{ sku: 'SUP-HR-02', description: 'On-site support, per hour', qty: 6, unitPrice: 140.0 }],
  },
];

const dollars = (n) => `$${n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (n) => Math.round(n * 100) / 100;

export function sampleTotals(sample) {
  const subtotal = round2(sample.lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0));
  const gst = sample.gst ?? round2(subtotal * 0.1);
  return { subtotal, gst, total: round2(subtotal + gst) };
}

// Lay a sample out the way a text invoice (or the text layer of a PDF) reads.
export function renderInvoiceText(sample) {
  const { subtotal, gst, total } = sampleTotals(sample);
  const abn = sample.vendor.abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4');
  const row = (a, b, c, d, e) => `${a.padEnd(14)}${b.padEnd(38)}${c.padStart(5)}${d.padStart(14)}${e.padStart(14)}`;
  return [
    sample.vendor.name,
    `ABN ${abn}`,
    sample.vendor.address,
    sample.vendor.email,
    '',
    'TAX INVOICE',
    '',
    `Invoice number: ${sample.invoiceNumber}`,
    `Invoice date: ${sample.invoiceDate}`,
    `Due date: ${sample.dueDate}`,
    ...(sample.poNumber ? [`Purchase order: ${sample.poNumber}`] : []),
    `Bill to: ${BUYER}`,
    '',
    row('Item', 'Description', 'Qty', 'Unit price', 'Amount'),
    ...sample.lines.map((l) => row(l.sku, l.description, String(l.qty), dollars(l.unitPrice), dollars(round2(l.qty * l.unitPrice)))),
    '',
    `Subtotal (ex GST): ${dollars(subtotal)}`,
    `GST (10%): ${dollars(gst)}`,
    `Total (inc GST): ${dollars(total)}`,
    '',
    'Payment terms: 30 days from invoice date',
  ].join('\n');
}

export const findSample = (id) => sampleInvoices.find((s) => s.id === id) || null;

// ---------- Supplier emails (vendor queries) ----------
// These refer to the sample invoices above, so load the demo month (or process
// those invoices) first. `expect` is what the agent should decide after the
// demo month is loaded; the tests check it.

export const sampleQueries = [
  {
    id: 'status-approved',
    title: 'Asks when an approved invoice will be paid',
    hint: 'Known supplier, their own invoice, a plain status question. Answered without a person.',
    expect: { outcome: 'auto_answered', failed: [] },
    from: `Dana Whitfield <${HARBOUR.email}>`,
    subject: 'Payment status: invoice HOS-10482',
    body: 'Hi,\n\nCould you let us know when invoice HOS-10482 will be paid? Our records show it as outstanding.\n\nThanks,\nDana\nHarbour Office Supplies',
  },
  {
    id: 'status-two',
    title: 'Asks about two invoices, one under review',
    hint: 'One is approved and one is held for a price difference. The reply says so.',
    expect: { outcome: 'auto_answered', failed: [] },
    from: `Dana Whitfield <${HARBOUR.email}>`,
    subject: 'Two invoices outstanding',
    body: 'Hello,\n\nWe have two invoices outstanding with you: HOS-10482 and HOS-10517. When can we expect payment for each?\n\nRegards,\nDana',
  },
  {
    id: 'bank-change',
    title: 'Asks to change bank details',
    hint: 'A common fraud route. Never answered automatically.',
    expect: { outcome: 'needs_person', failed: ['request_type', 'no_bank_details'] },
    from: `Accounts <${HARBOUR.email}>`,
    subject: 'Updated payment details',
    body: 'Hi,\n\nWe have changed banks. Please pay invoice HOS-10482 and all future invoices to our new account: BSB 000-000, account number 0000 0000.\n\nThanks,\nAccounts team',
  },
  {
    id: 'lookalike-sender',
    title: 'Comes from an address that is not on file',
    hint: 'The address looks like Harbour Office Supplies but is not theirs. Nothing is disclosed.',
    expect: { outcome: 'needs_person', failed: ['sender_known'] },
    from: 'Dana Whitfield <accounts@harbour-office.example>',
    subject: 'Payment status: invoice HOS-10482',
    body: 'Hi,\n\nCan you confirm the amount and payment date for invoice HOS-10482?\n\nThanks,\nDana',
  },
  {
    id: 'dispute',
    title: 'Disputes a late payment',
    hint: 'A complaint, not a status question. Goes to a person.',
    expect: { outcome: 'needs_person', failed: ['request_type'] },
    from: `Billing <${BLUEGUM.email}>`,
    subject: 'Overdue invoice BG-2026-0914',
    body: 'Hello,\n\nInvoice BG-2026-0914 is now overdue. We dispute the delay and will add late fees unless it is paid this week.\n\nBluegum IT Services billing',
  },
];

export const findSampleQuery = (id) => sampleQueries.find((q) => q.id === id) || null;

// ---------- Bank statement (bank reconciliation) ----------
// Refers to the demo month: HOS-10482 approved by a person, SCP-7731 approved
// by a person for the 10 pallets received ($727.10 of $811.80), BG-2026-0914
// still waiting for approval.

export const sampleStatement = {
  id: 'october',
  title: 'Operating account, 1 to 6 October 2026',
  hint: 'Two payments match. One looks like a double payment, one pays an invoice nobody approved, and one is a bank fee.',
  filename: 'bank-statement-october.csv',
  csv: [
    'Date,Description,Amount',
    '02/10/2026,HARBOUR OFFICE SUP HOS-10482,-1402.50',
    '03/10/2026,SOUTHERN CROSS PALLETS PAYMENT,-727.10',
    '03/10/2026,ACCOUNT KEEPING FEE,-12.50',
    '05/10/2026,BLUEGUM IT SERVICES BG-2026-0914,-18029.00',
    '06/10/2026,SOUTHERN CROSS PALLETS SCP-7731,-727.10',
    '06/10/2026,DEPOSIT CUSTOMER RECEIPT 5521,2400.00',
  ].join('\n'),
};
