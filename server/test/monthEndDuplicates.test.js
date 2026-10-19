// Regressions: the month-end report must count each real invoice and each real
// bank line once, even when the same invoice is submitted twice or the same
// statement is reconciled more than once. Every submission and every
// reconciliation run is still kept as its own record, for the audit trail.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractText, getDocumentProxy } from 'unpdf';
import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent } from '../src/agent/finance/invoiceAgent.js';
import { extractWithRules } from '../src/agent/finance/extract.js';
import { createReconciliationAgent } from '../src/agent/finance/reconciliationAgent.js';
import { createReportAgent } from '../src/agent/finance/reportAgent.js';
import { checkFigures, ungroundedNumbers, figuresToCsv } from '../src/agent/finance/reportFigures.js';
import { allowedActions, ActionError } from '../src/agent/finance/lifecycle.js';
import { createInvoiceActions } from '../src/services/invoiceActions.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { vendors, purchaseOrders, goodsReceipts, sampleInvoices, renderInvoiceText, sampleStatement } from '../src/seed/data.js';

const policy = { matchThreshold: 85, missingAbn: 'review', priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };
const pdfText = async (name) =>
  (await extractText(await getDocumentProxy(new Uint8Array(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))), { mergePages: true })).text;
const OPEN = ['suggested', 'exception', 'unmatched'];

function setup() {
  const invoices = [];
  const queries = [];
  const statements = [];
  const ledger = createMemoryLedger({ vendors, purchaseOrders, goodsReceipts, invoices, queries, statements });
  const agent = createInvoiceAgent({ ledger, extract: async (text) => extractWithRules(text), policy, save: async () => {}, today: () => '2026-10-12' });
  const rerun = async (id) => runAgent(agent, { invoice: invoices.find((i) => i.id === id) });
  const actions = createInvoiceActions({ store: ledger, policy, rerun });
  const submit = async (rawText) => {
    const n = invoices.length + 1;
    const invoice = { id: `inv-${n}`, createdAt: new Date(2026, 9, 1, 9, n), source: { kind: 'upload' }, rawText, status: 'received' };
    invoices.push(invoice);
    await runAgent(agent, { invoice });
    return invoice;
  };
  const act = (invoice, action, input = {}) => actions.perform(invoice.id, action, { decidedBy: 'Priya N', ...input });
  const reconcile = async (csv) => {
    const n = statements.length + 1;
    const statement = { id: `st-${n}`, createdAt: new Date(2026, 9, 7, 9, n), source: { kind: 'sample', filename: sampleStatement.filename }, rawText: csv, status: 'received' };
    statements.push(statement);
    await runAgent(createReconciliationAgent({ ledger, explain: null, save: async () => {} }), { statement });
    return statement;
  };
  const report = async () => {
    const r = { id: 'r-1', month: '2026-10' };
    const result = await runAgent(createReportAgent({ ledger, writer: null, save: async () => {}, now: () => new Date(2026, 9, 20) }), { report: r });
    return { figures: r.figures, report: r, result };
  };
  return { ledger, invoices, statements, submit, act, reconcile, report };
}

const failedIds = (invoice) => invoice.checks.filter((c) => c.status === 'fail').map((c) => c.id);
const itemsAbout = (figures, pattern) => figures.openItems.filter((i) => pattern.test(i));
const decide = (statement, n) => {
  const line = statement.lines.find((l) => l.n === n);
  Object.assign(line, { status: 'dismissed', resolution: { action: 'dismiss', decidedBy: 'Sam K', note: 'Reviewed', decidedAt: new Date().toISOString() } });
  if (!statement.lines.some((l) => OPEN.includes(l.status))) statement.status = 'reconciled';
};

// ---------- Issue 1: INV-000003 listed twice (On Hold and Needs Review) ----------

test('INV-000003 sent twice: two records are kept, the copy is blocked as a duplicate, and the report lists the invoice once', async () => {
  const { ledger, invoices, submit, act, report } = setup();

  // First copy: no PO quoted, so a person asks the supplier for a corrected invoice (On Hold).
  const first = await submit(await pdfText('INV-000003-no-po.pdf'));
  assert.equal(first.status, 'needs_review');
  await act(first, 'request_correction', { note: 'Please quote the PO.' });
  assert.equal(first.status, 'on_hold');

  // The corrected invoice arrives under the same number: a second record, flagged as a possible duplicate.
  const second = await submit(await pdfText('INV-000003-po.pdf'));
  assert.equal(invoices.length, 2, 'every submission is kept as its own record');
  assert.equal(second.status, 'needs_review');
  assert.ok(failedIds(second).includes('duplicate'));
  assert.deepEqual(
    second.match.duplicates.map((d) => d.id),
    [first.id],
  );

  // Duplicate detection and approval safety are unchanged.
  await assert.rejects(act(second, 'approve', { note: 'Approve anyway' }), ActionError);
  assert.equal(allowedActions(second, {}).find((a) => a.id === 'approve').enabled, false);
  assert.equal(ledger.payments.length, 0);

  const { figures: f, result } = await report();
  assert.equal(result.outcome, 'open_items');
  assert.equal(f.invoices.received, 1, 'one invoice, not two');
  assert.equal(f.invoices.valueReceived, 126, 'AUD 126 counted once');
  assert.equal(f.invoices.waiting, 1);
  assert.equal(f.invoices.duplicateCopies, 1);
  assert.deepEqual(checkFigures(f), []);

  const items = itemsAbout(f, /INV-000003/);
  assert.equal(items.length, 1, `listed once, not as one On Hold and one Needs Review item: ${JSON.stringify(items)}`);
  assert.match(items[0], /^Invoice INV-000003 from Australia org \(\$126\.00\) is on hold\. /);
  assert.match(items[0], /A second copy received .* is a possible duplicate and needs review before it can be approved or paid\./);
  assert.ok(figuresToCsv(f).includes('Invoices,Possible duplicate copies (not counted again),1'));
});

test('a duplicate copy of an invoice that is already approved and paid still shows as needing a decision', async () => {
  const { submit, act, report } = setup();
  const clean = sampleInvoices.find((s) => s.id === 'clean');
  const original = await submit(renderInvoiceText(clean));
  await act(original, 'approve', { note: 'Matches the PO.' });
  await act(original, 'schedule_payment', { decidedBy: 'Sam K', method: 'EFT' });
  const copy = await submit(renderInvoiceText(clean));
  assert.ok(failedIds(copy).includes('duplicate'));

  const { figures: f } = await report();
  assert.equal(f.invoices.received, 1);
  assert.equal(f.invoices.valueReceived, 1402.5);
  assert.equal(f.invoices.waiting, 0);
  assert.equal(f.payments.approvedValue, 1402.5, 'the approved amount is not doubled');
  const items = itemsAbout(f, /HOS-10482/);
  assert.equal(items.length, 1);
  assert.match(
    items[0],
    /^A second copy of invoice HOS-10482 from Harbour Office Supplies Pty Ltd \(\$1,402\.50\), received .*, is a possible duplicate of an invoice that is payment pending\. It needs review before it can be approved or paid\./,
  );
  assert.deepEqual(checkFigures(f), []);
});

test('a copy is counted on its own again once the earlier invoice is cancelled, or a person clears it as not a duplicate', async () => {
  const clean = sampleInvoices.find((s) => s.id === 'clean');

  // The earlier copy is cancelled: the later one is now the live invoice.
  const a = setup();
  const original = await a.submit(renderInvoiceText(clean));
  await a.submit(renderInvoiceText(clean));
  await a.act(original, 'cancel', { note: 'Sent twice, keeping the later one.' });
  let { figures: f } = await a.report();
  assert.equal(f.invoices.received, 2);
  assert.equal(f.invoices.cancelled, 1);
  assert.equal(f.invoices.waiting, 1);
  assert.equal(f.invoices.duplicateCopies, 0);

  // A person says the second invoice is genuinely different: both are counted.
  const b = setup();
  await b.submit(renderInvoiceText(clean));
  const copy = await b.submit(renderInvoiceText(clean).replace('HOS-10482', 'HOS-10482A'));
  if (failedIds(copy).includes('duplicate')) await b.act(copy, 'clear_duplicate', { note: 'A second, separate order.' });
  assert.ok(!failedIds(copy).includes('duplicate'));
  ({ figures: f } = await b.report());
  assert.equal(f.invoices.received, 2);
  assert.equal(f.invoices.duplicateCopies, 0);
});

// ---------- Issue 2: the same statement reconciled three times ----------

test('the same statement reconciled three times: each bank line is counted once, and every run is kept', async () => {
  const s = setup();
  for (const sample of ['clean', 'quantity-variance']) {
    const inv = await s.submit(renderInvoiceText(sampleInvoices.find((x) => x.id === sample)));
    await s.act(inv, sample === 'clean' ? 'approve' : 'approve_received', { note: 'OK' });
    await s.act(inv, 'schedule_payment', { decidedBy: 'Sam K', method: 'EFT' });
  }
  const runs = [await s.reconcile(sampleStatement.csv), await s.reconcile(sampleStatement.csv), await s.reconcile(sampleStatement.csv)];

  // What each run recorded (the history): the later runs see the lines the first run matched as already paid.
  assert.deepEqual(
    runs.map((r) => r.lines.filter((l) => OPEN.includes(l.status)).length),
    [3, 5, 5],
  );
  assert.equal(s.ledger.payments.filter((p) => p.status === 'paid').length, 2, 'the re-runs paid nothing twice');

  let { figures: f } = await s.report();
  assert.equal(f.bank.statements, 3, 'all three runs are reported');
  assert.equal(f.bank.linesOpen, 3, 'lines 2, 3 and 4 are the only bank lines still undecided (not 13)');
  assert.equal(f.bank.linesMatched, 2);
  assert.equal(f.bank.valueMatched, 2129.6, 'matched value counted once');
  assert.equal(f.bank.linesRepeated, 12, 'line entries from the repeat runs that were not counted again');
  const bank = itemsAbout(f, /bank line/);
  assert.deepEqual(bank, [
    '3 bank lines on bank-statement-october.csv need a decision (lines 2, 3 and 4). The same statement lines were reconciled 3 times this month; each bank line is counted once.',
  ]);

  // A person decides them on the latest run: nothing is open, though the earlier runs are left exactly as they were.
  for (const n of [2, 3, 4]) decide(runs[2], n);
  ({ figures: f } = await s.report());
  assert.equal(f.bank.linesOpen, 0);
  assert.equal(f.bank.linesDismissed, 3);
  assert.equal(f.bank.linesMatched, 2);
  assert.deepEqual(itemsAbout(f, /bank line/), []);
  assert.deepEqual(
    runs.map((r) => r.lines.filter((l) => OPEN.includes(l.status)).length),
    [3, 5, 2],
    'history is not rewritten',
  );
  assert.equal(s.statements.length, 3);
});

test('different statements and repeated identical lines within one statement are still counted separately', async () => {
  const s = setup();
  const twoFees = ['Date,Description,Amount', '03/10/2026,ACCOUNT KEEPING FEE,-12.50', '03/10/2026,ACCOUNT KEEPING FEE,-12.50'].join('\n');
  await s.reconcile(twoFees);
  await s.reconcile(['Date,Description,Amount', '04/10/2026,MERCHANT FEE,-3.10'].join('\n'));
  const { figures: f } = await s.report();
  assert.equal(f.bank.linesOpen, 3, 'two identical fees on one statement are two bank lines');
  assert.equal(f.bank.linesRepeated, 0);

  // Reconciling the two-fee file again does not add more.
  await s.reconcile(twoFees);
  const again = (await s.report()).figures;
  assert.equal(again.bank.linesOpen, 3);
  assert.equal(again.bank.linesRepeated, 2);
});

test('lines on a statement that could not be reconciled are not counted as matched', async () => {
  const s = setup();
  const st = await s.reconcile('Date,Description,Amount\n02/10/2026,HARBOUR OFFICE SUP HOS-10482,-1402.50');
  // A run that failed after matching (the ledger reverted the payment), but the line kept its "matched" status.
  Object.assign(st, { status: 'failed' });
  st.lines[0].status = 'matched';
  const { figures: f } = await s.report();
  assert.equal(f.bank.linesMatched, 0);
  assert.ok(f.openItems.includes('1 bank statement could not be reconciled.'));
});
