// Vendor queries, bank reconciliation and month-end reporting, end to end on
// an in-memory ledger. No database, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent } from '../src/agent/finance/invoiceAgent.js';
import { extractWithRules } from '../src/agent/finance/extract.js';
import { createVendorQueryAgent } from '../src/agent/finance/vendorQueryAgent.js';
import { readWithRules, readWithGroq, findInvoiceRefs } from '../src/agent/finance/readQuery.js';
import { senderMatchesVendor, mentionsBankDetails, composeReply, statusLine } from '../src/agent/finance/queryRules.js';
import { createReconciliationAgent } from '../src/agent/finance/reconciliationAgent.js';
import { parseStatement, parseAmount, matchLines, refInDescription, vendorInDescription } from '../src/agent/finance/reconcileRules.js';
import { explainLines } from '../src/agent/finance/reconcileNotes.js';
import { createReportAgent } from '../src/agent/finance/reportAgent.js';
import { buildFigures, checkFigures, compareMonths, previousMonth, templateCommentary, ungroundedNumbers, figuresToCsv, monthRange, isMonth } from '../src/agent/finance/reportFigures.js';
import { createInvoiceActions } from '../src/services/invoiceActions.js';
import { receivedOnly } from '../src/agent/finance/rules.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { vendors, purchaseOrders, goodsReceipts, sampleInvoices, renderInvoiceText, sampleQueries, findSampleQuery, sampleStatement } from '../src/seed/data.js';

const policy = { matchThreshold: 85, missingAbn: 'review', priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };
const companyName = 'Meridian Logistics Pty Ltd';
const failedIds = (record) => record.checks.filter((c) => c.status === 'fail').map((c) => c.id);
const fakeGroq = (payload) => ({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) }) });

// The same state "Load demo month" produces: seven sample invoices, one sent
// twice; a person approves the clean invoice and the received quantity of the
// pallets invoice and schedules both payments (simulated), and rejects the GST
// error. The agent itself approves nothing.
async function demoMonth() {
  const invoices = [];
  const queries = [];
  const statements = [];
  const ledger = createMemoryLedger({ vendors, purchaseOrders, goodsReceipts, invoices, queries, statements });
  const agent = createInvoiceAgent({ ledger, extract: async (text) => extractWithRules(text), policy, save: async () => {}, today: () => '2026-10-01' });
  let n = 0;
  const byId = {};
  for (const sample of [...sampleInvoices, sampleInvoices[0]]) {
    n += 1;
    const invoice = { id: `inv-${n}`, createdAt: new Date(2026, 9, 1, 9, n), source: { kind: 'sample' }, rawText: renderInvoiceText(sample), status: 'received' };
    invoices.push(invoice);
    await runAgent(agent, { invoice });
    byId[sample.id] ??= invoice;
  }
  const actions = createInvoiceActions({ store: ledger, policy, rerun: async () => {} });
  const by = { decidedBy: 'Priya N' };
  await actions.perform(byId.clean.id, 'approve', by);
  await actions.perform(byId.clean.id, 'schedule_payment', { decidedBy: 'Sam K', method: 'EFT' });
  await actions.perform(byId['quantity-variance'].id, 'approve_received', by);
  await actions.perform(byId['quantity-variance'].id, 'schedule_payment', { decidedBy: 'Sam K', method: 'EFT' });
  await actions.perform(byId['gst-error'].id, 'reject', { ...by, note: 'GST is wrong.' });
  return { ledger, invoices, queries, statements, byId, actions };
}

// ---------- Vendor queries ----------

test('sender matching: exact address, same company domain, never a shared mail provider', () => {
  assert.equal(senderMatchesVendor('Dana <ACCOUNTS@harbouroffice.example>', 'accounts@harbouroffice.example'), true);
  assert.equal(senderMatchesVendor('dana@harbouroffice.example', 'accounts@harbouroffice.example'), true);
  assert.equal(senderMatchesVendor('accounts@harbour-office.example', 'accounts@harbouroffice.example'), false);
  assert.equal(senderMatchesVendor('someone@gmail.com', 'harbouroffice@gmail.com'), false);
  assert.equal(senderMatchesVendor('harbouroffice@gmail.com', 'harbouroffice@gmail.com'), true);
  assert.equal(senderMatchesVendor('not an address', 'accounts@harbouroffice.example'), false);
});

test('bank detail tripwire and invoice number finder', () => {
  assert.equal(mentionsBankDetails('Please use our new account from now on'), true);
  assert.equal(mentionsBankDetails('BSB 000-000'), true);
  assert.equal(mentionsBankDetails('Please send a remittance advice when paid'), false);
  assert.deepEqual(findInvoiceRefs('Re HOS-10482 and BG-2026-0914 against PO-2041, also invoice 77120'), ['HOS-10482', 'BG-2026-0914', '77120']);
});

test('the reply only passes on reasons the supplier can act on', () => {
  const held = { invoiceNumber: 'A-1', total: 100, status: 'on_hold', failedChecks: [{ id: 'price_match' }, { id: 'match_score' }, { id: 'duplicate' }] };
  assert.equal(statusLine(held), 'Invoice A-1 ($100.00): received and under review. A unit price differs from our purchase order.');
  const internal = { ...held, failedChecks: [{ id: 'match_score' }] };
  assert.match(statusLine(internal), /under review\. Our accounts team will contact you/);
  const paid = { invoiceNumber: 'A-2', total: 50, status: 'payment_completed', payment: { status: 'paid', paidOn: '2026-10-02' } };
  assert.equal(statusLine(paid), 'Invoice A-2 ($50.00): paid on 2 Oct 2026.');
  const reply = composeReply({ subject: 'Re: status', invoices: [paid], companyName });
  assert.equal(reply.subject, 'Re: status');
  assert.ok(reply.body.includes(companyName));
});

async function runQuery(setup, email, read = async (e) => readWithRules(e)) {
  const agent = createVendorQueryAgent({ ledger: setup.ledger, read, policy, companyName, save: async () => {} });
  const query = { id: `q-${setup.queries.length + 1}`, createdAt: new Date(2026, 9, 2), status: 'received', ...email };
  setup.queries.push(query);
  const result = await runAgent(agent, { query });
  return { query, result };
}

for (const sample of sampleQueries) {
  test(`supplier email "${sample.id}" -> ${sample.expect.outcome}`, async () => {
    const setup = await demoMonth();
    const { query, result } = await runQuery(setup, { from: sample.from, subject: sample.subject, body: sample.body });
    assert.equal(result.outcome, sample.expect.outcome);
    assert.deepEqual(failedIds(query), sample.expect.failed);
    assert.equal(result.error, null);
    if (sample.expect.outcome === 'auto_answered') {
      assert.equal(query.status, 'answered');
      assert.deepEqual(setup.ledger.messages.map((m) => m.status), ['sent']);
    } else {
      assert.equal(query.status, 'needs_person');
      assert.equal(setup.ledger.messages.length, 0, 'nothing may be sent for a held email');
    }
  });
}

test('the automatic reply is built from the records', async () => {
  const setup = await demoMonth();
  const sample = findSampleQuery('status-two');
  await runQuery(setup, sample);
  const [message] = setup.ledger.messages;
  assert.equal(message.to, 'accounts@harbouroffice.example');
  assert.match(message.body, /Invoice HOS-10482 \(\$1,402\.50\): approved and scheduled for payment, due 14 Oct 2026\./);
  assert.match(message.body, /Invoice HOS-10517 \(\$2,890\.36\): received and under review\. A unit price differs from our purchase order\./);
});

test('an unknown sender gets no draft and no invoice details', async () => {
  const setup = await demoMonth();
  const { query } = await runQuery(setup, findSampleQuery('lookalike-sender'));
  assert.equal(query.draft, null);
  assert.deepEqual(query.matchedInvoices, [{ invoiceNumber: 'HOS-10482', onFile: true, belongsToSender: false, status: null, total: null, dueDate: null, paymentStatus: null, paidOn: null }]);
});

test("a supplier cannot get the status of another supplier's invoice", async () => {
  const setup = await demoMonth();
  const { query, result } = await runQuery(setup, { from: 'ar@southerncrosspallets.example', subject: 'Status', body: 'When will invoice HOS-10482 be paid?' });
  assert.equal(result.outcome, 'needs_person');
  assert.deepEqual(failedIds(query), ['invoice_found']);
  assert.equal(query.draft, null);
});

test('rejected invoices and unknown invoice numbers go to a person', async () => {
  const setup = await demoMonth();
  const rejected = await runQuery(setup, { from: 'ar@southerncrosspallets.example', subject: 'Status', body: 'When will invoice SCP-7790 be paid?' });
  assert.deepEqual(failedIds(rejected.query), ['status_shareable']);
  const unknown = await runQuery(setup, { from: 'ar@southerncrosspallets.example', subject: 'Status', body: 'When will invoice SCP-9999 be paid?' });
  assert.deepEqual(failedIds(unknown.query), ['invoice_found']);
  const none = await runQuery(setup, { from: 'ar@southerncrosspallets.example', subject: 'Status', body: 'When will you pay us what is outstanding?' });
  assert.deepEqual(failedIds(none.query), ['invoice_named']);
  assert.equal(setup.ledger.messages.length, 0);
});

test('an AI reader that is talked into the wrong answer is still stopped by the fixed rules', async () => {
  const setup = await demoMonth();
  const sample = findSampleQuery('bank-change');
  // The model wrongly says this is a plain status question, and invents an invoice number.
  const read = (email) => readWithGroq(email, { apiKey: 'k', model: 'm', ...fakeGroq({ intent: 'payment_status', invoiceNumbers: ['HOS-10482', 'HOS-99999'], summary: 'x', confidence: 0.99 }) });
  const { query, result } = await runQuery(setup, sample, read);
  assert.equal(result.outcome, 'needs_person');
  assert.deepEqual(failedIds(query), ['no_bank_details', 'reader_confidence']);
  assert.deepEqual(query.understood.invoiceNumbers, ['HOS-10482'], 'the invented number is dropped');
  assert.equal(query.draft, null);
  assert.equal(setup.ledger.messages.length, 0);
});

test('if the reader fails, the email is flagged and nothing is sent', async () => {
  const setup = await demoMonth();
  const { query, result } = await runQuery(setup, findSampleQuery('status-approved'), async () => { throw new Error('Groq rate limit reached.'); });
  assert.equal(result.outcome, 'failed');
  assert.equal(query.status, 'failed');
  assert.equal(setup.ledger.messages.length, 0);
});

// ---------- Bank reconciliation ----------

test('statement amounts and layouts', () => {
  assert.equal(parseAmount('-1,402.50'), -1402.5);
  assert.equal(parseAmount('($811.80)'), -811.8);
  assert.equal(parseAmount('12.50 DR'), -12.5);
  assert.equal(parseAmount('2400'), 2400);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount('1.2.3'), null);

  const split = parseStatement('Date,Narrative,Debit,Credit\r\n02/10/2026,"SMITH, J & CO",50.00,\r\n03/10/2026,Deposit,,75.00\r\n');
  assert.deepEqual(split, [
    { n: 1, date: '2026-10-02', description: 'SMITH, J & CO', amount: -50 },
    { n: 2, date: '2026-10-03', description: 'Deposit', amount: 75 },
  ]);
  assert.throws(() => parseStatement('Date,Description,Amount\n02/10/2026,Fee,twelve'), /Line 1: the amount "twelve" is not a number/);
  assert.throws(() => parseStatement('When,What\n1,2'), /needs columns for date, description and amount/);
  assert.throws(() => parseStatement('Date,Description,Amount'), /no transactions/);
});

test('references and shortened supplier names in bank descriptions', () => {
  assert.equal(refInDescription('HARBOUR OFFICE HOS10482', 'HOS-10482'), true);
  assert.equal(refInDescription('PAYMENT 12', 'A-12'), false, 'too short to trust');
  assert.equal(vendorInDescription('HARBOUR OFFICE SUP', 'Harbour Office Supplies Pty Ltd'), true);
  assert.equal(vendorInDescription('SOUTHERN PHONE CO', 'Southern Cross Pallets Pty Ltd'), false, 'one shared word is not enough');
  assert.equal(vendorInDescription('ACCOUNT KEEPING FEE', 'Bluegum IT Services Pty Ltd'), false);
});

const pay = (id, invoiceNumber, vendorName, amount, extra = {}) => ({ id, invoiceNumber, vendorName, amount, status: 'queued', paidOn: null, bank: null, ...extra });

test('matching rules, one case each', () => {
  const payments = [pay('p1', 'HOS-10482', 'Harbour Office Supplies Pty Ltd', 1402.5), pay('p2', 'SCP-7731', 'Southern Cross Pallets Pty Ltd', 811.8), pay('p3', 'BG-2026-0951', 'Bluegum IT Services Pty Ltd', 924), pay('p4', 'HOS-10500', 'Harbour Office Supplies Pty Ltd', 300, { status: 'on_hold' })];
  const lines = parseStatement(
    ['Date,Description,Amount', '01/10/2026,HOS-10482 HARBOUR,-1402.50', '01/10/2026,SOUTHERN CROSS PALLETS,-811.80', '01/10/2026,TRANSFER 0091,-924.00', '01/10/2026,HOS-10482 HARBOUR,-1402.50', '01/10/2026,HOS-10500,-300.00', '01/10/2026,INTEREST,3.10'].join('\n'),
  );
  const { lines: out, unpaid } = matchLines(lines, payments, []);
  assert.deepEqual(out.map((l) => [l.status, l.kind || l.method]), [
    ['matched', 'invoice number and amount'],
    ['matched', 'supplier name and amount'],
    ['suggested', 'amount_only'],
    ['exception', 'duplicate'],
    ['exception', 'on_hold'],
    ['skipped', null],
  ]);
  assert.equal(out[2].candidate.paymentId, 'p3');
  assert.deepEqual(unpaid.map((u) => u.invoiceNumber), ['BG-2026-0951'], 'a suggestion is not a payment until a person confirms it');
});

test('amount differences, ambiguity and already-paid invoices', () => {
  const short = matchLines(parseStatement('Date,Description,Amount\n01/10/2026,HOS-10482,-1400.00'), [pay('p1', 'HOS-10482', 'Harbour Office Supplies Pty Ltd', 1402.5)], []);
  assert.equal(short.lines[0].kind, 'amount_differs');
  assert.match(short.lines[0].reason, /bank shows \$1,400\.00, but invoice HOS-10482 was approved for \$1,402\.50/);

  const twins = [pay('a', 'SCP-1', 'Southern Cross Pallets Pty Ltd', 770), pay('b', 'SCP-2', 'Southern Cross Pallets Pty Ltd', 770)];
  assert.equal(matchLines(parseStatement('Date,Description,Amount\n01/10/2026,SOUTHERN CROSS PALLETS,-770.00'), twins, []).lines[0].kind, 'ambiguous');

  const paid = [pay('p1', 'HOS-10482', 'Harbour Office Supplies Pty Ltd', 1402.5, { status: 'paid', paidOn: '2026-10-02', bank: { date: '2026-10-02', description: 'HOS-10482 HARBOUR' } })];
  const again = matchLines(parseStatement('Date,Description,Amount\n02/10/2026,HOS-10482 HARBOUR,-1402.50\n09/10/2026,HOS-10482 HARBOUR,-1402.50'), paid, []);
  assert.match(again.lines[0].reason, /same bank line that already paid invoice HOS-10482 in an earlier statement/);
  assert.match(again.lines[1].reason, /already paid on 2 Oct 2026\. Possible double payment/);
});

async function runStatement(setup, csv, { explain = null, ledger = setup.ledger } = {}) {
  const agent = createReconciliationAgent({ ledger, explain, save: async () => {} });
  const statement = { id: `st-${setup.statements.length + 1}`, createdAt: new Date(2026, 9, 7), source: { kind: 'sample' }, rawText: csv, status: 'received' };
  setup.statements.push(statement);
  const result = await runAgent(agent, { statement });
  return { statement, result };
}

test('the sample statement: two payments matched, three lines for a person, one skipped', async () => {
  const setup = await demoMonth();
  const { statement, result } = await runStatement(setup, sampleStatement.csv);

  assert.equal(result.outcome, 'needs_person');
  assert.deepEqual(statement.lines.map((l) => [l.n, l.status, l.kind]), [
    [1, 'matched', null],
    [2, 'exception', 'duplicate'],
    [3, 'unmatched', null],
    [4, 'exception', 'not_approved'],
    [5, 'matched', null],
    [6, 'skipped', null],
  ]);
  assert.match(statement.lines[1].reason, /line 5 of this statement already pays/);
  assert.match(statement.lines[3].reason, /BG-2026-0914, which is not approved for payment \(it is under review\)/);
  assert.deepEqual(setup.ledger.payments.map((p) => [p.invoiceNumber, p.status, p.paidOn]), [
    ['HOS-10482', 'paid', '2026-10-02'],
    ['SCP-7731', 'paid', '2026-10-06'],
  ]);
  assert.equal(statement.decision.reasons.length, 3);
  assert.deepEqual(statement.unpaid, []);
});

test('the same statement again pays nothing twice', async () => {
  const setup = await demoMonth();
  await runStatement(setup, sampleStatement.csv);
  const { statement } = await runStatement(setup, sampleStatement.csv);
  assert.equal(statement.lines.filter((l) => l.status === 'matched').length, 0);
  assert.match(statement.lines[0].reason, /same bank line that already paid invoice HOS-10482/);
  assert.equal(setup.ledger.payments.filter((p) => p.status === 'paid').length, 2);
});

test('a statement that cannot be read is flagged and marks nothing as paid', async () => {
  const setup = await demoMonth();
  const { statement, result } = await runStatement(setup, 'Date,Description,Amount\n02/10/2026,HOS-10482,lots');
  assert.equal(result.outcome, 'failed');
  assert.equal(statement.status, 'failed');
  assert.equal(setup.ledger.payments.filter((p) => p.status === 'paid').length, 0);
});

test('verify undoes everything if the payments marked as paid do not agree with the statement', async () => {
  const setup = await demoMonth();
  // A faulty connection that reports success for a payment it did not mark.
  let calls = 0;
  const ledger = { ...setup.ledger, markPaid: async (id, bank) => (++calls === 1 ? { id } : setup.ledger.markPaid(id, bank)) };
  const { statement, result } = await runStatement(setup, sampleStatement.csv, { ledger });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error.stage, 'verify');
  assert.equal(statement.status, 'failed');
  assert.equal(setup.ledger.payments.filter((p) => p.status === 'paid').length, 0, 'nothing left marked as paid');
});

test('AI notes are attached to open lines only, and a failure does not stop the run', async () => {
  const setup = await demoMonth();
  const explain = (lines) => explainLines(lines, { apiKey: 'k', model: 'm', ...fakeGroq({ notes: [{ n: 3, note: 'Monthly bank account fee.' }, { n: 1, note: 'should be ignored' }, { n: 99, note: 'x' }] }) });
  const { statement } = await runStatement(setup, sampleStatement.csv, { explain });
  assert.equal(statement.lines[2].aiNote, 'Monthly bank account fee.');
  assert.equal(statement.lines[0].aiNote, null);

  const setup2 = await demoMonth();
  const broken = await runStatement(setup2, sampleStatement.csv, { explain: async () => { throw new Error('Groq rate limit reached.'); } });
  assert.equal(broken.result.outcome, 'needs_person');
  assert.equal(setup2.ledger.payments.filter((p) => p.status === 'paid').length, 2);
});

// ---------- Month-end reporting ----------

async function runReport(setup, month, { writer = null, now = () => new Date(2026, 9, 20) } = {}) {
  const agent = createReportAgent({ ledger: setup.ledger, writer, save: async () => {}, now });
  const report = { id: 'r-1', month };
  const result = await runAgent(agent, { report });
  return { report, result };
}

test('month helpers', () => {
  assert.equal(isMonth('2026-10'), true);
  assert.equal(isMonth('2026-13'), false);
  assert.equal(isMonth('October'), false);
  // Months follow the business's time zone (Australia/Sydney by default), not the server's.
  const { start, end, label } = monthRange('2026-12', 'Australia/Sydney');
  assert.equal(label, 'December 2026');
  assert.equal(start.toISOString(), '2026-11-30T13:00:00.000Z');
  assert.equal(end.toISOString(), '2026-12-31T13:00:00.000Z');
});

test('the demo month report: figures, open items and commentary', async () => {
  const setup = await demoMonth();
  await runQuery(setup, findSampleQuery('status-approved'));
  await runQuery(setup, findSampleQuery('bank-change'));
  await runStatement(setup, sampleStatement.csv);
  const { report, result } = await runReport(setup, '2026-10');
  const f = report.figures;

  assert.equal(result.outcome, 'open_items');
  // The clean invoice was sent twice: the copy is counted once, with the original, and listed on its own.
  assert.deepEqual(f.invoices, { received: 7, valueReceived: 25711.66, clearedByAgent: 2, approvedByPerson: 2, waiting: 4, rejected: 1, cancelled: 0, failed: 0, inProgress: 0, clearedPct: 29, duplicateCopies: 1, duplicateCopiesWaiting: 1 });
  assert.deepEqual(f.payments, { approvedCount: 2, approvedValue: 2129.6, scheduledValue: 0, paidCount: 2, paidValue: 2129.6, outstandingCount: 0, outstandingValue: 0 });
  assert.deepEqual(f.queries, { received: 2, answeredByAgent: 1, answeredByPerson: 0, closedWithoutReply: 0, waiting: 1 });
  assert.deepEqual(f.bank, { statements: 1, linesMatched: 2, valueMatched: 2129.6, linesOpen: 3, linesDismissed: 0, linesRepeated: 0 });
  assert.deepEqual(f.heldReasons[0], { id: 'po_found', label: 'No matching purchase order', count: 2 });
  assert.ok(!f.heldReasons.some((r) => r.id === 'match_score'), 'a low score caused by another failure is not counted as its own reason');
  assert.equal(f.openItems.length, 7, 'four invoices, the duplicate copy, the supplier emails and the bank lines');
  assert.ok(f.openItems.includes('A second copy of invoice HOS-10482 from Harbour Office Supplies Pty Ltd ($1,402.50), received 1 Oct 2026, is a possible duplicate of an invoice that is payment completed. It needs review before it can be approved or paid.'));
  assert.deepEqual(checkFigures(f), []);
  assert.equal(report.commentary.method, 'standard');
  assert.deepEqual(ungroundedNumbers(report.commentary.text, f), []);
  assert.match(report.commentary.text, /^In October 2026, 7 invoices were received, worth \$25,711\.66 in total\./);
  assert.match(report.commentary.text, /1 possible duplicate copy of invoices already counted was received and not counted again\./);

  const csv = figuresToCsv(f);
  assert.ok(csv.startsWith('Section,Item,Value\r\nReport,Month,October 2026\r\n'));
  assert.ok(csv.includes('Payments,Paid (AUD),2129.60'));
  assert.ok(csv.includes('"Invoice HOS-10517 from Harbour Office Supplies Pty Ltd ($2,890.36) is on hold.",'));
});

test('still-to-pay is grouped by supplier before the bank statement arrives', async () => {
  const setup = await demoMonth();
  const { report } = await runReport(setup, '2026-10');
  assert.deepEqual(report.figures.outstandingBySupplier, [
    { vendorName: 'Harbour Office Supplies Pty Ltd', count: 1, value: 1402.5, earliestDue: '2026-10-14' },
    { vendorName: 'Southern Cross Pallets Pty Ltd', count: 1, value: 727.1, earliestDue: '2026-10-18' },
  ]);
  assert.equal(report.figures.payments.outstandingValue, 2129.6);
});

test('an empty month is ready to close; a future month is refused', async () => {
  const setup = await demoMonth();
  const empty = await runReport(setup, '2026-08');
  assert.equal(empty.result.outcome, 'ready');
  assert.equal(empty.report.commentary.text, 'No invoices were received in August 2026.');
  const future = await runReport(setup, '2026-11');
  assert.equal(future.result.outcome, 'failed');
  assert.match(future.report.decision.reasons[0], /November 2026 has not started yet/);
});

test('AI commentary is kept when every number is in the figures, replaced when one is not', async () => {
  const setup = await demoMonth();
  const good = await runReport(setup, '2026-10', { writer: { model: 'm', write: async () => 'In October 2026, 7 invoices were received worth $25,711.66. 4 are still waiting for a decision.' } });
  assert.equal(good.report.commentary.method, 'groq');

  const bad = await runReport(setup, '2026-10', { writer: { model: 'm', write: async () => 'In October 2026, 7 invoices were received, about $27,000 in total, up 12% on last month.' } });
  assert.equal(bad.report.commentary.method, 'standard');
  assert.match(bad.report.commentary.note, /not in the figures \(27000, 12\)/);
  assert.match(bad.report.commentary.text, /^In October 2026, 7 invoices/);

  const down = await runReport(setup, '2026-10', { writer: { model: 'm', write: async () => { throw new Error('Groq rate limit reached.'); } } });
  assert.equal(down.report.commentary.method, 'standard');
  assert.match(down.report.commentary.note, /AI writer was not available/);
  assert.equal(down.result.outcome, 'open_items');
});

test('figures that do not agree are not published', async () => {
  const setup = await demoMonth();
  setup.ledger.payments[0].status = 'cancelled'; // a scheduled invoice whose payment was cancelled behind its back
  const { report, result } = await runReport(setup, '2026-10');
  assert.equal(result.outcome, 'failed');
  assert.match(report.decision.reasons[0], /2 invoices are Payment Pending or Payment Completed, but 1 have a live payment/);
  assert.equal(templateCommentary(buildFigures({ month: '2026-08', invoices: [], payments: [], queries: [], statements: [] })), 'No invoices were received in August 2026.');
});

// ---------- Approve the received quantity only ----------

test('received quantity only: 10 of 12 pallets, GST recalculated', async () => {
  const { byId } = await demoMonth();
  const r = receivedOnly({ ...byId['quantity-variance'], approval: null });
  assert.deepEqual(
    r.lines.map((l) => [l.sku, l.qtyInvoiced, l.payQty, l.amount]),
    [
      ['PAL-STD-1200', 12, 10, 385],
      ['WRAP-500', 30, 30, 276],
    ],
  );
  assert.deepEqual([r.subtotal, r.gst, r.total, r.invoiceTotal], [661, 66.1, 727.1, 811.8]);
  assert.equal(receivedOnly(byId.clean), null, 'only offered when quantities are the problem');
  assert.equal(receivedOnly(byId['price-variance']), null);
});

test('supplier replies say when only part of an invoice was approved or paid', () => {
  const inv = { invoiceNumber: 'SCP-7731', total: 811.8, status: 'payment_pending', dueDate: '2026-10-18' };
  assert.equal(statusLine({ ...inv, payment: { status: 'queued', amount: 727.1 } }), 'Invoice SCP-7731 ($811.80): approved for $727.10, the quantity we have received, and scheduled for payment, due 18 Oct 2026.');
  assert.equal(statusLine({ ...inv, payment: { status: 'paid', amount: 727.1, paidOn: '2026-10-06' } }), 'Invoice SCP-7731 ($811.80): $727.10 paid, for the quantity we have received on 6 Oct 2026.');
  assert.equal(statusLine({ ...inv, payment: { status: 'queued', amount: 811.8 } }), 'Invoice SCP-7731 ($811.80): approved and scheduled for payment, due 18 Oct 2026.');
  // Approved but not yet scheduled: approval is not payment, and the reply says so.
  assert.equal(statusLine({ ...inv, status: 'approved', approvedAmount: 727.1, payment: null }), 'Invoice SCP-7731 ($811.80): approved for $727.10, the quantity we have received. Payment will be scheduled by the due date, 18 Oct 2026.');
});

// ---------- Month-on-month comparison ----------

test('previous month and the comparison rows', async () => {
  assert.equal(previousMonth('2026-10'), '2026-09');
  assert.equal(previousMonth('2026-01'), '2025-12');
  const setup = await demoMonth();
  // Move the duplicate invoice into September so last month has something in it.
  setup.invoices[7].createdAt = new Date(2026, 8, 20);
  const { report } = await runReport(setup, '2026-10');
  const c = report.figures.comparison;
  assert.equal(c.label, 'September 2026');
  assert.equal(c.hasData, true);
  const row = (id) => c.rows.find((r) => r.id === id);
  assert.deepEqual([row('received').current, row('received').previous, row('received').change], [7, 1, 6]);
  assert.deepEqual([row('valueReceived').current, row('valueReceived').previous, row('valueReceived').change], [25711.66, 1402.5, 24309.16]);
  assert.match(report.commentary.text, /Compared with September 2026, invoices received went from 1 to 7, value of invoices received went from \$1,402\.50 to \$25,711\.66/);
  assert.deepEqual(ungroundedNumbers(report.commentary.text, report.figures), []);
  assert.ok(figuresToCsv(report.figures).includes('Compared with September 2026,Invoices received: this month / last month / change,7 / 1 / 6'));
});

test('an empty previous month adds no comparison sentence; a fall is written without a minus sign', async () => {
  const setup = await demoMonth();
  const { report } = await runReport(setup, '2026-10');
  assert.equal(report.figures.comparison.hasData, false);
  assert.doesNotMatch(report.commentary.text, /Compared with/);
  const down = compareMonths(buildFigures({ month: '2026-11', invoices: [], payments: [], queries: [], statements: [] }), report.figures);
  assert.equal(down.rows[0].change, -7);
  assert.deepEqual(ungroundedNumbers('Invoices received fell by 7.', { comparison: down }), []);
});

// ---------- Regression: decided bank lines are not open items ----------
// A person's decision is stored on the line itself: status "dismissed" (or
// "confirmed" for a confirmed match), with a `resolution` record. This is
// exactly what services/statements.js resolveLine() saves.

const decideLine = (statement, n, action = 'dismiss') => {
  const line = statement.lines.find((l) => l.n === n);
  line.status = action === 'dismiss' ? 'dismissed' : 'confirmed';
  line.resolution = { action, decidedBy: 'sid', note: 'Reviewed', decidedAt: new Date().toISOString() };
  if (!statement.lines.some((l) => ['suggested', 'exception', 'unmatched'].includes(l.status))) statement.status = 'reconciled';
};
const bankItems = (report) => report.figures.openItems.filter((i) => /bank line/.test(i));

test('report counts only undecided bank lines, and updates as a person decides them', async () => {
  const setup = await demoMonth();
  const { statement } = await runStatement(setup, sampleStatement.csv);
  statement.source.filename = 'bank-statement-october.csv';

  let { report } = await runReport(setup, '2026-10');
  assert.equal(report.figures.bank.linesOpen, 3);
  assert.deepEqual(bankItems(report), ['3 bank lines on bank-statement-october.csv need a decision (lines 2, 3 and 4).']);

  decideLine(statement, 2);
  decideLine(statement, 3);
  ({ report } = await runReport(setup, '2026-10'));
  assert.equal(report.figures.bank.linesOpen, 1, 'the line nobody decided is still open');
  assert.equal(report.figures.bank.linesDismissed, 2);
  assert.deepEqual(bankItems(report), ['1 bank line on bank-statement-october.csv needs a decision (line 4).']);

  decideLine(statement, 4);
  ({ report } = await runReport(setup, '2026-10'));
  assert.equal(report.figures.bank.linesOpen, 0);
  assert.deepEqual(bankItems(report), []);
  assert.equal(report.status, 'open_items', 'invoices waiting for approval still keep the month open');
  assert.equal(report.figures.bank.linesMatched, 2, 'matched lines still count as matched');

  // Clear everything else that is open: the month is now ready to close.
  for (const inv of setup.invoices.filter((i) => ['under_review', 'needs_review', 'on_hold'].includes(i.status))) inv.status = 'rejected';
  const done = await runReport(setup, '2026-10');
  assert.equal(done.result.outcome, 'ready');
  assert.deepEqual(done.report.figures.openItems, []);
});

test('the same statement reconciled twice: each bank line is counted once, and a decision on either run settles it', async () => {
  const setup = await demoMonth();
  const first = (await runStatement(setup, sampleStatement.csv)).statement;
  const second = (await runStatement(setup, sampleStatement.csv)).statement;
  first.source.filename = second.source.filename = 'bank-statement-october.csv';

  let { report } = await runReport(setup, '2026-10');
  assert.equal(report.figures.bank.linesOpen, 3, 'lines 2, 3 and 4, not the 3 + 5 open entries across both runs');
  assert.equal(report.figures.bank.linesMatched, 2);
  assert.deepEqual(bankItems(report), ['3 bank lines on bank-statement-october.csv need a decision (lines 2, 3 and 4). The same statement lines were reconciled 2 times this month; each bank line is counted once.']);

  // A person decides every open line on the second run. The first run is left as it was, for the audit trail.
  for (const l of second.lines.filter((x) => ['suggested', 'exception', 'unmatched'].includes(x.status))) decideLine(second, l.n);
  ({ report } = await runReport(setup, '2026-10'));
  assert.equal(report.figures.bank.linesOpen, 0, 'the same bank lines were decided on the later run');
  assert.equal(report.figures.bank.linesMatched, 2, 'lines matched on the first run stay matched');
  assert.deepEqual(bankItems(report), []);
  assert.equal(first.lines.filter((x) => ['suggested', 'exception', 'unmatched'].includes(x.status)).length, 3, 'the first run is not rewritten');
});
