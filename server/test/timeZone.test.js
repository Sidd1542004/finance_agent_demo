// The business time zone (TIME_ZONE, default Australia/Sydney) decides report
// months, "today", due dates and overdue, whatever the server's own clock says.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent } from '../src/agent/finance/invoiceAgent.js';
import { extractWithRules } from '../src/agent/finance/extract.js';
import { createReportAgent } from '../src/agent/finance/reportAgent.js';
import { monthOf, monthRange } from '../src/agent/finance/reportFigures.js';
import { todayIso, payablesSummary } from '../src/agent/finance/due.js';
import { businessTimeZone, startOfDayIn, isoDateIn, DEFAULT_TIME_ZONE } from '../src/agent/finance/timeZone.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { vendors, purchaseOrders, goodsReceipts, sampleInvoices, renderInvoiceText } from '../src/seed/data.js';

const policy = { matchThreshold: 85, missingAbn: 'review', priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };
const LATE_OCTOBER_UTC = new Date('2026-10-31T14:30:00Z'); // 1:30 am on 1 November in Sydney

function withTimeZone(tz, fn) {
  const before = process.env.TIME_ZONE;
  if (tz === undefined) delete process.env.TIME_ZONE;
  else process.env.TIME_ZONE = tz;
  const restore = () => {
    if (before === undefined) delete process.env.TIME_ZONE;
    else process.env.TIME_ZONE = before;
  };
  try {
    const out = fn();
    if (out?.then) return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

test('TIME_ZONE defaults to Australia/Sydney; an unknown zone falls back to it', () => {
  withTimeZone(undefined, () => assert.equal(businessTimeZone(), 'Australia/Sydney'));
  withTimeZone('Asia/Kolkata', () => assert.equal(businessTimeZone(), 'Asia/Kolkata'));
  withTimeZone('Mars/Olympus_Mons', () => assert.equal(businessTimeZone(), DEFAULT_TIME_ZONE));
});

test('an instant late on 31 October UTC is 1 November in Sydney', () => {
  withTimeZone('Australia/Sydney', () => {
    assert.equal(monthOf(LATE_OCTOBER_UTC), '2026-11');
    assert.equal(todayIso(LATE_OCTOBER_UTC), '2026-11-01');
    const nov = monthRange('2026-11');
    assert.ok(LATE_OCTOBER_UTC >= nov.start && LATE_OCTOBER_UTC < nov.end);
    const oct = monthRange('2026-10');
    assert.ok(!(LATE_OCTOBER_UTC >= oct.start && LATE_OCTOBER_UTC < oct.end));
  });
  withTimeZone('UTC', () => {
    assert.equal(monthOf(LATE_OCTOBER_UTC), '2026-10');
    assert.equal(todayIso(LATE_OCTOBER_UTC), '2026-10-31');
  });
});

test('month boundaries follow daylight saving', () => {
  // Sydney: AEDT (+11) until 5 April 2026, AEST (+10) until 4 October 2026, then AEDT.
  assert.equal(startOfDayIn(2026, 4, 1, 'Australia/Sydney').toISOString(), '2026-03-31T13:00:00.000Z');
  assert.equal(startOfDayIn(2026, 5, 1, 'Australia/Sydney').toISOString(), '2026-04-30T14:00:00.000Z');
  assert.equal(startOfDayIn(2026, 10, 4, 'Australia/Sydney').toISOString(), '2026-10-03T14:00:00.000Z');
  assert.equal(startOfDayIn(2026, 11, 1, 'Australia/Sydney').toISOString(), '2026-10-31T13:00:00.000Z');
  assert.equal(startOfDayIn(2026, 13, 1, 'Australia/Sydney').toISOString(), '2026-12-31T13:00:00.000Z', 'month 13 is January next year');
  assert.equal(isoDateIn('2026-10-31T12:59:59Z', 'Australia/Sydney'), '2026-10-31');
  assert.equal(isoDateIn('2026-10-31T13:00:00Z', 'Australia/Sydney'), '2026-11-01');
});

test('an invoice created at 2026-10-31T14:30:00Z is in the November report, not October', async () => {
  await withTimeZone('Australia/Sydney', async () => {
    const invoices = [];
    const ledger = createMemoryLedger({ vendors, purchaseOrders, goodsReceipts, invoices, queries: [], statements: [] });
    const agent = createInvoiceAgent({ ledger, extract: async (text) => extractWithRules(text), policy, save: async () => {}, today: () => todayIso(LATE_OCTOBER_UTC) });
    const invoice = { id: 'inv-1', createdAt: LATE_OCTOBER_UTC, source: { kind: 'sample' }, rawText: renderInvoiceText(sampleInvoices.find((s) => s.id === 'clean')), status: 'received' };
    invoices.push(invoice);
    await runAgent(agent, { invoice });

    const report = async (month) => {
      const r = { id: `r-${month}`, month };
      await runAgent(createReportAgent({ ledger, writer: null, save: async () => {}, now: () => new Date('2026-11-20T00:00:00Z') }), { report: r });
      return r.figures;
    };
    assert.equal((await report('2026-11')).invoices.received, 1);
    assert.equal((await report('2026-10')).invoices.received, 0);
  });
});

test('"today", due soon and overdue use the business date', () => {
  withTimeZone('Australia/Sydney', () => {
    const today = todayIso(LATE_OCTOBER_UTC); // 1 November in Sydney
    const rows = [
      { id: 'a', status: 'approved', extracted: { invoiceNumber: 'A', total: 100, dueDate: '2026-10-31' } },
      { id: 'b', status: 'approved', extracted: { invoiceNumber: 'B', total: 100, dueDate: '2026-11-01' } },
      { id: 'c', status: 'approved', extracted: { invoiceNumber: 'C', total: 100, dueDate: '2026-11-08' } },
    ];
    const s = payablesSummary(rows, today);
    assert.equal(s.today, '2026-11-01');
    assert.deepEqual(s.overdue.map((r) => r.id), ['a'], 'due on 31 October is overdue on 1 November in Sydney');
    assert.deepEqual(s.dueSoon.map((r) => r.id), ['b', 'c']);
  });
});
