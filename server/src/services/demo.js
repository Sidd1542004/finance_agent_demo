// "Load demo month": wipes everything, runs the seven sample invoices through
// the agent (plus one sent twice), and records what people did next: two
// approvals (one for the received quantity only) with their payments scheduled
// (simulated), and one rejection. That gives
// the supplier emails, the bank statement and the month-end report something
// realistic to work on.

import { Invoice } from '../models/index.js';
import { sampleInvoices, renderInvoiceText } from '../seed/data.js';
import { resetEverything } from '../seed/seed.js';
import { processInvoice, performInvoiceAction } from './invoices.js';
import { recordAudit } from './runs.js';
import { systemActor } from '../auth/roles.js';
import { createTimeline, withTimeline } from '../clock.js';

// Internal demo actors, used only by this loader (they are not accounts and
// cannot sign in). Two people, so approving and paying stay separate.
const DEMO_APPROVER = systemActor({ id: 'demo:priya', name: 'Priya N (demo)', roles: ['approver'] });
const DEMO_PAYER = systemActor({ id: 'demo:sam', name: 'Sam K (demo)', roles: ['payer'] });

// When each step happens in the demo month (UTC, about 10:30 in Sydney), so every
// invoice's history reads in order: received the day after it was issued,
// approved and scheduled before its cheque date, rejected after it arrived.
// Only the stamps on history move (clock.js): business rules still use the real
// date, so statuses and amounts are the same as without the timeline.
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
/** "14 Sep 2026" -> the next day at 00:30 UTC. */
export function receivedAfter(invoiceDate) {
  const [d, mon, y] = String(invoiceDate).split(' ');
  return new Date(Date.UTC(Number(y), MONTHS[mon], Number(d) + 1, 0, 30)).toISOString();
}
export const DEMO_TIMELINE = Object.freeze({
  duplicateReceived: '2026-10-05T00:30:00.000Z', // HOS-10482 sent again
  approveClean: '2026-09-29T01:00:00.000Z', // HOS-10482, cheque dated 2026-10-02
  scheduleClean: '2026-09-29T03:00:00.000Z',
  approveQuantity: '2026-09-30T01:00:00.000Z', // SCP-7731, cheque dated 2026-10-03
  scheduleQuantity: '2026-09-30T03:00:00.000Z',
  rejectGst: '2026-10-05T01:00:00.000Z', // SCP-7790, received 2026-10-02
});

// `by`: the administrator who pressed Load demo month.
export async function loadDemoMonth(by = null) {
  await resetEverything();
  // Pressing the button happens now, so this entry keeps the real time.
  await recordAudit({
    subjectKind: 'system',
    subjectId: 'demo',
    actor: by?.name || 'Demo',
    ...(by?.id ? { actorId: by.id } : {}),
    action: 'demo_loaded',
    detail: 'Everything was deleted and the demo month loaded. The audit log is kept.',
  });
  const timeline = createTimeline();
  return withTimeline(timeline, () => loadSamples(timeline));
}

async function loadSamples(timeline) {
  const ids = {};
  const submit = async (sample) => {
    const invoice = await Invoice.create({ source: { kind: 'sample', sampleId: sample.id, filename: `${sample.invoiceNumber}.txt` }, rawText: renderInvoiceText(sample) });
    await processInvoice(invoice);
    return invoice._id;
  };
  // Received in the order they are processed: duplicate and quantity checks look
  // only at invoices received earlier, so that order must not change.
  let last = 0;
  for (const sample of sampleInvoices) {
    last = Math.max(new Date(receivedAfter(sample.invoiceDate)).getTime(), last + 60 * 60 * 1000);
    timeline.at(new Date(last).toISOString());
    ids[sample.id] = await submit(sample);
  }
  timeline.at(DEMO_TIMELINE.duplicateReceived);
  await submit(sampleInvoices.find((s) => s.id === 'clean')); // the same invoice again, to show duplicate detection

  // What people would do next. The agent approves nothing: every approval and
  // every scheduled payment below is a person's action (simulated, no money
  // moves). Skipped quietly if the invoice is not in a state that allows it
  // (for example because the reader failed).
  // The two payments are Cheque (paid outside the system), dated early in the
  // month, so the sample bank statement can match them as before. EFT, BPAY
  // and Card now go through the simulated bank on future business days:
  // schedule one from the invoice screen to see that flow.
  const act = async (when, sampleId, action, input, actor = DEMO_APPROVER) => {
    timeline.at(when);
    try {
      await performInvoiceAction(ids[sampleId], action, input, actor);
    } catch {
      /* not in a state that allows this action */
    }
  };
  await act(DEMO_TIMELINE.approveClean, 'clean', 'approve', { note: 'Matches PO-2041 and the delivery in full.' });
  await act(DEMO_TIMELINE.scheduleClean, 'clean', 'schedule_payment', { method: 'Cheque', scheduledFor: '2026-10-02' }, DEMO_PAYER);
  await act(DEMO_TIMELINE.approveQuantity, 'quantity-variance', 'approve_received', { note: 'Paying for the 10 pallets received. The other 2 will be paid once they arrive.' });
  await act(DEMO_TIMELINE.scheduleQuantity, 'quantity-variance', 'schedule_payment', { method: 'Cheque', scheduledFor: '2026-10-03' }, DEMO_PAYER);
  await act(DEMO_TIMELINE.rejectGst, 'gst-error', 'reject', { note: 'GST is wrong. Asked the supplier to reissue.' });

  const counts = {};
  for (const invoice of await Invoice.find().select('status').lean()) counts[invoice.status] = (counts[invoice.status] || 0) + 1;
  return { invoices: counts };
}
